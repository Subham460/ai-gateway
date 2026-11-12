use crate::backend::adapter::{AdapterError, OpenCodeAdapter};
use crate::config::GatewayConfig;
use crate::errors::GatewayError;
use crate::types::{ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[derive(Debug, Clone)]
pub struct ModelCooldownInfo {
    pub model: String,
    pub in_cooldown: bool,
    pub remaining_secs: u64,
}

#[derive(Clone, Default)]
pub struct CooldownRegistry {
    cooldowns: Arc<Mutex<HashMap<String, Instant>>>,
}

impl CooldownRegistry {
    pub fn new() -> Self {
        Self {
            cooldowns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn get_remaining(&self, model: &str) -> Option<Duration> {
        let mut map = self.cooldowns.lock().unwrap();
        if let Some(until) = map.get(model) {
            let now = Instant::now();
            if *until > now {
                return Some(*until - now);
            } else {
                map.remove(model);
            }
        }
        None
    }

    pub fn set_cooldown(&self, model: &str, duration: Duration) {
        let mut map = self.cooldowns.lock().unwrap();
        let until = Instant::now() + duration;
        map.insert(model.to_string(), until);
        eprintln!(
            "[COOLDOWN LOG] Model '{}' rate limited. Cooldown active for {}s (until {:?})",
            model,
            duration.as_secs(),
            until
        );
    }

    pub fn list_status(&self, models: &[String]) -> Vec<ModelCooldownInfo> {
        let mut map = self.cooldowns.lock().unwrap();
        let now = Instant::now();
        models
            .iter()
            .map(|m| {
                if let Some(until) = map.get(m) {
                    if *until > now {
                        ModelCooldownInfo {
                            model: m.clone(),
                            in_cooldown: true,
                            remaining_secs: (*until - now).as_secs(),
                        }
                    } else {
                        map.remove(m);
                        ModelCooldownInfo {
                            model: m.clone(),
                            in_cooldown: false,
                            remaining_secs: 0,
                        }
                    }
                } else {
                    ModelCooldownInfo {
                        model: m.clone(),
                        in_cooldown: false,
                        remaining_secs: 0,
                    }
                }
            })
            .collect()
    }
}

pub struct ModelDispatcher;

impl ModelDispatcher {
    pub fn resolve_model(requested: &str, default_model: &str) -> String {
        let clean = requested
            .trim()
            .trim_start_matches("opencode/")
            .to_lowercase();

        match clean.as_str() {
            "flint-40b-free" | "flint" => "flint-40b-free".to_string(),
            "deepseek-v4.1-flash-free" | "deepseek" => "deepseek-v4.1-flash-free".to_string(),
            _ => {
                // If specific virtual aliases like gpt-4o, gpt-3.5-turbo, default:
                default_model.to_string()
            }
        }
    }

    pub async fn execute_stream(
        request: &ChatCompletionRequest,
        config: &GatewayConfig,
        cooldowns: &CooldownRegistry,
    ) -> Result<mpsc::Receiver<Result<ChatCompletionChunk, GatewayError>>, GatewayError> {
        let target_model = Self::resolve_model(&request.model, &config.default_model);

        // 1. Check if model is currently in a known cooldown period
        if let Some(remaining) = cooldowns.get_remaining(&target_model) {
            let secs = remaining.as_secs().max(1);
            return Err(GatewayError::RateLimitExceeded {
                message: format!(
                    "Model '{}' is currently in cooldown from upstream rate limit. Retry in {} seconds.",
                    target_model, secs
                ),
                retry_after: Some(remaining),
            });
        }

        // 2. Execute strictly on the requested model (NO FALLBACK)
        let rx = OpenCodeAdapter::execute_stream(request, &target_model, config)
            .await
            .map_err(|e| match e {
                AdapterError::UpstreamRateLimited { message, retry_after } => {
                    let cooldown = retry_after.unwrap_or_else(|| Duration::from_secs(config.cooldown_default_secs));
                    cooldowns.set_cooldown(&target_model, cooldown);
                    GatewayError::RateLimitExceeded {
                        message: format!("Upstream quota limit for '{}': {}", target_model, message),
                        retry_after: Some(cooldown),
                    }
                }
                AdapterError::UpstreamError(status, message) => GatewayError::Upstream { status, message },
                AdapterError::SpawnError(msg) => GatewayError::BadGateway(msg),
                AdapterError::ParseError(msg) => GatewayError::Internal(msg),
            })?;

        let (out_tx, out_rx) = mpsc::channel(100);
        let cooldowns_clone = cooldowns.clone();
        let target_model_clone = target_model.clone();
        let default_cooldown = Duration::from_secs(config.cooldown_default_secs);

        tokio::spawn(async move {
            let mut inner_rx = rx;
            while let Some(item) = inner_rx.recv().await {
                match item {
                    Ok(chunk) => {
                        if out_tx.send(Ok(chunk)).await.is_err() {
                            return;
                        }
                    }
                    Err(AdapterError::UpstreamRateLimited { message, retry_after }) => {
                        let cooldown = retry_after.unwrap_or(default_cooldown);
                        cooldowns_clone.set_cooldown(&target_model_clone, cooldown);
                        let _ = out_tx
                            .send(Err(GatewayError::RateLimitExceeded {
                                message: format!("Upstream rate limit for '{}': {}", target_model_clone, message),
                                retry_after: Some(cooldown),
                            }))
                            .await;
                        return;
                    }
                    Err(AdapterError::UpstreamError(status, message)) => {
                        let _ = out_tx.send(Err(GatewayError::Upstream { status, message })).await;
                        return;
                    }
                    Err(AdapterError::SpawnError(msg)) => {
                        let _ = out_tx.send(Err(GatewayError::BadGateway(msg))).await;
                        return;
                    }
                    Err(AdapterError::ParseError(msg)) => {
                        let _ = out_tx.send(Err(GatewayError::Internal(msg))).await;
                        return;
                    }
                }
            }
        });

        Ok(out_rx)
    }

    pub async fn execute_non_streaming(
        request: &ChatCompletionRequest,
        config: &GatewayConfig,
        cooldowns: &CooldownRegistry,
    ) -> Result<ChatCompletionResponse, GatewayError> {
        let target_model = Self::resolve_model(&request.model, &config.default_model);

        // 1. Check if model is in cooldown
        if let Some(remaining) = cooldowns.get_remaining(&target_model) {
            let secs = remaining.as_secs().max(1);
            return Err(GatewayError::RateLimitExceeded {
                message: format!(
                    "Model '{}' is in cooldown from upstream rate limit. Retry in {} seconds.",
                    target_model, secs
                ),
                retry_after: Some(remaining),
            });
        }

        // 2. Execute strictly on the requested model (NO FALLBACK)
        OpenCodeAdapter::execute_non_streaming(request, &target_model, config)
            .await
            .map_err(|e| match e {
                AdapterError::UpstreamRateLimited { message, retry_after } => {
                    let cooldown = retry_after.unwrap_or_else(|| Duration::from_secs(config.cooldown_default_secs));
                    cooldowns.set_cooldown(&target_model, cooldown);
                    GatewayError::RateLimitExceeded {
                        message: format!("Upstream quota limit for '{}': {}", target_model, message),
                        retry_after: Some(cooldown),
                    }
                }
                AdapterError::UpstreamError(status, message) => GatewayError::Upstream { status, message },
                AdapterError::SpawnError(msg) => GatewayError::BadGateway(msg),
                AdapterError::ParseError(msg) => GatewayError::Internal(msg),
            })
    }
}
