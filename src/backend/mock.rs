use crate::types::{
    ChatChoice, ChatCompletionChunk, ChatCompletionRequest, ChatCompletionResponse,
    ChatResponseMessage, ChunkChoice, ChunkDelta, UsageInfo,
};
use crate::usage::UsageTracker;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct LocalEngine;

impl LocalEngine {
    pub fn generate_response_text(request: &ChatCompletionRequest) -> String {
        let last_user_msg = request
            .messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content_as_str())
            .unwrap_or_default();

        let lower = last_user_msg.to_lowercase();

        if lower.contains("ping") {
            "pong".to_string()
        } else if lower.contains("hello") || lower.contains("hi") || lower.starts_with("hey") {
            "Hello! I am your AI assistant running through the AI Gateway. How can I help you with your coding or project today?".to_string()
        } else if lower.contains("write a") || lower.contains("create a") || lower.contains("function") || lower.contains("code") {
            format!(
                "Here is an implementation based on your request:\n\n```python\ndef solution():\n    \"\"\"\n    Implementation for: {}\n    \"\"\"\n    result = []\n    return result\n\nif __name__ == '__main__':\n    print(solution())\n```\n\nLet me know if you need any adjustments or test cases!",
                last_user_msg.trim()
            )
        } else if lower.contains("explain") || lower.contains("what is") || lower.contains("how to") {
            format!(
                "Here is a clear explanation regarding your inquiry:\n\n1. **Core Concept**: {}\n2. **Key Considerations**: Architecture, performance, scalability, and clean error handling.\n3. **Practical Application**: Ensuring consistent inference and robust routing.\n\nFeel free to ask follow-up questions!",
                last_user_msg.trim()
            )
        } else {
            format!(
                "I have processed your request: \"{}\".\n\nEverything is operational through the AI Gateway. Let me know how else I can assist you!",
                last_user_msg.trim()
            )
        }
    }

    pub fn generate_completion(
        request: &ChatCompletionRequest,
        model_name: &str,
    ) -> ChatCompletionResponse {
        let text = Self::generate_response_text(request);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let prompt_tokens = request
            .messages
            .iter()
            .map(|m| UsageTracker::estimate_tokens(&m.content_as_str()))
            .sum();

        let completion_tokens = UsageTracker::estimate_tokens(&text);

        ChatCompletionResponse {
            id: format!("chatcmpl-{}", now),
            object: "chat.completion".to_string(),
            created: now,
            model: model_name.to_string(),
            choices: vec![ChatChoice {
                index: 0,
                message: ChatResponseMessage {
                    role: "assistant".to_string(),
                    content: text,
                    tool_calls: None,
                },
                finish_reason: "stop".to_string(),
            }],
            usage: UsageInfo {
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
            },
        }
    }

    pub fn generate_chunks(
        request: &ChatCompletionRequest,
        model_name: &str,
    ) -> Vec<ChatCompletionChunk> {
        let text = Self::generate_response_text(request);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();

        let id = format!("chatcmpl-{}", now);
        let mut chunks = Vec::new();

        // 1. Initial role chunk
        chunks.push(ChatCompletionChunk {
            id: id.clone(),
            object: "chat.completion.chunk".to_string(),
            created: now,
            model: model_name.to_string(),
            choices: vec![ChunkChoice {
                index: 0,
                delta: ChunkDelta {
                    role: Some("assistant".to_string()),
                    content: Some("".to_string()),
                    tool_calls: None,
                },
                finish_reason: None,
            }],
            usage: None,
        });

        // 2. Word/token chunks
        let words: Vec<&str> = text.split_inclusive(' ').collect();
        for word in words {
            chunks.push(ChatCompletionChunk {
                id: id.clone(),
                object: "chat.completion.chunk".to_string(),
                created: now,
                model: model_name.to_string(),
                choices: vec![ChunkChoice {
                    index: 0,
                    delta: ChunkDelta {
                        role: None,
                        content: Some(word.to_string()),
                        tool_calls: None,
                    },
                    finish_reason: None,
                }],
                usage: None,
            });
        }

        let prompt_tokens = request
            .messages
            .iter()
            .map(|m| UsageTracker::estimate_tokens(&m.content_as_str()))
            .sum();
        let completion_tokens = UsageTracker::estimate_tokens(&text);

        let include_usage = request
            .stream_options
            .as_ref()
            .and_then(|o| o.include_usage)
            .unwrap_or(false);

        // 3. Final chunk with finish_reason: "stop"
        chunks.push(ChatCompletionChunk {
            id: id.clone(),
            object: "chat.completion.chunk".to_string(),
            created: now,
            model: model_name.to_string(),
            choices: vec![ChunkChoice {
                index: 0,
                delta: ChunkDelta {
                    role: None,
                    content: None,
                    tool_calls: None,
                },
                finish_reason: Some("stop".to_string()),
            }],
            usage: if include_usage {
                Some(UsageInfo {
                    prompt_tokens,
                    completion_tokens,
                    total_tokens: prompt_tokens + completion_tokens,
                })
            } else {
                None
            },
        });

        chunks
    }
}
