# OpenCode OpenAI-Compatible Rust AI Gateway (Strict Consistency Mode)

A high-performance, user-facing AI Gateway written in Rust that exposes a 100% OpenAI-compatible REST API (`/v1/chat/completions`, `/v1/models`, streaming SSE, authentication, rate limiting, and usage tracking).

It routes requests directly to the requested OpenCode free model (`deepseek-v4.1-flash-free` or `flint-40b-free`) with **Strict Model Consistency and NO FALLBACK**.

---

## Key Features

- **Strict Model Consistency (No Fallback)**:
  - If you request `deepseek-v4.1-flash-free`, your request is routed **strictly and exclusively** to DeepSeek.
  - No model swapping (no switching to Flint).
  - No mock or synthetic generator fallback.
- **OpenCode Free-Tier Supported Access**:
  - Leverages OpenCode's bundled **Bun runtime bridge** (`src/sidecar/opencode_bridge.js`) to satisfy **Gate 1** (TLS ClientHello JA3/JA4 fingerprint allowlist).
  - Envelopes requests with the canonical harness system prompt and canonical `read` tool schema to satisfy **Gate 2** (request-shape attestation).
- **Upstream Cooldown Registry & State Tracking**:
  - Automatically captures upstream `Retry-After` headers and `429 Too Many Requests` responses.
  - Logs the active cooldown window per model:
    `[COOLDOWN LOG] Model 'deepseek-v4.1-flash-free' rate limited. Cooldown active for 60s`
  - Rejects subsequent requests during the cooldown window with a clean OpenAI-compliant `429 rate_limit_exceeded` error and accurate `Retry-After` header.
  - Once the cooldown timer expires, the model is automatically available for reuse!
- **OpenAI-Compatible REST API**:
  - `POST /v1/chat/completions` supporting both JSON and streaming Server-Sent Events (`text/event-stream`).
  - `GET /v1/models` and `GET /v1/models/{model_id}`.
  - Standard OpenAI error format (`{"error": {"message": ..., "type": ..., "code": ...}}`).
- **Traffic Control & Observability**:
  - In-memory token-bucket rate limiter per API key / client IP.
  - Concurrency limiting via Tokio semaphores.
  - Real-time token usage tracking (`/v1/usage`) and health checks (`/health`).

---

## Architecture

```mermaid
flowchart TD
    Client["OpenAI SDK (Python / TS / cURL)"] -->|"POST /v1/chat/completions (model='deepseek-v4.1-flash-free')"| Gateway["Rust AI Gateway (Axum Engine)"]
    
    subgraph Rust Gateway ["crates/ai-gateway"]
        Auth["Auth & Validation"]
        Rate["Token Bucket Limiter"]
        Cooldown["Cooldown Registry\n(Tracks model lockout windows)"]
        Dispatcher["Strict Model Dispatcher\n(NO MODEL FALLBACK)"]
    end

    Gateway --> Auth
    Auth --> Rate
    Rate --> Cooldown
    Cooldown -->|"In Cooldown? -> 429 with Retry-After"| Client
    Cooldown -->|"Available"| Dispatcher

    subgraph Supported Access
        BunBridge["Bun Sidecar Bridge\n(Bun TLS + Canonical Envelope)"]
        LiveFree["OpenCode Inference Endpoint\ndeepseek-v4.1-flash-free"]
    end

    Dispatcher -->|"Strict Route"| BunBridge
    BunBridge -->|"200 OK Stream"| LiveFree
    LiveFree -->>|"Stream Chunks"| Client
    LiveFree -.->|"429 Rate Limit"| BunBridge
    BunBridge -.->|"Set Cooldown & Return 429"| Cooldown
    Cooldown -.->|"429 rate_limit_exceeded"| Client
```

---

## Quickstart

### 1. Build and Run

```bash
# Debug build (fast compile)
cargo run --manifest-path crates/ai-gateway/Cargo.toml

# Or release build (optimized 3.2MB binary)
cargo build --release --manifest-path crates/ai-gateway/Cargo.toml
./crates/ai-gateway/target/release/opencode-ai-gateway
```

The gateway starts on port `8080` by default (configurable via `PORT` or `GATEWAY_PORT`).

---

### 1b. Running on Google Colab

The prebuilt binary is portable (Linux x86-64, glibc only). Two things are
required at runtime and are resolved automatically:

1. **Bun** — install it in Colab, it gets auto-detected at `~/.bun/bin/bun`:
   ```bash
   !curl -fsSL https://bun.sh/install | bash
   ```
2. **No bridge file needed** — `opencode_bridge.js` is now **embedded** in the
   binary and materialized on demand, so the gateway is fully self-contained.
   An external script is only used if present (via `GATEWAY_BRIDGE_PATH` or
   placed next to the executable).

Minimal Colab run:

```python
import os, subprocess, time
os.environ["BUN_PATH"] = f"{os.path.expanduser('~')}/.bun/bin/bun"
os.environ["PORT"] = "18080"   # avoid Colab's busy 8080
proc = subprocess.Popen(["/content/opencode-ai-gateway"], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(2)
!curl -s http://localhost:18080/health
```

To reach it from your laptop, expose it with a tunnel (`ngrok` or
`cloudflared`).

---

### 2. Connect using Python OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8080/v1",
    api_key="sk-any-key"
)

# 1. Non-streaming Chat Completion (Strict DeepSeek)
try:
    response = client.chat.completions.create(
        model="deepseek-v4.1-flash-free",
        messages=[
            {"role": "user", "content": "Write a Python function to compute Fibonacci numbers."}
        ]
    )
    print("Response:", response.choices[0].message.content)
except Exception as e:
    # If upstream hits a rate limit, you receive a standard OpenAI 429 RateLimitError
    print("Rate limit or upstream error:", e)

# 2. Streaming Chat Completion
stream = client.chat.completions.create(
    model="deepseek-v4.1-flash-free",
    messages=[{"role": "user", "content": "Explain AI gateways."}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
print()
```

---

### 3. Upstream Rate Limit & Cooldown Behavior

When OpenCode's free tier quota is reached:
1. The gateway intercepts the upstream `429` with `Retry-After`.
2. It logs the cooldown in the gateway terminal:
   `[COOLDOWN LOG] Model 'deepseek-v4.1-flash-free' rate limited. Cooldown active for 60s (until Instant { ... })`
3. It returns an official OpenAI-standard `429 Too Many Requests` error:
   ```json
   {
     "error": {
       "message": "Upstream quota limit for 'deepseek-v4.1-flash-free': Free usage limit reached...",
       "type": "requests",
       "param": null,
       "code": "rate_limit_exceeded"
     }
   }
   ```
   with header `Retry-After: 60`.
4. During that 60-second window, any client calling `deepseek-v4.1-flash-free` receives `429` immediately without wasting network calls.
5. Once the 60 seconds expire, the gateway automatically reuses DeepSeek!

---

## Configuration Reference

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` / `GATEWAY_PORT` | `8080` | Port the gateway listens on |
| `GATEWAY_HOST` | `0.0.0.0` | Bind address |
| `GATEWAY_API_KEYS` | (empty) | Comma-separated list of valid API keys. If empty, allows any key |
| `REQUIRE_AUTH` | `false` | When true, rejects requests without a valid Bearer key |
| `RATE_LIMIT_RPS` | `50` | Allowed requests per second per client key/IP |
| `RATE_LIMIT_BURST` | `100` | Burst request capacity |
| `MAX_CONCURRENCY` | `128` | Maximum concurrent upstream requests |
| `REQUEST_TIMEOUT_SECS` | `60` | Overall request timeout |
| `DEFAULT_MODEL` | `deepseek-v4.1-flash-free` | Default model when not specified |
| `COOLDOWN_DEFAULT_SECS` | `60` | Default cooldown duration when upstream omits Retry-After |
| `BUN_PATH` | auto (searches paths) | Path to Bun binary for the sidecar bridge. Auto-detected across `~/.bun/bin/bun`, `/tmp/opencode/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun` |
| `GATEWAY_BRIDGE_PATH` | auto (embedded) | Path to an external `opencode_bridge.js` override. If unset, the embedded copy is used (next-to-executable and baked-in paths are also searched first) |
| `OPENCODE_INFERENCE_URL` | `https://opencode.ai/...` | Upstream OpenCode inference endpoint |
| `OPENCODE_API_KEY` | (empty) | Optional upstream key (defaults to `"public"` sentinel) |

---

## Running Integration Tests

```bash
OPENCODE_INFERENCE_URL=http://127.0.0.1:18099/chat/completions PORT=18093 ./crates/ai-gateway/target/release/opencode-ai-gateway & pid=$!
sleep 1
GATEWAY_PORT=18093 python3 crates/ai-gateway/tests/test_gateway.py
kill $pid
```
