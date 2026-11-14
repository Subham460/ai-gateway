import { loadConfig } from "./src/config.ts";
import { FREE_MODELS } from "./src/catalog.ts";
import { sessionID } from "./src/ids.ts";
import { CANONICAL_SYSTEM_PROMPT, READ_TOOL } from "./src/prompt.ts";

const START = Date.now();
const now = () => new Date().toISOString();
const log = (s: string) => console.log(`${now()} ${s}`);

const config = loadConfig({ OCD_ALLOW_ANONYMOUS: "1" });

const body = (model: string) => ({
  model,
  messages: [
    { role: "system", content: CANONICAL_SYSTEM_PROMPT },
    { role: "user", content: "Reply with one word: ok" },
  ],
  tools: READ_TOOL,
  tool_choice: "none",
  stream: true,
  stream_options: { include_usage: true },
  max_completion_tokens: 32,
});

interface R {
  label: string;
  model: string;
  status: number;
  ms: number;
  at: string;
  retryAfter: string | null;
  logId: string | null;
  body: string;
}

async function hit(label: string, model: string, sid: string = sessionID()): Promise<R> {
  const started = Date.now();
  const at = new Date(started).toISOString();
  try {
    const r = await fetch(`${config.upstreamUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer public",
        "content-type": "application/json",
        "user-agent": config.userAgent,
        "x-opencode-client": config.clientName,
        "x-opencode-project": config.projectId,
        "x-opencode-session-id": sid,
        "x-opencode-session": sid,
      },
      body: JSON.stringify(body(model)),
    });
    const text = await r.text();
    return {
      label, model, status: r.status, ms: Date.now() - started, at,
      retryAfter: r.headers.get("retry-after"),
      logId: r.headers.get("x-opencode-log-id"),
      body: text.slice(0, 180).replace(/\s+/g, " "),
    };
  } catch (e) {
    return {
      label, model, status: 0, ms: Date.now() - started, at,
      retryAfter: null, logId: null, body: (e as Error).message,
    };
  }
}

function resetAt(v: string | null): string {
  const s = Number(v);
  if (!v || !Number.isFinite(s) || s <= 0) return "-";
  return new Date(Date.now() + s * 1000).toISOString().replace(".000Z", "Z");
}

function report(r: R) {
  log(
    `PROBE ${r.label.padEnd(12)} status=${String(r.status).padEnd(4)} ms=${String(r.ms).padEnd(6)} ` +
    `retry-after=${r.retryAfter ?? "-"} reset=${resetAt(r.retryAfter)} log=${r.logId ?? "-"}`,
  );
  log(`      model=${r.model} body: ${r.body}`);
}

const primary = FREE_MODELS[0]!.id;
const alternate = FREE_MODELS[2]!.id;

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const attempts = Math.max(1, intEnv("OCD_POLL_ATTEMPTS", 5));
const baseMs = intEnv("OCD_POLL_BASE_MS", 8_000);
const capMs = intEnv("OCD_POLL_CAP_MS", 60_000);

const fast = (r: R) => r.status === 429 && r.ms < 400;

log(`PROBE start upstream=${config.upstreamUrl} client=${config.clientName} ua=${config.userAgent}`);
log(`PROBE project=${config.projectId} primary=${primary} alternate=${alternate}`);
log(`PROBE poll attempts=${attempts} base=${baseMs}ms cap=${capMs}ms`);

let first200: { label: string; at: string; elapsed: number; model: string } | null = null;
let deepest = -1;
const timeline: R[] = [];

for (let i = 1; i <= attempts; i++) {
  const r = await hit(`primary#${i}`, primary);
  timeline.push(r);
  report(r);
  if (r.status > deepest) deepest = r.status;

  if (i === 1) {
    const alt = await hit("alternate", alternate);
    const rid = await hit("random-id", primary, "ses_000000000000zzzzzzzzzzzzzz");
    timeline.push(alt, rid);
    report(alt);
    report(rid);
  }

  if (r.status === 200) {
    first200 = {
      label: r.label,
      at: r.at,
      elapsed: Date.now() - START,
      model: r.model,
    };
    log(`FIRST200 label=${r.label} model=${r.model} at=${r.at} elapsed=${first200.elapsed}ms`);
    break;
  }

  if (i < attempts) {
    let wait = baseMs * 2 ** (i - 1);
    const ra = Number(r.retryAfter);
    if (Number.isFinite(ra) && ra > 0) wait = Math.min(ra * 1000, capMs);
    wait = Math.min(wait, capMs);
    log(`WAIT sleeping=${wait}ms before attempt #${i + 1} (retry-after=${r.retryAfter ?? "-"})`);
    await Bun.sleep(wait);
  }
}

log("PROBE timeline:");
for (const r of timeline) {
  log(`  ${r.at} ${r.label.padEnd(12)} ${r.status} ${r.ms}ms log=${r.logId ?? "-"}`);
}

const totalElapsed = Date.now() - START;

if (first200) {
  log(`RESULT: SERVED — first 200 (${first200.status ?? 200}) at ${first200.at} on ${first200.label} after ${first200.elapsed}ms.`);
} else {
  log(`NO200 within ${totalElapsed}ms window (${attempts} primary attempt(s), deepest status=${deepest}).`);
  const canon = timeline.find((r) => r.label === "primary#1");
  const alt = timeline.find((r) => r.label === "alternate");
  const rid = timeline.find((r) => r.label === "random-id");
  if (canon?.status === 200) {
    log("RESULT: NO DRIFT — canonical request served from this machine.");
  } else if (alt?.status === 200) {
    log("RESULT: ATTESTATION INTACT — a second model served; the primary model id is the failing element.");
  } else if (canon && alt && fast(canon) && fast(alt)) {
    log("RESULT: ENVIRONMENT REFUSAL — quota or egress IP, NOT proven drift. Do not edit src/prompt.ts.");
  } else if (canon && alt && rid && rid.status === 429) {
    log(`RESULT: INVESTIGATE — canonical=${canon.status}/${canon.ms}ms alternate=${alt.status}/${alt.ms}ms random-id=${rid.status}; see bodies above.`);
  } else {
    log(`RESULT: INVESTIGATE — canonical=${canon?.status ?? "?"} in ${canon?.ms ?? "?"}ms (see body).`);
  }
}
log(`PROBE done elapsed=${totalElapsed}ms`);
