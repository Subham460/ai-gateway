use axum::{
    extract::State,
    http::HeaderMap,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    Json,
};
use futures_util::stream::unfold;
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use crate::auth::authenticate;
use crate::backend::resilience::ModelDispatcher;
use crate::errors::GatewayError;
use crate::types::{ChatCompletionChunk, ChatCompletionRequest, UsageInfo};
use crate::usage::UsageTracker;
use crate::AppState;

struct StreamState {
    rx: tokio::sync::mpsc::Receiver<Result<ChatCompletionChunk, GatewayError>>,
    done_sent: bool,
    accumulated_tokens: u32,
    prompt_tokens: u32,
    model_name: String,
    usage_tracker: UsageTracker,
    timeout_duration: Duration,
}

pub async fn handle_chat_completions(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(payload): Json<ChatCompletionRequest>,
) -> Result<Response, GatewayError> {
    // 1. Authenticate
    let auth = authenticate(&headers, &state.config)?;

    // 2. Validate request
    if payload.messages.is_empty() {
        state.usage.record_error();
        return Err(GatewayError::InvalidRequest(
            "messages is a required field and cannot be empty".to_string(),
        ));
    }

    for (idx, msg) in payload.messages.iter().enumerate() {
        let role = msg.role.to_lowercase();
        if !matches!(role.as_str(), "system" | "user" | "assistant" | "tool" | "function") {
            state.usage.record_error();
            return Err(GatewayError::InvalidRequest(format!(
                "Invalid role '{}' at messages[{}]. Valid roles are 'system', 'user', 'assistant', 'tool'.",
                msg.role, idx
            )));
        }
    }

    // 3. Check rate limits
    state.rate_limiter.check_rate_limit(&auth.api_key).await?;

    // 4. Acquire concurrency permit
    let _permit = state.rate_limiter.acquire_permit().await?;

    // Track active request count
    state.active_requests.fetch_add(1, Ordering::Relaxed);
    let active_counter = state.active_requests.clone();

    struct ActiveGuard(Arc<std::sync::atomic::AtomicUsize>);
    impl Drop for ActiveGuard {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::Relaxed);
        }
    }
    let _active_guard = ActiveGuard(active_counter);

    let is_streaming = payload.is_streaming();
    let model_name = payload.model.clone();

    if is_streaming {
        let usage_tracker = state.usage.clone();
        let timeout_duration = state.config.request_timeout;

        // Execute strictly on requested model (NO FALLBACK)
        let rx = ModelDispatcher::execute_stream(&payload, &state.config, &state.cooldowns).await?;

        let mut prompt_tokens_count = 0u32;
        for m in &payload.messages {
            prompt_tokens_count += UsageTracker::estimate_tokens(&m.content_as_str());
        }

        let initial_state = StreamState {
            rx,
            done_sent: false,
            accumulated_tokens: 0,
            prompt_tokens: prompt_tokens_count,
            model_name: model_name.clone(),
            usage_tracker,
            timeout_duration,
        };

        let stream = unfold(initial_state, |mut s| async move {
            if s.done_sent {
                return None;
            }

            match tokio::time::timeout(s.timeout_duration, s.rx.recv()).await {
                Ok(Some(Ok(chunk))) => {
                    if let Some(choice) = chunk.choices.first()
                        && let Some(content) = &choice.delta.content
                    {
                        s.accumulated_tokens += UsageTracker::estimate_tokens(content);
                    }
                    let json_str = serde_json::to_string(&chunk).unwrap_or_default();
                    let event = Event::default().data(json_str);
                    Some((Ok::<Event, Infallible>(event), s))
                }
                Ok(Some(Err(err))) => {
                    // Upstream error or rate limit during stream
                    s.done_sent = true;
                    let err_json = serde_json::to_string(&err.to_openai_error()).unwrap_or_default();
                    let event = Event::default().data(err_json);
                    Some((Ok::<Event, Infallible>(event), s))
                }
                _ => {
                    // Send final [DONE] marker and record usage
                    s.done_sent = true;
                    s.usage_tracker.record_request(&s.model_name, &UsageInfo {
                        prompt_tokens: s.prompt_tokens,
                        completion_tokens: s.accumulated_tokens.max(1),
                        total_tokens: s.prompt_tokens + s.accumulated_tokens.max(1),
                    }).await;

                    let done_event = Event::default().data("[DONE]");
                    Some((Ok::<Event, Infallible>(done_event), s))
                }
            }
        });

        Ok(Sse::new(stream)
            .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)).text(": heartbeat"))
            .into_response())
    } else {
        let timeout_duration = state.config.request_timeout;

        // Execute strictly on requested model (NO FALLBACK)
        let response = tokio::time::timeout(
            timeout_duration,
            ModelDispatcher::execute_non_streaming(&payload, &state.config, &state.cooldowns),
        )
        .await
        .map_err(|_| GatewayError::Timeout(format!(
            "Request timed out after {} seconds",
            state.config.request_timeout.as_secs()
        )))??;

        state.usage.record_request(&model_name, &response.usage).await;

        Ok(Json(response).into_response())
    }
}
