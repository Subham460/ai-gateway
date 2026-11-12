use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use std::sync::Arc;
use crate::auth::authenticate;
use crate::backend::get_available_models;
use crate::errors::GatewayError;
use crate::types::{ModelEntry, ModelListResponse};
use crate::AppState;

pub async fn list_models(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<ModelListResponse>, GatewayError> {
    authenticate(&headers, &state.config)?;
    Ok(Json(get_available_models()))
}

pub async fn get_model(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(model_id): Path<String>,
) -> Result<Json<ModelEntry>, GatewayError> {
    authenticate(&headers, &state.config)?;
    let list = get_available_models();
    let model = list
        .data
        .into_iter()
        .find(|m| m.id.eq_ignore_ascii_case(&model_id))
        .ok_or_else(|| {
            GatewayError::ModelNotFound(format!("The model '{}' does not exist", model_id))
        })?;
    Ok(Json(model))
}

