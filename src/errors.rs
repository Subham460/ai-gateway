use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIErrorDetail {
    pub message: String,
    #[serde(rename = "type")]
    pub error_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub param: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAIErrorResponse {
    pub error: OpenAIErrorDetail,
}

#[derive(Debug)]
pub enum GatewayError {
    InvalidRequest(String),
    MissingOrInvalidAuth(String),
    ModelNotFound(String),
    RateLimitExceeded {
        message: String,
        retry_after: Option<Duration>,
    },
    Timeout(String),
    BadGateway(String),
    Upstream {
        status: u16,
        message: String,
    },
    Internal(String),
}

impl GatewayError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::MissingOrInvalidAuth(_) => StatusCode::UNAUTHORIZED,
            Self::ModelNotFound(_) => StatusCode::NOT_FOUND,
            Self::RateLimitExceeded { .. } => StatusCode::TOO_MANY_REQUESTS,
            Self::Timeout(_) => StatusCode::GATEWAY_TIMEOUT,
            Self::BadGateway(_) => StatusCode::BAD_GATEWAY,
            Self::Upstream { status, .. } => StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY),
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn retry_after(&self) -> Option<Duration> {
        match self {
            Self::RateLimitExceeded { retry_after, .. } => *retry_after,
            _ => None,
        }
    }

    pub fn to_openai_error(&self) -> OpenAIErrorResponse {
        let (message, error_type, code) = match self {
            Self::InvalidRequest(msg) => (msg.clone(), "invalid_request_error".to_string(), None),
            Self::MissingOrInvalidAuth(msg) => (
                msg.clone(),
                "invalid_request_error".to_string(),
                Some("invalid_api_key".to_string()),
            ),
            Self::ModelNotFound(msg) => (
                msg.clone(),
                "invalid_request_error".to_string(),
                Some("model_not_found".to_string()),
            ),
            Self::RateLimitExceeded { message, .. } => (
                message.clone(),
                "requests".to_string(),
                Some("rate_limit_exceeded".to_string()),
            ),
            Self::Timeout(msg) => (msg.clone(), "gateway_timeout".to_string(), None),
            Self::BadGateway(msg) => {
                (msg.clone(), "api_error".to_string(), Some("upstream_unavailable".to_string()))
            }
            Self::Upstream { message, .. } => {
                (message.clone(), "api_error".to_string(), Some("upstream_error".to_string()))
            }
            Self::Internal(msg) => (msg.clone(), "api_error".to_string(), None),
        };
        OpenAIErrorResponse {
            error: OpenAIErrorDetail {
                message,
                error_type,
                param: None,
                code,
            },
        }
    }
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest(m) => write!(f, "Invalid request: {}", m),
            Self::MissingOrInvalidAuth(m) => write!(f, "Authentication error: {}", m),
            Self::ModelNotFound(m) => write!(f, "Model not found: {}", m),
            Self::RateLimitExceeded { message, .. } => write!(f, "Rate limit exceeded: {}", message),
            Self::Timeout(m) => write!(f, "Timeout: {}", m),
            Self::BadGateway(m) => write!(f, "Bad gateway: {}", m),
            Self::Upstream { status, message } => write!(f, "Upstream error {}: {}", status, message),
            Self::Internal(m) => write!(f, "Internal error: {}", m),
        }
    }
}

impl std::error::Error for GatewayError {}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let mut response = (status, Json(self.to_openai_error())).into_response();
        if let Some(retry_after) = self.retry_after() {
            let seconds = retry_after.as_secs().max(1);
            if let Ok(value) = axum::http::HeaderValue::from_str(&seconds.to_string()) {
                response.headers_mut().insert("retry-after", value);
            }
        }
        response
    }
}
