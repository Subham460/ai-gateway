use crate::config::GatewayConfig;
use crate::types::{
    ChatChoice, ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse,
    ChatResponseMessage, UsageInfo,
};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone)]
pub enum AdapterError {
    UpstreamRateLimited {
        message: String,
        retry_after: Option<Duration>,
    },
    UpstreamError(u16, String),
    SpawnError(String),
    ParseError(String),
}

pub struct OpenCodeAdapter;

impl OpenCodeAdapter {
    pub async fn execute_stream(
        request: &ChatCompletionRequest,
        target_model: &str,
        config: &GatewayConfig,
    ) -> Result<tokio::sync::mpsc::Receiver<Result<ChatCompletionChunk, AdapterError>>, AdapterError> {
        let bridge_script = locate_bridge_script();

        let mut cmd = Command::new(&config.bun_path);
        cmd.arg("run")
            .arg(bridge_script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| AdapterError::SpawnError(format!("Failed to spawn bun bridge at '{}': {}", config.bun_path, e)))?;

        let mut stdin = child.stdin.take().ok_or_else(|| {
            AdapterError::SpawnError("Failed to open stdin for bun bridge".to_string())
        })?;

        let stdout = child.stdout.take().ok_or_else(|| {
            AdapterError::SpawnError("Failed to open stdout for bun bridge".to_string())
        })?;

        let max_tokens = request.max_tokens_limit().unwrap_or(32000);

        let payload = serde_json::json!({
            "url": config.upstream_api_url,
            "model": target_model,
            "apiKey": config.upstream_api_key.as_deref().unwrap_or("public"),
            "messages": request.messages,
            "max_tokens": max_tokens,
        });

        let payload_str = payload.to_string();

        tokio::spawn(async move {
            let _ = stdin.write_all(payload_str.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });

        let (tx, rx) = tokio::sync::mpsc::channel(100);

        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout).lines();
            let mut error_detected: Option<AdapterError> = None;

            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                if let Some(stripped) = trimmed.strip_prefix("EVENT:ERROR:") {
                    if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(stripped) {
                        let status = err_json.get("status").and_then(|s| s.as_u64()).unwrap_or(500) as u16;
                        let body = err_json.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string();
                        let retry_after_secs = err_json.get("retryAfter")
                            .and_then(|r| r.as_str())
                            .and_then(|s| s.parse::<u64>().ok());

                        let retry_duration = retry_after_secs.map(Duration::from_secs);

                        if status == 429 || body.contains("FreeUsageLimitError") || body.contains("Free usage limit reached") {
                            error_detected = Some(AdapterError::UpstreamRateLimited {
                                message: body,
                                retry_after: retry_duration,
                            });
                        } else {
                            error_detected = Some(AdapterError::UpstreamError(status, body));
                        }
                    } else {
                        error_detected = Some(AdapterError::UpstreamError(500, stripped.to_string()));
                    }
                    break;
                }

                if let Some(data_str) = trimmed.strip_prefix("data: ") {
                    if data_str == "[DONE]" {
                        break;
                    }

                    if let Ok(chunk) = serde_json::from_str::<ChatCompletionChunk>(data_str)
                        && tx.send(Ok(chunk)).await.is_err()
                    {
                        break;
                    }
                }
            }

            if let Some(err) = error_detected {
                let _ = tx.send(Err(err)).await;
            }

            let _ = child.wait().await;
        });

        Ok(rx)
    }

    pub async fn execute_non_streaming(
        request: &ChatCompletionRequest,
        target_model: &str,
        config: &GatewayConfig,
    ) -> Result<ChatCompletionResponse, AdapterError> {
        let mut rx = Self::execute_stream(request, target_model, config).await?;

        let mut full_text = String::new();
        let mut last_chunk: Option<ChatCompletionChunk> = None;
        let mut total_usage: Option<UsageInfo> = None;

        while let Some(item) = rx.recv().await {
            match item {
                Ok(chunk) => {
                    if let Some(choice) = chunk.choices.first()
                        && let Some(content) = &choice.delta.content
                    {
                        full_text.push_str(content);
                    }
                    if let Some(usage) = chunk.usage.clone() {
                        total_usage = Some(usage);
                    }
                    last_chunk = Some(chunk);
                }
                Err(e) => return Err(e),
            }
        }

        let chunk = last_chunk.ok_or_else(|| {
            AdapterError::ParseError("No response chunks received from upstream adapter".to_string())
        })?;

        let usage = total_usage.unwrap_or_else(|| {
            let prompt_tokens = request
                .messages
                .iter()
                .map(|m| crate::usage::UsageTracker::estimate_tokens(&m.content_as_str()))
                .sum();
            let completion_tokens = crate::usage::UsageTracker::estimate_tokens(&full_text);
            UsageInfo {
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
            }
        });

        Ok(ChatCompletionResponse {
            id: chunk.id,
            object: "chat.completion".to_string(),
            created: chunk.created,
            model: request.model.clone(),
            choices: vec![ChatChoice {
                index: 0,
                message: ChatResponseMessage {
                    role: "assistant".to_string(),
                    content: full_text,
                    tool_calls: None,
                },
                finish_reason: "stop".to_string(),
            }],
            usage,
        })
    }
}

/// Locate the Bun sidecar bridge script at runtime.
///
/// The original code baked in the build-machine absolute path (via
/// `CARGO_MANIFEST_DIR`), which breaks when the prebuilt binary is moved to
/// another machine (e.g. Google Colab). We now resolve the script in order:
///   1. `GATEWAY_BRIDGE_PATH` env var (explicit override)
///   2. Next to the running executable: `sidecar/opencode_bridge.js`, then
///      `opencode_bridge.js`
///   3. The original compile-time path as a last resort.
fn locate_bridge_script() -> String {
    if let Ok(path) = std::env::var("GATEWAY_BRIDGE_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return path.to_string();
        }
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidates = [
                dir.join("sidecar").join("opencode_bridge.js"),
                dir.join("opencode_bridge.js"),
            ];
            for candidate in candidates {
                if candidate.exists() {
                    return candidate.to_string_lossy().into_owned();
                }
            }
        }
    }

    concat!(env!("CARGO_MANIFEST_DIR"), "/src/sidecar/opencode_bridge.js").to_string()
}
