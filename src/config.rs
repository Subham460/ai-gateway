use std::env;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub host: String,
    pub port: u16,
    pub api_keys: Vec<String>,
    pub require_auth: bool,
    pub rate_limit_rps: u32,
    pub rate_limit_burst: u32,
    pub max_concurrency: usize,
    pub request_timeout: Duration,
    pub stream_idle_timeout: Duration,
    pub bun_path: String,
    pub upstream_api_url: String,
    pub upstream_api_key: Option<String>,
    pub default_model: String,
    pub cooldown_default_secs: u64,
    pub cooldown_enabled: bool,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            host: "0.0.0.0".to_string(),
            port: 8080,
            api_keys: Vec::new(),
            require_auth: false,
            rate_limit_rps: 50,
            rate_limit_burst: 100,
            max_concurrency: 128,
            request_timeout: Duration::from_secs(60),
            stream_idle_timeout: Duration::from_secs(30),
            bun_path: "/tmp/opencode/bun".to_string(),
            upstream_api_url: "https://opencode.ai/inference/openai/v1/chat/completions".to_string(),
            upstream_api_key: None,
            default_model: "deepseek-v4.1-flash-free".to_string(),
            cooldown_default_secs: 60,
            cooldown_enabled: false,
        }
    }
}

impl GatewayConfig {
    pub fn from_env() -> Self {
        let host = env::var("GATEWAY_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = env::var("PORT")
            .or_else(|_| env::var("GATEWAY_PORT"))
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8080);

        let mut api_keys = Vec::new();
        for key_var in ["GATEWAY_API_KEYS", "GATEWAY_API_KEY"] {
            if let Ok(keys_str) = env::var(key_var) {
                for key in keys_str.split(',') {
                    let trimmed = key.trim();
                    if !trimmed.is_empty() && !api_keys.iter().any(|k| k == trimmed) {
                        api_keys.push(trimmed.to_string());
                    }
                }
            }
        }

        let require_auth = !api_keys.is_empty()
            || env::var("REQUIRE_AUTH")
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);

        let rate_limit_rps = env::var("RATE_LIMIT_RPS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(50);

        let rate_limit_burst = env::var("RATE_LIMIT_BURST")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100);

        let max_concurrency = env::var("MAX_CONCURRENCY")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(128);

        let request_timeout = Duration::from_secs(
            env::var("REQUEST_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(60),
        );

        let stream_idle_timeout = Duration::from_secs(
            env::var("STREAM_IDLE_TIMEOUT_SECS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
        );

        let bun_path = env::var("BUN_PATH")
            .ok()
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(find_bun);

        let upstream_api_url = env::var("OPENCODE_INFERENCE_URL")
            .unwrap_or_else(|_| "https://opencode.ai/inference/openai/v1/chat/completions".to_string());

        let upstream_api_key = env::var("OPENCODE_API_KEY")
            .or_else(|_| env::var("UPSTREAM_API_KEY"))
            .ok()
            .filter(|k| !k.trim().is_empty());

        let default_model = env::var("DEFAULT_MODEL")
            .unwrap_or_else(|_| "deepseek-v4.1-flash-free".to_string());

        let cooldown_enabled = env::var("GATEWAY_COOLDOWN_ENABLED")
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);

        let cooldown_default_secs = env::var("COOLDOWN_DEFAULT_SECS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(60);

        Self {
            host,
            port,
            api_keys,
            require_auth,
            rate_limit_rps,
            rate_limit_burst,
            max_concurrency,
            request_timeout,
            stream_idle_timeout,
            bun_path,
            upstream_api_url,
            upstream_api_key,
            default_model,
            cooldown_default_secs,
            cooldown_enabled,
        }
    }
}

/// Locate a usable Bun binary across the environments the gateway is expected
/// to run in (local dev, Docker, and Google Colab).
fn find_bun() -> String {
    let home = env::var("HOME").ok();
    let mut candidates = vec![
        "/tmp/opencode/bun".to_string(),
        "/usr/local/bin/bun".to_string(),
        "/opt/homebrew/bin/bun".to_string(),
    ];
    if let Some(home) = home {
        candidates.insert(0, format!("{home}/.bun/bin/bun"));
    }
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            return c;
        }
    }
    "bun".to_string()
}
