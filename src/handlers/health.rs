use axum::{extract::State, Json};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use crate::backend::get_available_models;
use crate::types::HealthResponse;
use crate::AppState;

pub async fn health_check(State(state): State<Arc<AppState>>) -> Json<HealthResponse> {
    let uptime = state.start_time.elapsed().as_secs();
    let active = state.active_requests.load(Ordering::Relaxed);
    let models = get_available_models().data.into_iter().map(|m| m.id).collect();

    Json(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: uptime,
        active_requests: active,
        available_models: models,
    })
}

