use axum::http::HeaderMap;
use crate::config::GatewayConfig;
use crate::errors::GatewayError;

pub struct AuthContext {
    pub api_key: String,
}

pub fn authenticate(headers: &HeaderMap, config: &GatewayConfig) -> Result<AuthContext, GatewayError> {
    let auth_header = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .or_else(|| headers.get("api-key").and_then(|h| h.to_str().ok()))
        .or_else(|| headers.get("x-api-key").and_then(|h| h.to_str().ok()));

    let extracted_key = if let Some(header_val) = auth_header {
        if header_val.starts_with("Bearer ") || header_val.starts_with("bearer ") {
            header_val[7..].trim().to_string()
        } else {
            header_val.trim().to_string()
        }
    } else {
        String::new()
    };

    if config.require_auth {
        if extracted_key.is_empty() {
            return Err(GatewayError::MissingOrInvalidAuth(
                "You didn't provide an API key. You need to provide your API key in an Authorization header using Bearer auth (i.e. Authorization: Bearer YOUR_KEY)."
                    .to_string(),
            ));
        }

        if !config.api_keys.is_empty() && !config.api_keys.contains(&extracted_key) {
            return Err(GatewayError::MissingOrInvalidAuth(
                format!("Incorrect API key provided: '{}'.", extracted_key),
            ));
        }
    }

    let key_to_record = if extracted_key.is_empty() {
        "anonymous".to_string()
    } else {
        extracted_key
    };

    Ok(AuthContext {
        api_key: key_to_record,
    })
}

