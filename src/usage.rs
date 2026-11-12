use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::RwLock;
use crate::types::{ModelUsageStats, UsageInfo, UsageResponse};

#[derive(Default)]
struct InnerUsage {
    models: HashMap<String, ModelUsageStats>,
}

#[derive(Clone)]
pub struct UsageTracker {
    total_requests: Arc<AtomicU64>,
    total_prompt_tokens: Arc<AtomicU64>,
    total_completion_tokens: Arc<AtomicU64>,
    total_tokens: Arc<AtomicU64>,
    total_errors: Arc<AtomicU64>,
    inner: Arc<RwLock<InnerUsage>>,
}

impl Default for UsageTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageTracker {
    pub fn new() -> Self {
        Self {
            total_requests: Arc::new(AtomicU64::new(0)),
            total_prompt_tokens: Arc::new(AtomicU64::new(0)),
            total_completion_tokens: Arc::new(AtomicU64::new(0)),
            total_tokens: Arc::new(AtomicU64::new(0)),
            total_errors: Arc::new(AtomicU64::new(0)),
            inner: Arc::new(RwLock::new(InnerUsage::default())),
        }
    }

    pub async fn record_request(&self, model: &str, usage: &UsageInfo) {
        self.total_requests.fetch_add(1, Ordering::Relaxed);
        self.total_prompt_tokens.fetch_add(usage.prompt_tokens as u64, Ordering::Relaxed);
        self.total_completion_tokens.fetch_add(usage.completion_tokens as u64, Ordering::Relaxed);
        self.total_tokens.fetch_add(usage.total_tokens as u64, Ordering::Relaxed);

        let mut inner = self.inner.write().await;
        let stats = inner.models.entry(model.to_string()).or_insert(ModelUsageStats {
            requests: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        });

        stats.requests += 1;
        stats.prompt_tokens += usage.prompt_tokens as u64;
        stats.completion_tokens += usage.completion_tokens as u64;
        stats.total_tokens += usage.total_tokens as u64;
    }

    pub fn record_error(&self) {
        self.total_errors.fetch_add(1, Ordering::Relaxed);
    }

    pub async fn snapshot(&self, active_requests: usize) -> UsageResponse {
        let inner = self.inner.read().await;
        UsageResponse {
            total_requests: self.total_requests.load(Ordering::Relaxed),
            total_prompt_tokens: self.total_prompt_tokens.load(Ordering::Relaxed),
            total_completion_tokens: self.total_completion_tokens.load(Ordering::Relaxed),
            total_tokens: self.total_tokens.load(Ordering::Relaxed),
            total_errors: self.total_errors.load(Ordering::Relaxed),
            active_requests,
            models: inner.models.clone(),
        }
    }

    pub fn estimate_tokens(text: &str) -> u32 {
        if text.is_empty() {
            return 0;
        }
        // General OpenAI cl100k approximation: ~4 chars per token, with min 1 token per word
        let chars = text.chars().count();
        let words = text.split_whitespace().count();
        let by_chars = chars.div_ceil(4);
        by_chars.max(words) as u32
    }
}
