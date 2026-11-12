use axum::{extract::State, Json};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use crate::types::UsageResponse;
use crate::AppState;

pub async fn get_usage(State(state): State<Arc<AppState>>) -> Json<UsageResponse> {
    let active = state.active_requests.load(Ordering::Relaxed);
    let snapshot = state.usage.snapshot(active).await;
    Json(snapshot)
}

