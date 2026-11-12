pub mod adapter;
pub mod mock;
pub mod resilience;

use crate::types::{ModelEntry, ModelListResponse};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn get_available_models() -> ModelListResponse {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let models = vec![
        ModelEntry {
            id: "deepseek-v4.1-flash-free".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "opencode".to_string(),
        },
        ModelEntry {
            id: "flint-40b-free".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "opencode".to_string(),
        },
        ModelEntry {
            id: "opencode/deepseek-v4.1-flash-free".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "opencode".to_string(),
        },
        ModelEntry {
            id: "opencode/flint-40b-free".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "opencode".to_string(),
        },
        ModelEntry {
            id: "gpt-4o".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "gateway".to_string(),
        },
        ModelEntry {
            id: "gpt-4".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "gateway".to_string(),
        },
        ModelEntry {
            id: "gpt-3.5-turbo".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "gateway".to_string(),
        },
        ModelEntry {
            id: "deepseek-chat".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "gateway".to_string(),
        },
        ModelEntry {
            id: "auto".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "gateway".to_string(),
        },
        ModelEntry {
            id: "default".to_string(),
            object: "model".to_string(),
            created: now,
            owned_by: "gateway".to_string(),
        },
    ];

    ModelListResponse {
        object: "list".to_string(),
        data: models,
    }
}

