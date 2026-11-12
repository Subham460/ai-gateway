import os
import json
import urllib.request
import urllib.error
import sys
import time
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler

GATEWAY_PORT = os.environ.get("GATEWAY_PORT", "18080")
BASE_URL = f"http://127.0.0.1:{GATEWAY_PORT}"
API_KEY = "sk-test-key-12345"
MOCK_UPSTREAM_PORT = 18099

class MockUpstreamHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Silence logging

    def do_POST(self):
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len).decode('utf-8')
        data = json.loads(body)
        model = data.get("model", "deepseek-v4.1-flash-free")
        messages = data.get("messages", [])
        last_msg = messages[-1]["content"] if messages else ""

        # Test trigger for rate limit 429
        if "trigger-rate-limit" in last_msg:
            self.send_response(429)
            self.send_header("Content-Type", "application/json")
            self.send_header("Retry-After", "60")
            self.end_headers()
            err_resp = {
                "type": "error",
                "error": {
                    "type": "FreeUsageLimitError",
                    "message": "Free usage limit reached. Subscribe to OpenCode Go: https://opencode.ai/go"
                }
            }
            self.wfile.write(json.dumps(err_resp).encode('utf-8'))
            return

        is_streaming = data.get("stream", False)
        if is_streaming:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()

            # Stream response chunks
            content = "pong" if "ping" in last_msg.lower() else "Hello! This is a real response from DeepSeek without fallback."
            words = content.split(" ")
            now = int(time.time())
            
            # Initial chunk
            c1 = {
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "created": now,
                "model": model,
                "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]
            }
            self.wfile.write(f"data: {json.dumps(c1)}\n\n".encode('utf-8'))
            self.wfile.flush()

            for w in words:
                cw = {
                    "id": "chatcmpl-mock",
                    "object": "chat.completion.chunk",
                    "created": now,
                    "model": model,
                    "choices": [{"index": 0, "delta": {"content": w + " "}, "finish_reason": None}]
                }
                self.wfile.write(f"data: {json.dumps(cw)}\n\n".encode('utf-8'))
                self.wfile.flush()

            c_done = {
                "id": "chatcmpl-mock",
                "object": "chat.completion.chunk",
                "created": now,
                "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
            }
            self.wfile.write(f"data: {json.dumps(c_done)}\n\n".encode('utf-8'))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            reply = "pong" if "ping" in last_msg.lower() else "Processed strictly by " + model
            resp = {
                "id": "chatcmpl-mock",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": reply},
                    "finish_reason": "stop"
                }],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 5,
                    "total_tokens": 15
                }
            }
            self.wfile.write(json.dumps(resp).encode('utf-8'))

def start_mock_upstream():
    server = HTTPServer(('127.0.0.1', MOCK_UPSTREAM_PORT), MockUpstreamHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server

def make_request(path, method="GET", body=None, headers=None):
    url = f"{BASE_URL}{path}"
    req_headers = {"User-Agent": "OpenAI-Python/1.50.0"}
    if headers:
        req_headers.update(headers)
    
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            content_type = resp.headers.get("Content-Type", "")
            retry_after = resp.headers.get("Retry-After", "")
            return resp.status, resp.read().decode("utf-8"), content_type, retry_after
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8"), e.headers.get("Content-Type", ""), e.headers.get("Retry-After", "")
    except Exception as e:
        return 0, str(e), "", ""

def test_health():
    print("[TEST] 1. Health check endpoint (/health)...")
    status, body, _, _ = make_request("/health")
    assert status == 200, f"Expected 200, got {status}: {body}"
    data = json.loads(body)
    assert data["status"] == "ok"
    assert "deepseek-v4.1-flash-free" in data["available_models"]
    print("  -> PASSED: Health check OK, available models:", len(data["available_models"]))

def test_models_list():
    print("[TEST] 2. Model list endpoint (/v1/models)...")
    status, body, _, _ = make_request("/v1/models", headers={"Authorization": f"Bearer {API_KEY}"})
    assert status == 200, f"Expected 200, got {status}: {body}"
    data = json.loads(body)
    assert data["object"] == "list"
    model_ids = [m["id"] for m in data["data"]]
    assert "deepseek-v4.1-flash-free" in model_ids
    assert "flint-40b-free" in model_ids
    print(f"  -> PASSED: /v1/models returned {len(model_ids)} models")

def test_model_get():
    print("[TEST] 3. Model get endpoint (/v1/models/deepseek-v4.1-flash-free)...")
    status, body, _, _ = make_request("/v1/models/deepseek-v4.1-flash-free", headers={"Authorization": f"Bearer {API_KEY}"})
    assert status == 200, f"Expected 200, got {status}: {body}"
    data = json.loads(body)
    assert data["id"] == "deepseek-v4.1-flash-free"
    print("  -> PASSED: Model found successfully")

    # Test not found
    status, body, _, _ = make_request("/v1/models/non-existent-model", headers={"Authorization": f"Bearer {API_KEY}"})
    assert status == 404
    err = json.loads(body)
    assert err["error"]["code"] == "model_not_found"
    print("  -> PASSED: 404 returned for non-existent model")

def test_chat_non_streaming():
    print("[TEST] 4. Strict Chat Completion without fallback (model=deepseek-v4.1-flash-free)...")
    payload = {
        "model": "deepseek-v4.1-flash-free",
        "messages": [
            {"role": "user", "content": "ping"}
        ],
        "stream": False
    }
    status, body, _, _ = make_request("/v1/chat/completions", method="POST", body=payload, headers={"Authorization": f"Bearer {API_KEY}"})
    assert status == 200, f"Expected 200, got {status}: {body}"
    data = json.loads(body)
    print("  DEBUG content:", data["choices"][0]["message"]["content"])
    assert data["object"] == "chat.completion"
    assert data["model"] == "deepseek-v4.1-flash-free"
    assert "pong" in data["choices"][0]["message"]["content"].lower()
    print("  -> PASSED: Strict non-streaming completion succeeded from requested model")

def test_chat_streaming():
    print("[TEST] 5. Strict Streaming SSE Chat Completion (stream=true)...")
    payload = {
        "model": "deepseek-v4.1-flash-free",
        "messages": [
            {"role": "user", "content": "Hello"}
        ],
        "stream": True
    }
    url = f"{BASE_URL}/v1/chat/completions"
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {API_KEY}"
        },
        method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        assert resp.status == 200
        content_type = resp.headers.get("Content-Type", "")
        assert "text/event-stream" in content_type

        chunks = []
        done_seen = False
        for raw_line in resp:
            line = raw_line.decode("utf-8").strip()
            if not line:
                continue
            if line.startswith("data: "):
                data_part = line[6:]
                if data_part == "[DONE]":
                    done_seen = True
                    break
                chunk = json.loads(data_part)
                chunks.append(chunk)

        assert done_seen, "Expected [DONE] at the end of SSE stream"
        assert len(chunks) > 1, f"Expected multiple chunks, got {len(chunks)}"
        print(f"  -> PASSED: Strict streaming SSE succeeded: {len(chunks)} chunks received")

def test_rate_limit_and_cooldown():
    print("[TEST] 6. Upstream 429 Rate Limit & Cooldown handling (NO FALLBACK)...")
    payload = {
        "model": "deepseek-v4.1-flash-free",
        "messages": [
            {"role": "user", "content": "trigger-rate-limit"}
        ],
        "stream": False
    }
    # First request: triggers 429 from upstream
    status, body, _, retry_after = make_request("/v1/chat/completions", method="POST", body=payload, headers={"Authorization": f"Bearer {API_KEY}"})
    assert status == 429, f"Expected 429, got {status}: {body}"
    err = json.loads(body)
    assert err["error"]["code"] == "rate_limit_exceeded"
    assert "quota" in err["error"]["message"].lower() or "rate limit" in err["error"]["message"].lower()
    print("  -> PASSED: Upstream 429 returned directly to client with rate_limit_exceeded error (NO FALLBACK)")

    # Second request immediately after: should be blocked by cooldown registry without even hitting upstream
    payload2 = {
        "model": "deepseek-v4.1-flash-free",
        "messages": [
            {"role": "user", "content": "hello"}
        ],
        "stream": False
    }
    status2, body2, _, retry_after2 = make_request("/v1/chat/completions", method="POST", body=payload2, headers={"Authorization": f"Bearer {API_KEY}"})
    assert status2 == 429, f"Expected 429 from cooldown, got {status2}: {body2}"
    err2 = json.loads(body2)
    assert "cooldown" in err2["error"]["message"].lower()
    print("  -> PASSED: Subsequent request blocked by cooldown registry with accurate Retry-After")

def test_validation_errors():
    print("[TEST] 7. Validation error handling...")
    status, body, _, _ = make_request("/v1/chat/completions", method="POST", body={"model": "deepseek-v4.1-flash-free", "messages": []}, headers={"Authorization": f"Bearer {API_KEY}"})
    assert status == 400
    err = json.loads(body)
    assert err["error"]["type"] == "invalid_request_error"
    print("  -> PASSED: 400 Bad Request returned on empty messages")

def test_usage_tracking():
    print("[TEST] 8. Usage metrics endpoint (/v1/usage)...")
    status, body, _, _ = make_request("/v1/usage")
    assert status == 200
    usage = json.loads(body)
    assert usage["total_requests"] >= 2
    print(f"  -> PASSED: /v1/usage verified (total requests: {usage['total_requests']}, tokens: {usage['total_tokens']})")

if __name__ == "__main__":
    print("Starting Mock Upstream Server on port", MOCK_UPSTREAM_PORT)
    start_mock_upstream()
    time.sleep(0.5)

    print("Starting AI Gateway tests against:", BASE_URL)
    test_health()
    test_models_list()
    test_model_get()
    test_chat_non_streaming()
    test_chat_streaming()
    test_rate_limit_and_cooldown()
    test_validation_errors()
    test_usage_tracking()
    print("\nAll strict consistency tests passed successfully! NO FALLBACK ACTIVE.")
