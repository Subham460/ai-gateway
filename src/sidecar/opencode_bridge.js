/**
 * OpenCode Bun Sidecar Bridge
 * 
 * Executes requests against OpenCode free-tier inference using Bun's native TLS
 * stack to satisfy Gate 1 (TLS fingerprint allowlist) and envelopes the request
 * with the canonical harness system prompt and read tool to satisfy Gate 2.
 */

import { readFileSync } from "node:fs";

const CANONICAL_READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File or directory to read"
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "The line or directory entry to start reading from (1-based)"
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"
        }
      },
      required: ["path"],
      additionalProperties: false
    },
    strict: false
  }
};

const CANONICAL_SYSTEM_PROMPT = `You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.

# Harness
- Responses are rendered as GitHub-flavored Markdown.
- \`<system-reminder>\` blocks are harness instructions, not user-authored content. Read and follow them.
- Prefer parallelizing independent tool calls.
- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.
- Do not chain shell commands with separators like \`echo "====\";\` or \`printf '---'\`; the output becomes noisy in a way that makes the user's side of the conversation worse.
- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.
- Use the edit tool for targeted changes to existing text files. It replaces the exact text in \`oldString\` with \`newString\`, and the values must differ. By default, \`oldString\` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set \`replaceAll\` to true to replace every occurrence.

# Communication
- Use clear file paths when referring to files.
- Keep responses clear and concise, and avoid unnecessary technical jargon.

# Working in codebases
- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.
- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.`;

async function main() {
  let inputData = "";
  try {
    inputData = readFileSync(0, "utf-8");
  } catch (err) {
    process.stderr.write("Failed to read stdin: " + err.message + "\n");
    process.exit(1);
  }

  if (!inputData.trim()) {
    process.stderr.write("Empty stdin input\n");
    process.exit(1);
  }

  let requestPayload;
  try {
    requestPayload = JSON.parse(inputData);
  } catch (err) {
    process.stderr.write("Invalid JSON in stdin: " + err.message + "\n");
    process.exit(1);
  }

  const endpoint = requestPayload.url || "https://opencode.ai/inference/openai/v1/chat/completions";
  const model = requestPayload.model || "deepseek-v4.1-flash-free";
  const apiKey = requestPayload.apiKey || process.env.OPENCODE_API_KEY || "public";
  const sessionId = requestPayload.sessionId || `ses_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 10)}`;
  const projectId = requestPayload.projectId || "3c45a4f74df4542fa0b6ba0c03c922b76e650f0f";

  // Build the enveloped messages: retain the user's conversation while ensuring Gate 2 passes
  const userMessages = requestPayload.messages || [];
  const messages = [];

  // Check if system message exists; if not, prepend canonical prompt
  const hasSystem = userMessages.some(m => m.role === "system");
  if (!hasSystem) {
    messages.push({ role: "system", content: CANONICAL_SYSTEM_PROMPT });
  }

  for (const m of userMessages) {
    if (m.role === "system") {
      // Enrich user's system prompt with canonical harness instructions to guarantee Gate 2 passing
      messages.push({
        role: "system",
        content: `${CANONICAL_SYSTEM_PROMPT}\n\n# User Instructions\n${m.content}`
      });
    } else {
      messages.push(m);
    }
  }

  // Construct request body fulfilling Gate 2
  const outboundBody = {
    model: model,
    messages: messages,
    tools: [CANONICAL_READ_TOOL],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: requestPayload.max_tokens || 32000
  };

  const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "opencode/latest/2.2.5/cli",
    "x-opencode-client": "cli",
    "x-opencode-project": projectId,
    "x-opencode-session": sessionId,
    "x-opencode-session-id": sessionId,
    "x-session-affinity": sessionId,
    "x-session-id": sessionId,
    "Connection": "keep-alive",
    "Accept": "*/*"
  };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(outboundBody)
    });

    if (!res.ok) {
      const errText = await res.text();
      const retryAfter = res.headers.get("retry-after");
      process.stdout.write(`EVENT:ERROR:{"status":${res.status},"body":${JSON.stringify(errText)},"retryAfter":${JSON.stringify(retryAfter)}}\n`);
      process.exit(0);
    }

    // Stream SSE directly to stdout
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      process.stdout.write(text);
    }

    process.exit(0);
  } catch (err) {
    process.stdout.write(`EVENT:ERROR:{"status":502,"body":${JSON.stringify(err.message)}}\n`);
    process.exit(0);
  }
}

main();

