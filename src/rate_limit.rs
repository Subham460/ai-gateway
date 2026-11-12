use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Semaphore};
use crate::errors::GatewayError;

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    last_update: Instant,
}

#[derive(Clone)]
pub struct RateLimiter {
    rps: f64,
    burst: f64,
    buckets: Arc<Mutex<HashMap<String, Bucket>>>,
    concurrency_semaphore: Arc<Semaphore>,
}

impl RateLimiter {
    pub fn new(rps: u32, burst: u32, max_concurrency: usize) -> Self {
        Self {
            rps: rps as f64,
            burst: burst as f64,
            buckets: Arc::new(Mutex::new(HashMap::new())),
            concurrency_semaphore: Arc::new(Semaphore::new(max_concurrency)),
        }
    }

    pub async fn check_rate_limit(&self, client_id: &str) -> Result<(), GatewayError> {
        let mut buckets = self.buckets.lock().await;
        let now = Instant::now();

        let bucket = buckets.entry(client_id.to_string()).or_insert_with(|| Bucket {
            tokens: self.burst,
            last_update: now,
        });

        let elapsed = now.duration_since(bucket.last_update).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.rps).min(self.burst);
        bucket.last_update = now;

        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err(GatewayError::RateLimitExceeded {
                message: format!("Rate limit reached for client '{}'. Please slow down your requests.", client_id),
                retry_after: Some(Duration::from_secs(1)),
            })
        }
    }

    pub async fn acquire_permit(&self) -> Result<tokio::sync::OwnedSemaphorePermit, GatewayError> {
        self.concurrency_semaphore.clone().try_acquire_owned().map_err(|_| {
            GatewayError::RateLimitExceeded {
                message: "Gateway concurrency limit reached. Please retry in a moment.".to_string(),
                retry_after: Some(Duration::from_secs(1)),
            }
        })
    }
}
