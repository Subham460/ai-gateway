use axum::{
    extract::Request,
    http::{header, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use std::sync::Arc;

use crate::errors::{OpenAIErrorDetail, OpenAIErrorResponse};
use crate::handlers::{
    chat::handle_chat_completions,
    health::health_check,
    models::{get_model, list_models},
    usage::get_usage,
};
use crate::AppState;

async fn cors_middleware(req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        return (
            StatusCode::NO_CONTENT,
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS, HEAD"),
                (
                    header::ACCESS_CONTROL_ALLOW_HEADERS,
                    "Authorization, Content-Type, Accept, api-key, x-api-key",
                ),
                (header::ACCESS_CONTROL_MAX_AGE, "86400"),
            ],
        )
            .into_response();
    }

    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS, HEAD"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Authorization, Content-Type, Accept, api-key, x-api-key"),
    );
    response
}

async fn not_found_handler() -> Response {
    let err = OpenAIErrorResponse {
        error: OpenAIErrorDetail {
            message: "Invalid URL (POST /v1/chat/completions or GET /v1/models expected)".to_string(),
            error_type: "invalid_request_error".to_string(),
            param: None,
            code: None,
        },
    };
    (StatusCode::NOT_FOUND, Json(err)).into_response()
}

pub fn create_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(health_check))
        .route("/health", get(health_check))
        .route("/v1/chat/completions", post(handle_chat_completions))
        .route("/v1/models", get(list_models))
        .route("/v1/models/:model_id", get(get_model))
        .route("/v1/usage", get(get_usage))
        .fallback(not_found_handler)
        .layer(middleware::from_fn(cors_middleware))
        .with_state(state)
}
