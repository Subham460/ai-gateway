pub mod auth;
pub mod backend;
pub mod config;
pub mod errors;
pub mod handlers;
pub mod rate_limit;
pub mod router;
pub mod types;
pub mod usage;

use std::sync::atomic::AtomicUsize;
use std::sync::Arc;
use std::time::Instant;

use backend::resilience::CooldownRegistry;
use config::GatewayConfig;
use rate_limit::RateLimiter;
use router::create_router;
use usage::UsageTracker;

pub struct AppState {
    pub config: GatewayConfig,
    pub rate_limiter: RateLimiter,
    pub usage: UsageTracker,
    pub cooldowns: CooldownRegistry,
    pub active_requests: Arc<AtomicUsize>,
    pub start_time: Instant,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = GatewayConfig::from_env();

    let rate_limiter = RateLimiter::new(
        config.rate_limit_rps,
        config.rate_limit_burst,
        config.max_concurrency,
    );

    let state = Arc::new(AppState {
        rate_limiter,
        usage: UsageTracker::new(),
        cooldowns: CooldownRegistry::new(),
        active_requests: Arc::new(AtomicUsize::new(0)),
        start_time: Instant::now(),
        config: config.clone(),
    });

    let app = create_router(state);

    let bind_addr = format!("{}:{}", config.host, config.port);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;

    println!("============================================================");
    println!("     OpenCode OpenAI-Compatible Rust AI Gateway             ");
    println!("============================================================");
    println!(" Bound Address:         http://{}", bind_addr);
    println!(" Chat Completions:      http://{}/v1/chat/completions", bind_addr);
    println!(" Model Catalog:         http://{}/v1/models", bind_addr);
    println!(" Usage Metrics:         http://{}/v1/usage", bind_addr);
    println!(" Health Check:          http://{}/health", bind_addr);
    println!(" Default Model:         {}", config.default_model);
    println!(" Mode:                  STRICT CONSISTENCY (NO MODEL FALLBACK)");
    println!(" Cooldown Tracking:     ACTIVE (honors 429 Retry-After per model)");
    println!(" Bun Bridge Path:       {}", config.bun_path);
    println!(" Require Auth:          {}", config.require_auth);
    println!(" Rate Limit (RPS/Burst):{}/{}", config.rate_limit_rps, config.rate_limit_burst);
    println!(" Concurrency Cap:       {}", config.max_concurrency);
    println!("============================================================");
    println!(" Quickstart (Python OpenAI SDK):");
    println!("   from openai import OpenAI");
    println!("   client = OpenAI(base_url='http://{}/v1', api_key='sk-any')", bind_addr);
    println!("   res = client.chat.completions.create(model='deepseek-v4.1-flash-free', messages=[{{'role': 'user', 'content': 'Hi'}}])");
    println!("============================================================");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    println!("AI Gateway shutdown completed cleanly.");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
