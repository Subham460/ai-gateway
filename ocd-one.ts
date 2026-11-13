#!/usr/bin/env bun
/**
 * ocd-one — the whole free-tier gateway in a single file, zero dependencies.
 *
 *   bun ocd-one.ts            # or: curl -fsSL https://bun.sh/install | bash
 *
 * Why one file and why Bun: the provider attests the *transport*. Measured on
 * this account, byte-identical requests give 200 from Bun and 429
 * FreeUsageLimitError from Node 22, curl, and Rust+rustls — the TLS/HTTP client
 * is fingerprinted, extra headers are irrelevant. So the only portable artifact
 * is a Bun program, and the smallest portable artifact is one file with the
 * canonical assets embedded (no `bun install`, no asset tree, no build step).
 *
 * Environment (all optional — it runs with none set):
 *   OCD_PORT=8787                 listen port (falls back to a free port)
 *   OCD_HOST=127.0.0.1            bind address (0.0.0.0 behind TLS)
 *   OCD_KEYS="secret:name,..."    require Bearer keys (default: open + loopback)
 *   OCD_TOOLS_MODE=read|full      canonical tool set
 *   OCD_TOOL_CHOICE=none|auto     "none" behaves like a plain chat endpoint
 *   OCD_DEFAULT_MAX_TOKENS=32000  completion budget when the client omits one
 *   OCD_REASONING_HEADROOM_TOKENS=0  extra budget so hidden thinking can't starve output
 *   OCD_UPSTREAM_URL=...          override the provider base URL
 *   OCD_ALLOW_ANY_MODEL=1         accept model ids outside the embedded catalog
 *
 * Routes: POST /v1/chat/completions (stream + non-stream), GET /v1/models,
 * GET /v1/models/{id}, GET /healthz, GET /readyz.
 */

const VERSION = "1.0.0";

// ─── embedded canonical assets (byte-identical to src/assets/) ───────────────
const CANONICAL_SYSTEM_PROMPT: string = "You are an AI agent running in OpenCode, a coding agent harness. Help the user accomplish their goals using the tools you have available.\n\n# Harness\n- Responses are rendered as GitHub-flavored Markdown.\n- `<system-reminder>` blocks are harness instructions, not user-authored content. Read and follow them.\n- Prefer parallelizing independent tool calls.\n- Prefer dedicated tools over shell commands; fall back to the shell when a tool cannot do what you need.\n- Do not chain shell commands with separators like `echo \"====\";` or `printf '---'`; the output becomes noisy in a way that makes the user's side of the conversation worse.\n- Use the write tool to create files or completely replace their content. Prefer using the edit tool for targeted changes.\n- Use the edit tool for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.\n\n# Communication\n- Use clear file paths when referring to files.\n- Keep responses clear and concise, and avoid unnecessary technical jargon.\n\n# Working in codebases\n- Keep changes consistent with the structure, naming, style, and patterns of the surrounding code.\n- Treat unfamiliar files or changes as potential user work and investigate before deleting or overwriting them.\n\n# Your Model\n- Name: DeepSeek V4.1 Flash Free\n- Provider ID: opencode\n- Model ID: deepseek-v4.1-flash-free\n# Code Mode\n\nThe tools listed below cannot be called directly: they only work as JavaScript inside the `execute` tool. Every other tool you have is a normal tool call: call it directly, never inside `execute`.\n\nThe catalog is complete. Do not guess tool names.\n\n## Code Mode tools (call only inside `execute`)\n\n- opencode (8 tools) // Tools for managing OpenCode itself, such as working with sessions and worktrees, searching the available models, and reading MCP resources.\n  - tools.opencode.session_move({\n  /** Omit to move the current session. @pattern ^ses */\n  sessionID?: string,\n  /** Destination directory, relative to the target session's directory or absolute. Supports ~. @minLength 1 */\n  directory: string,\n}): Promise<{\n  /** @pattern ^ses */\n  sessionID: string,\n  directory: string,\n}> // Move a session to another directory, or omit sessionID to move the current session. The current session moves at the ...\n  - tools.opencode.worktree_create({\n  name: string,\n}): Promise<{\n  directory: string,\n}> // Create a named worktree. Returns its directory.\n  - tools.opencode.worktree_list(): Promise<{\n  worktrees: Array<{\n      directory: string,\n      strategy?: string,\n    }>,\n}> // List a repository's worktrees.\n  - tools.opencode.worktree_remove({\n  /** Absolute path of the worktree to remove. @minLength 1 */\n  directory: string,\n  /** Discard modified and untracked files. Only set this when the user has confirmed forced removal. */\n  force?: boolean,\n}): Promise<{\n  directory: string,\n  removed: boolean,\n}> // Remove a worktree. The repository location selects configuration; directory identifies the worktree to remove.\n  - tools.opencode.list_mcp_resources({\n  /** MCP server name as configured. Omit to list every server. */\n  server?: string,\n}): Promise<{\n  resources: Array<{\n      server: string,\n      name: string,\n      uri: string,\n      description?: string,\n      mimeType?: string,\n    }>,\n  templates: Array<{\n      server: string,\n      name: string,\n      uriTemplate: string,\n      description?: string,\n      mimeType?: string,\n    }>,\n}> // List documents, records, and other data exposed by MCP servers. Use this when the user refers to something that is no...\n  - tools.opencode.models({\n  /** Text to search for in model names and IDs. */\n  query?: string,\n  /** Provider ID or name to filter by. Try your own provider first. */\n  provider?: string,\n  /**\n   * Which kind of model to list. Defaults to \"chat\".\n   * \"chat\": a language model (LLM). Powers sessions, agents and subagents, and can call tools.\n   * \"image\": generates or edits images from a prompt. It can't chat or call tools.\n   */\n  type?: \"chat\" | \"image\",\n  /** Include older versions of each model family. By default only the newest version is listed. */\n  all?: boolean,\n  /** Maximum number of models to return. Defaults to 20. @integer @minimum 1 @maximum 100 */\n  limit?: number,\n  /** Number of models to skip, for paging through results. @integer @minimum 0 */\n  offset?: number,\n}): Promise<{\n  /** Matching models grouped by provider. Your own provider comes first. */\n  providers: Array<{\n      id: string,\n      name: string,\n      /** Newest first. */\n      models: Array<{\n          /** providerID/modelID */\n          id: string,\n          name: string,\n          /** Release date as a Unix timestamp in milliseconds, or 0 when unknown. */\n          released: number,\n          variants: Array<string>,\n          /** Pricing in USD per million tokens. */\n          cost: Array<{\n              tier?: {\n                type: \"context\",\n                /** @integer */\n                size: number,\n              },\n              input: number,\n              output: number,\n              cache: {\n                read: number,\n                write: number,\n              },\n            }>,\n          status: \"alpha\" | \"beta\" | \"deprecated\" | \"active\",\n        }>,\n    }>,\n  /** Number of matching models across all pages. @integer */\n  total: number,\n  /** Offset of the next page, or null on the last page. */\n  next: number | null,\n}> // Search the models available to use. Use this to turn a model name the user mentions into an exact reference for a too...\n  - tools.opencode.read_mcp_resource({\n  /** The server field of the discovered resource. */\n  server: string,\n  /** Exact resource URI from discovery, an expanded uriTemplate, or the user. */\n  uri: string,\n}): Promise<{\n  server: string,\n  uri: string,\n  contents: Array<{\n        type: \"text\",\n        uri: string,\n        text: string,\n        mimeType?: string,\n      } | {\n        type: \"blob\",\n        uri: string,\n        blob: string,\n        mimeType?: string,\n      }>,\n}> // Read one MCP resource by server and URI. Not for local files. Always return the full contents rather than slicing or ...\n  - tools.opencode.session_rename({\n  /** Omit to rename the current session. @pattern ^ses */\n  sessionID?: string,\n  /** New session title. @minLength 1 */\n  title: string,\n}): Promise<{\n  /** @pattern ^ses */\n  sessionID: string,\n  title: string,\n}> // Rename a session, or omit sessionID to rename the current session. Use a short, specific title that summarizes the wo...\n\nSkills provide specialized instructions and workflows for specific tasks.\nUse the skill tool to load a skill when a task matches its description.\nThe user may also invoke a skill directly. When that happens, its instructions appear in the conversation as a <skill_content> block, the same shape the skill tool returns. A skill that is already present this way does not need to be invoked again.\n<available_skills>\n  <skill>\n    <id>opencode</id>\n    <name>OpenCode</name>\n    <description>Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app.</description>\n  </skill>\n  <skill>\n    <id>report</id>\n    <name>Report</name>\n    <description>Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI.</description>\n  </skill>\n</available_skills>\n\nToday's date: Fri Nov 13 2026\n\nHere is some useful information about the environment you are running in:\n<env>\n  Working directory: /tmp\n  Workspace root folder: /tmp\n  Is directory a git repo: no\n  Platform: linux\n  Prefer /tmp/opencode over generic system temporary directories such as /tmp; it is pre-created and approved for external access.\n</env>\nWhen you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory.";
const READ_TOOL: unknown[] = [{"type":"function","function":{"name":"read","description":"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"File or directory to read"},"offset":{"type":"integer","description":"The line or directory entry to start reading from (1-based)"},"limit":{"type":"integer","minimum":0,"description":"The maximum number of lines or directory entries to read (defaults to and capped at 2000)"}},"required":["path"],"additionalProperties":false},"strict":false}}];
const FULL_TOOLS: unknown[] = [{"type":"function","function":{"name":"edit","description":"Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"File to edit"},"oldString":{"type":"string","description":"Exact text to find and replace"},"newString":{"type":"string","description":"Text to replace oldString with (must differ from oldString)"},"replaceAll":{"type":"boolean","description":"Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."}},"required":["path","oldString","newString"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"glob","description":"Search file paths using a glob pattern (examples: \"**/*.ts\", \"src/**/*.tsx\").","parameters":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern to match files against"},"path":{"type":"string","description":"Directory to search. Defaults to the current working directory."},"hidden":{"type":"boolean","description":"Include hidden files and directories (default: false)."},"limit":{"type":"integer","exclusiveMinimum":0,"description":"Maximum number of matching files to return (default: 100)"}},"required":["pattern"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"grep","description":"Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.","parameters":{"type":"object","properties":{"pattern":{"type":"string","minLength":1,"description":"Regular expression or literal text to match in file contents."},"path":{"type":"string","description":"File or directory to search. Defaults to the current working directory."},"include":{"type":"string","description":"Glob pattern to filter files (for example, \"*.js\" or \"*.{ts,tsx}\")"},"literal":{"type":"boolean","description":"Treat `pattern` as exact text instead of a regular expression (default: false)."},"caseSensitive":{"type":"boolean","description":"Use case-sensitive matching (default: true)."},"limit":{"type":"integer","exclusiveMinimum":0,"description":"Maximum number of matching lines to return (default: 100)"}},"required":["pattern"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"question","description":"Use this tool when you need to ask the user questions during execution. This allows you to:\n1. Gather user preferences or requirements\n2. Clarify ambiguous instructions\n3. Get decisions on implementation choices as you work\n4. Offer choices to the user about what direction to take.\n\nUsage notes:\n- A \"Type your own answer\" option is added automatically; don't include a separate option for free form answers\n- Set `multiple: true` to allow selecting more than one option\n- If you recommend a specific option, make that the first option in the list and add \"(Recommended)\" at the end of the label","parameters":{"type":"object","properties":{"questions":{"type":"array","items":{"type":"object","properties":{"question":{"type":"string","description":"Complete question"},"header":{"type":"string","description":"Very short label (max 30 chars)"},"options":{"type":"array","items":{"type":"object","properties":{"label":{"type":"string","description":"Display text (1-5 words, concise)"},"description":{"type":"string","description":"Explanation of choice"}},"required":["label","description"],"additionalProperties":false},"description":"Available choices"},"multiple":{"type":"boolean"}},"required":["question","header","options"],"additionalProperties":false},"minItems":1,"description":"Questions to ask"}},"required":["questions"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"read","description":"Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"File or directory to read"},"offset":{"type":"integer","description":"The line or directory entry to start reading from (1-based)"},"limit":{"type":"integer","minimum":0,"description":"The maximum number of lines or directory entries to read (defaults to and capped at 2000)"}},"required":["path"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"shell","description":"Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.","parameters":{"type":"object","properties":{"command":{"type":"string","description":"Shell command string to execute"},"workdir":{"type":"string","description":"Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."},"timeout":{"type":"integer","minimum":0,"description":"Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."},"background":{"type":"boolean","description":"Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."}},"required":["command"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"skill","description":"Load a specialized skill's instructions and resources into the current conversation when the task at hand matches its description.\n\nThe skill ID must match an available skill or a skill explicitly referenced by the user.","parameters":{"type":"object","properties":{"id":{"type":"string","description":"The ID of an available skill or a skill explicitly referenced by the user"}},"required":["id"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"subagent","description":"Spawns an agent in a child session to work on the specified task.\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\nNew child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.\nForeground (default) runs the subagent to completion and returns its final response.\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\nUse background only for independent work that can run while you continue elsewhere.\n\nAvailable subagents:\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \"src/components/**/*.tsx\"), search code for keywords (eg. \"API endpoints\"), or answer questions about the codebase (eg. \"how do API endpoints work?\"). When calling this agent, specify the desired thoroughness level: \"quick\" for basic searches, \"medium\" for moderate exploration, or \"very thorough\" for comprehensive analysis across multiple locations and naming conventions.\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.","parameters":{"type":"object","properties":{"agent":{"type":"string","description":"The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead."},"description":{"type":"string","description":"A short 3-5 word label for the task, displayed to the user"},"prompt":{"type":"string","description":"The task for the subagent to perform"},"model":{"type":"string","description":"NEVER set this unless the user explicitly asks for a particular model or variant. It must be a chat model; image and decision models can't run subagents. The value is written as \"providerID/modelID\", or \"providerID/modelID#variant\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first."},"sessionID":{"type":"string","pattern":"^ses","description":"Send a follow-up to an existing subagent, running or finished. Omit to start a new one."},"background":{"type":"boolean","description":"Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress."}},"required":["agent","description","prompt"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"webfetch","description":"Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\n\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.","parameters":{"type":"object","properties":{"url":{"type":"string","description":"The HTTP or HTTPS URL to fetch content from"},"format":{"type":"string","enum":["text","markdown","html"],"description":"The format to return the content in. Defaults to markdown."},"timeout":{"type":"number","exclusiveMinimum":0,"maximum":120,"description":"Optional timeout in seconds (maximum: 120)"}},"required":["url"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"websearch","description":"Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.\n\nThe current year is 2026. Use this year when searching for recent information or current events.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"Websearch query"}},"required":["query"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"write","description":"Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.","parameters":{"type":"object","properties":{"path":{"type":"string","description":"Path to the file to write to"},"content":{"type":"string","description":"Content to write to the file"}},"required":["path","content"],"additionalProperties":false},"strict":false}},{"type":"function","function":{"name":"execute","description":"Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.\n`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable: there is no `setTimeout` or sleep. All other external access goes through `tools`.\nWithin `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.\nCall tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>[\"tool-name\"](input)`.\nPrefer an explicit `return`; if omitted, the final top-level expression becomes the result.\nAwait every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.","parameters":{"type":"object","properties":{"code":{"type":"string"}},"required":["code"],"additionalProperties":false},"strict":false}}];
const MAX_COMPLETION_TOKENS = 32_000;

interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  released: number;
}

const MODELS: ModelInfo[] = [{"id":"deepseek-v4.1-flash-free","providerID":"opencode","name":"DeepSeek V4.1 Flash Free","contextWindow":200000,"maxOutputTokens":32000,"released":1792195200},{"id":"flint-40b-free","providerID":"opencode","name":"Flint 40B Free","contextWindow":128000,"maxOutputTokens":16384,"released":1792195200},{"id":"glm-5.3-flash-free","providerID":"opencode","name":"GLM-5.3-Flash Free","contextWindow":200000,"maxOutputTokens":32000,"released":1787702400},{"id":"big-pickle","providerID":"opencode","name":"Big Pickle","contextWindow":128000,"maxOutputTokens":16384,"released":1760659200},{"id":"iceman-free","providerID":"opencode","name":"Iceman Free","contextWindow":128000,"maxOutputTokens":16384,"released":1793923200},{"id":"inkling-2-small-free","providerID":"opencode","name":"Inkling 2 Small Free","contextWindow":128000,"maxOutputTokens":16384,"released":0},{"id":"longcat-2.5-free","providerID":"opencode","name":"LongCat 2.5 Free","contextWindow":128000,"maxOutputTokens":16384,"released":0},{"id":"mimo-v2.6-flash-free","providerID":"opencode","name":"MiMo V2.6 Flash Free","contextWindow":128000,"maxOutputTokens":16384,"released":0},{"id":"minimax-m3.1-flash-free","providerID":"opencode","name":"MiniMax M3.1 Flash Free","contextWindow":128000,"maxOutputTokens":16384,"released":0},{"id":"nemotron-3.5-lightning-free","providerID":"opencode","name":"Nemotron 3.5 Lightning Free","contextWindow":128000,"maxOutputTokens":16384,"released":0},{"id":"nemotron-3.5-super-vl-free","providerID":"opencode","name":"Nemotron 3.5 Super VL Free","contextWindow":128000,"maxOutputTokens":16384,"released":0},{"id":"beam-free","providerID":"opencode","name":"Beam Free","contextWindow":128000,"maxOutputTokens":16384,"released":0}];
const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

// ─── config ─────────────────────────────────────────────────────────────────
const env = process.env;
const UPSTREAM = (env.OCD_UPSTREAM_URL ?? "https://opencode.ai/inference/openai/v1").replace(/\/+$/, "");
const USER_AGENT = env.OCD_USER_AGENT ?? "opencode/latest/2.2.7/cli";
const CLIENT_NAME = env.OCD_CLIENT_NAME ?? "cli";
const PROJECT_ID = env.OCD_PROJECT_ID ?? "470c8549ef01a2a9d3c85b22965766cefc874134";
const HOST = env.OCD_HOST ?? "127.0.0.1";
const PORT = Number(env.OCD_PORT ?? 8787);
const TOOLS_MODE = env.OCD_TOOLS_MODE === "full" ? "full" : "read";
const TOOL_CHOICE = env.OCD_TOOL_CHOICE === "auto" ? "auto" : "none";
const DEFAULT_MAX_TOKENS = Number(env.OCD_DEFAULT_MAX_TOKENS ?? MAX_COMPLETION_TOKENS);
const REASONING_HEADROOM = Number(env.OCD_REASONING_HEADROOM_TOKENS ?? 0);
const UPSTREAM_TIMEOUT_MS = Number(env.OCD_UPSTREAM_TIMEOUT_MS ?? 300_000);
const ALLOW_ANY_MODEL = env.OCD_ALLOW_ANY_MODEL === "1";
const KEYS = (env.OCD_KEYS ?? "")
  .split(",")
  .map((entry) => entry.trim().split(":")[0]!)
  .filter((secret) => secret.length >= 8);

if (typeof Bun === "undefined") {
  console.error(
    "ocd-one must run under Bun: the provider fingerprints the TLS client and rejects\n" +
      "Node/Deno/curl with 429 FreeUsageLimitError. Install Bun, then re-run:\n" +
      "  curl -fsSL https://bun.sh/install | bash && bun ocd-one.ts",
  );
  process.exit(1);
}
if (Bun.version < "1.4") {
  console.error(`warning: bun ${Bun.version} is untested; the fingerprint was verified on 1.4.x`);
}

// ─── session ids (Session.ID.create from the 2.2.7 bundle) ──────────────────
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastMs = 0;
let counter = 0;

function sessionID(now: number = Date.now()): string {
  if (now !== lastMs) {
    lastMs = now;
    counter = 0;
  }
  counter += 1;
  const value = ~(BigInt(now) * 4096n + BigInt(counter));
  let hex = "";
  for (let i = 0; i < 6; i++) {
    hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
  }
  const random = crypto.getRandomValues(new Uint8Array(14));
  let suffix = "";
  for (const byte of random) suffix += ALPHABET[byte % 62];
  return `ses_${hex}${suffix}`;
}

// ─── errors ─────────────────────────────────────────────────────────────────
// Field assignment instead of TS parameter properties: keeps the file runnable
// by a plain `node --experimental-strip-types`, so a non-Bun user reaches the
// guard below and gets instructions rather than a syntax error.
class HttpError extends Error {
  status: number;
  type: string;
  code: string | null;
  retryAfterMs: number | null;

  constructor(
    status: number,
    message: string,
    type = "invalid_request_error",
    code: string | null = null,
    retryAfterMs: number | null = null,
  ) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  toJSON() {
    return { error: { message: this.message, type: this.type, param: null, code: this.code } };
  }
}

const badRequest = (message: string) => new HttpError(400, message);

// ─── request assembly (the attested shape) ──────────────────────────────────
type Role = "system" | "developer" | "user" | "assistant" | "tool" | "function";

interface Msg {
  role: Role;
  content?: unknown;
  name?: string;
  tool_calls?: unknown[];
}

function contentToText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as { type?: string; text?: string };
    if ((p.type === "text" || p.type === "input_text") && typeof p.text === "string") parts.push(p.text);
    else if (p.type === "image_url" || p.type === "input_image") parts.push("[image omitted: text-only gateway]");
  }
  return parts.join("\n");
}

function resolveModel(id: unknown): ModelInfo {
  if (typeof id !== "string" || id.length === 0) throw badRequest("`model` is required");
  const known = MODEL_BY_ID.get(id);
  if (known) return known;
  if (ALLOW_ANY_MODEL) {
    return { id, providerID: "opencode", name: id, contextWindow: 200_000, maxOutputTokens: 16_384, released: 0 };
  }
  throw new HttpError(404, `model \`${id}\` not found; see GET /v1/models`, "not_found_error", "model_not_found");
}

interface BuiltBody {
  body: string;
  model: ModelInfo;
  maxTokens: number;
}

function buildUpstreamBody(request: Record<string, unknown>): BuiltBody {
  const model = resolveModel(request.model);
  const messages = request.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw badRequest("`messages` must be a non-empty array");
  }

  const systemBlocks: string[] = [];
  const conversation: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const raw of messages as Msg[]) {
    if (!raw || typeof raw.role !== "string") throw badRequest("every message needs a string `role`");
    const text = contentToText(raw.content);
    switch (raw.role) {
      case "system":
      case "developer":
        if (text.trim()) systemBlocks.push(text.trim());
        break;
      case "user":
        if (text.trim()) conversation.push({ role: "user", content: text });
        break;
      case "assistant":
        if (text.trim() || (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0)) {
          conversation.push({ role: "assistant", content: text });
        }
        break;
      case "tool":
      case "function": {
        const label = raw.name ? `Tool result (${raw.name})` : "Tool result";
        if (text.trim()) conversation.push({ role: "user", content: `${label}:\n${text}` });
        break;
      }
      default:
        throw badRequest(`unsupported message role: ${String(raw.role)}`);
    }
  }

  if (!conversation.some((m) => m.role === "user")) {
    throw badRequest("`messages` must contain at least one non-empty user message");
  }

  // The canonical prompt must lead; caller instructions are appended, which the
  // provider accepts (a replacement is rejected).
  let system = CANONICAL_SYSTEM_PROMPT;
  if (systemBlocks.length > 0) system += `\n\n# User Instructions\n${systemBlocks.join("\n\n")}`;

  const requested = Number((request.max_completion_tokens as number) ?? (request.max_tokens as number) ?? DEFAULT_MAX_TOKENS);
  const ceiling = Math.min(MAX_COMPLETION_TOKENS, model.maxOutputTokens);
  const clamped = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : DEFAULT_MAX_TOKENS;
  const maxTokens = Math.min(ceiling, clamped + Math.max(0, REASONING_HEADROOM));

  const payload = {
    model: model.id,
    messages: [{ role: "system", content: system }, ...conversation],
    tools: TOOLS_MODE === "full" ? FULL_TOOLS : READ_TOOL,
    tool_choice: TOOL_CHOICE,
    stream: true, // always: `stream:false` is rejected upstream
    stream_options: { include_usage: true },
    max_completion_tokens: maxTokens,
  };

  return { body: JSON.stringify(payload), model, maxTokens };
}

// ─── upstream ───────────────────────────────────────────────────────────────
function upstreamHeaders(session: string): Record<string, string> {
  return {
    authorization: "Bearer public",
    "content-type": "application/json",
    "user-agent": USER_AGENT,
    "x-opencode-client": CLIENT_NAME,
    "x-opencode-project": PROJECT_ID,
    "x-opencode-session-id": session,
    "x-opencode-session": session,
  };
}

/** One attempt. 429 is surfaced verbatim and never retried — that is a quota, not a hiccup. */
async function sendUpstream(body: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`${UPSTREAM}/chat/completions`, {
    method: "POST",
    headers: upstreamHeaders(sessionID()),
    body,
    signal,
  });
  if (response.ok) return response;

  const text = await response.text().catch(() => "");
  let message = `upstream returned ${response.status}`;
  let type = "upstream_error";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } };
    message = parsed.error?.message ?? message;
    type = parsed.error?.type ?? type;
  } catch {
    if (text.trim()) message = text.slice(0, 300);
  }

  const retryAfter = response.headers.get("retry-after");
  const retryAfterMs = retryAfter && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) * 1000 : null;

  if (response.status === 429) {
    throw new HttpError(
      429,
      message,
      "rate_limit_error",
      "free_usage_limit",
      retryAfterMs,
    );
  }
  throw new HttpError(502, message, type === "FreeUsageLimitError" ? "rate_limit_error" : type, "upstream_status");
}

async function openUpstream(body: string, signal: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await sendUpstream(body, signal);
    } catch (error) {
      lastError = error;
      // Only retry transport faults and 5xx; 4xx (429 included) is final.
      const status = error instanceof HttpError ? error.status : 0;
      if (status !== 0 && status !== 502) throw error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  throw lastError instanceof HttpError
    ? lastError
    : new HttpError(502, `upstream unreachable: ${String(lastError)}`, "upstream_error", "upstream_unreachable");
}

// ─── SSE consumption ────────────────────────────────────────────────────────
interface Delta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
}

interface Streamed {
  text: string;
  reasoning: string;
  finishReason: string;
  usage: unknown;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
}

async function consumeUpstream(
  response: Response,
  onDelta?: (delta: Delta, finishReason: string | null) => void,
): Promise<Streamed> {
  const result: Streamed = { text: "", reasoning: "", finishReason: "stop", usage: null, toolCalls: [] };
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handle = (payload: string): boolean => {
    if (payload === "[DONE]") return true;
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return false;
    }
    if (parsed.usage) result.usage = parsed.usage;
    const choice = parsed.choices?.[0];
    if (!choice) return false;

    const delta: Delta = choice.delta ?? {};
    if (typeof delta.content === "string") result.text += delta.content;
    if (typeof delta.reasoning_content === "string") result.reasoning += delta.reasoning_content;

    if (Array.isArray(delta.tool_calls)) {
      for (const call of delta.tool_calls as any[]) {
        const index = typeof call.index === "number" ? call.index : result.toolCalls.length;
        const slot = (result.toolCalls[index] ??= { id: "", name: "", arguments: "" });
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.name = call.function.name;
        if (typeof call.function?.arguments === "string") slot.arguments += call.function.arguments;
      }
    }
    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    onDelta?.(delta, choice.finish_reason ?? null);
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer.slice(index).startsWith("\r\n\r\n") ? 4 : 2));
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => (line.slice(5).startsWith(" ") ? line.slice(6) : line.slice(5)))
        .join("\n")
        .trim();
      if (data && handle(data)) return result;
    }
  }
  if (buffer.trim()) handle(buffer.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => (l.slice(5).startsWith(" ") ? l.slice(6) : l.slice(5))).join("\n").trim());
  return result;
}

// ─── OpenAI response shaping ────────────────────────────────────────────────
const newId = () => `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
const frame = (payload: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);

function toolCallsOut(calls: Streamed["toolCalls"]) {
  return calls
    .filter((call) => call.name || call.arguments)
    .map((call) => ({
      id: call.id || `call_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
}

// ─── HTTP handlers ──────────────────────────────────────────────────────────
function authenticate(request: Request): void {
  if (KEYS.length === 0) return;
  const header = request.headers.get("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!KEYS.includes(secret)) throw new HttpError(401, "invalid API key", "authentication_error", "invalid_api_key");
}

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function json(payload: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...cors, ...extra },
  });
}

async function chat(request: Request): Promise<Response> {
  authenticate(request);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw badRequest("request body must be valid JSON");
  }

  const built = buildUpstreamBody(body);
  const wantsStream = body.stream === true;
  const created = Math.floor(Date.now() / 1000);
  const id = newId();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]);
  const upstream = await openUpstream(built.body, signal);

  if (!wantsStream) {
    const result = await consumeUpstream(upstream);
    const calls = toolCallsOut(result.toolCalls);
    return json({
      id,
      object: "chat.completion",
      created,
      model: built.model.id,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: calls.length > 0 && result.text.length === 0 ? null : result.text,
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
            ...(calls.length > 0 ? { tool_calls: calls } : {}),
          },
          finish_reason: result.finishReason,
        },
      ],
      usage: result.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let sentRole = false;
      const chunk = (delta: Delta, finishReason: string | null) => {
        const outgoing: Delta = { ...delta };
        if (!sentRole) {
          outgoing.role = "assistant";
          sentRole = true;
        } else {
          delete outgoing.role;
        }
        // Skip empty keep-alive deltas; the client only needs content, tool
        // calls, reasoning, or a finish reason.
        const interesting =
          outgoing.role ||
          outgoing.content ||
          outgoing.reasoning_content ||
          (outgoing.tool_calls && outgoing.tool_calls.length > 0) ||
          finishReason;
        if (!interesting) return;
        controller.enqueue(
          frame({
            id,
            object: "chat.completion.chunk",
            created,
            model: built.model.id,
            choices: [{ index: 0, delta: outgoing, finish_reason: finishReason }],
          }),
        );
      };
      try {
        const result = await consumeUpstream(upstream, (delta, finishReason) => chunk(delta, finishReason));
        if (result.usage) {
          controller.enqueue(
            frame({
              id,
              object: "chat.completion.chunk",
              created,
              model: built.model.id,
              choices: [],
              usage: result.usage,
            }),
          );
        }
      } catch (error) {
        controller.enqueue(
          frame({ error: { message: (error as Error).message, type: "upstream_error" } }),
        );
      }
      controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      controller.close();
    },
    cancel() {
      void upstream.body?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      ...cors,
    },
  });
}

function modelPayload(model: ModelInfo) {
  return {
    id: model.id,
    object: "model",
    created: model.released,
    owned_by: model.providerID,
    context_window: model.contextWindow,
    max_output_tokens: model.maxOutputTokens,
  };
}

const handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    if (url.pathname === "/healthz") return json({ ok: true, version: VERSION, bun: Bun.version });
    if (url.pathname === "/readyz") return json({ ready: true, models: MODELS.length, upstream: UPSTREAM });

    if (request.method === "GET" && url.pathname === "/v1/models") {
      authenticate(request);
      return json({ object: "list", data: MODELS.map(modelPayload) });
    }
    if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      authenticate(request);
      const id = decodeURIComponent(url.pathname.slice("/v1/models/".length));
      const model = MODEL_BY_ID.get(id);
      if (!model) throw new HttpError(404, `model \`${id}\` not found`, "not_found_error", "model_not_found");
      return json(modelPayload(model));
    }
    if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
      return await chat(request);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return json({ service: "ocd-one", version: VERSION, routes: ["/v1/chat/completions", "/v1/models", "/healthz"] });
    }
    throw new HttpError(404, `no route for ${request.method} ${url.pathname}`, "not_found_error", "not_found");
  } catch (error) {
    if (error instanceof HttpError) {
      const headers = error.retryAfterMs ? { "retry-after": String(Math.ceil(error.retryAfterMs / 1000)) } : {};
      return json(error.toJSON(), error.status, headers);
    }
    return json(
      { error: { message: (error as Error).message, type: "server_error", param: null, code: "internal_error" } },
      500,
    );
  }
};

// ─── boot ───────────────────────────────────────────────────────────────────
let server: ReturnType<typeof Bun.serve>;
try {
  server = Bun.serve({ hostname: HOST, port: PORT, idleTimeout: 0, fetch: handler });
} catch {
  server = Bun.serve({ hostname: HOST, port: 0, idleTimeout: 0, fetch: handler });
  console.error(`port ${PORT} unavailable; listening on ${server.port} instead`);
}

const auth = KEYS.length > 0 ? "bearer keys required" : "open (loopback only — set OCD_KEYS before exposing)";
console.log(
  `ocd-one ${VERSION} on http://${server.hostname}:${server.port}/v1  ` +
    `· ${MODELS.length} models · tools=${TOOLS_MODE}/${TOOL_CHOICE} · ${auth} · bun ${Bun.version}`,
);
console.log(`try: curl -s http://${server.hostname}:${server.port}/v1/chat/completions \\`);
console.log(`  -H 'content-type: application/json' \\`);
console.log(`  -d '{"model":"${MODELS[0]!.id}","messages":[{"role":"user","content":"hello"}]}'`);
