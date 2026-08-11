// request-helpers.js
// Pure helpers for title short-circuit, rate-limit wait parsing, conversation-
// length detection, and compact tool preambles. Kept free of I/O so they can
// be unit-tested without starting the HTTP server / Playwright.

import { sanitizeDiagnosticText } from "./error-sanitize.js";

const flag = (v) => String(v ?? "").trim();
export const PLAN_MODE_MARKER = "<opencode_mode>plan</opencode_mode>";

export function isPlanMode(messages) {
  return (messages || []).some(
    (message) =>
      message?.role === "system" && contentToText(message.content).includes(PLAN_MODE_MARKER)
  );
}

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

/** Return image payloads attached to messages[startIndex..] in message order. */
export function imagesFromMessages(messages, startIndex = 0) {
  return (Array.isArray(messages) ? messages : [])
    .slice(Math.max(0, startIndex))
    .flatMap((message) => (Array.isArray(message?.images) ? message.images : []));
}

/** Images belonging to the same recent user turns used by compact recovery. */
export function recentUserImages(messages, userTurns = 2) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message?.role === "user")
    .slice(-Math.max(0, userTurns))
    .flatMap((message) => (Array.isArray(message?.images) ? message.images : []));
}

// ---- 1. Local title generation ----------------------------------------------
// OpenCode's title agent (agent=title, small=true) always sends a system prompt
// starting with "You are a title generator" and a user line
// "Generate a title for this conversation:". Answering that locally saves one
// full ChatGPT web send (~30-60s) and stops title/main from racing the queue.

const TITLE_SYSTEM_RE = /you are a title generator/i;
const TITLE_USER_RE = /generate a title for this conversation/i;

export function isTitleGenerationRequest(messages, tools = []) {
  if (Array.isArray(tools) && tools.length > 0) return false;
  if (!Array.isArray(messages) || messages.length === 0) return false;
  for (const m of messages) {
    const text = contentToText(m?.content);
    if (m?.role === "system" && TITLE_SYSTEM_RE.test(text)) return true;
    if (TITLE_USER_RE.test(text)) return true;
  }
  return false;
}

/**
 * Derive a ≤50-char title from the conversation payload OpenCode embeds in the
 * title request. Skips the "Generate a title…" instruction itself.
 */
export function localTitleFromMessages(messages) {
  const candidates = [];
  for (const m of messages || []) {
    if (m?.role === "system") continue;
    let t = contentToText(m?.content).trim();
    if (!t) continue;
    t = t.replace(/^Generate a title for this conversation:\s*/i, "").trim();
    if (!t) continue;
    // Prefer the first real user turn; assistant/tool text is fallback only.
    if (m.role === "user") candidates.unshift(t);
    else candidates.push(t);
  }
  let raw = candidates[0] || "New session";
  // First non-empty line, strip markdown fences / headings / bullets.
  raw =
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) || "New session";
  raw = raw
    .replace(/^#+\s*/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^```\w*/, "")
    // Strip markdown emphasis markers, but keep underscores inside words
    // (IMPROVE_OK must stay IMPROVE_OK, not IMPROVEOK).
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) raw = "New session";
  if (raw.length > 50)
    raw =
      raw
        .slice(0, 47)
        .replace(/\s+\S*$/, "")
        .trimEnd() + "...";
  if (raw.length > 50) raw = raw.slice(0, 50);
  return raw;
}

// ---- 2. Conversation length limit -------------------------------------------
// ChatGPT web banners when a reused chat hits the thread-length cap. Keep the
// match short-reply-only so a long legitimate answer mentioning "too long"
// isn't misclassified.

export const MAX_LENGTH_RE =
  /(maximum (?:conversation|context|message|chat) length|conversation (?:is|has) (?:too )?long|this conversation is (?:getting )?too long|reached the maximum|context (?:window|length) (?:exceeded|limit|reached)|message is too long|can'?t send (?:any )?more messages|please start a new (?:chat|conversation))/i;

export function isConversationTooLong(reply) {
  return !!(reply && reply.length < 800 && MAX_LENGTH_RE.test(reply));
}

export const TRANSIENT_FAILURE_RE =
  /^(?:something went wrong(?: while generating (?:the )?response)?|there was (?:an error|a problem) generating (?:the |your )?response|we encountered an error|unable to generate (?:a )?response)(?:\b|$)/i;

/** ChatGPT UI/service banners are transport failures, never assistant replies. */
export function isTransientFailureReply(reply) {
  const text = String(reply || "").replace(/\s+/g, " ").trim();
  if (!text || text.length >= 1_200) return false;
  if (/help\.openai\.com/i.test(text) && /wrong|error|problem|try again/i.test(text)) return true;
  return TRANSIENT_FAILURE_RE.test(text);
}

// ---- 3/4. Rate-limit detection + wait parsing -------------------------------

export const RATE_LIMIT_RE =
  /(you(?:'|’)re making requests too quickly|too many requests|please slow down|(?:your|this|the) request (?:was|has been|is) rate[- ]limited|you (?:are|have been) rate[- ]limited|usage limit (?:has been )?reached|reached (?:your|the|our|this) .*limit|reached the maximum number of messages|hit (?:your|the|our) .*limit|try again (?:in|after|at|later)|available again (?:in|after|at)|come back (?:in|after|at)|limit (?:will )?resets? (?:in|after|at))/i;

const RATE_LIMIT_BACKOFF_DEFAULT_MS = Number(process.env.RATE_LIMIT_BACKOFF_MS || 90_000);
const RATE_LIMIT_MIN_BACKOFF_DEFAULT_MS = Number(
  process.env.RATE_LIMIT_MIN_BACKOFF_MS || 30_000
);
const RATE_LIMIT_MAX_BACKOFF_DEFAULT_MS = Number(
  process.env.RATE_LIMIT_MAX_BACKOFF_MS || 15 * 60_000
);

function clampRateLimitBackoffMs(
  value,
  fallbackMs = RATE_LIMIT_BACKOFF_DEFAULT_MS
) {
  const fallback = Number.isFinite(Number(fallbackMs)) && Number(fallbackMs) > 0
    ? Number(fallbackMs)
    : RATE_LIMIT_BACKOFF_DEFAULT_MS;
  const ms = Number.isFinite(Number(value)) && Number(value) > 0
    ? Number(value)
    : fallback;
  const min = Math.max(1_000, RATE_LIMIT_MIN_BACKOFF_DEFAULT_MS);
  const max = Math.max(min, RATE_LIMIT_MAX_BACKOFF_DEFAULT_MS);
  return Math.min(Math.max(ms, min), max);
}

function absoluteBackoffMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const timestamp =
      numeric > 10_000_000_000
        ? numeric
        : numeric > 1_000_000_000
          ? numeric * 1000
          : 0;
    if (timestamp > now) return timestamp - now;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > now ? parsed - now : 0;
}

function clockBackoffMs(text, now = Date.now()) {
  const match = String(text || "").match(
    /(?:try again|available again|come back|resets?)\s+(?:after|at)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i
  );
  if (!match) return 0;
  const current = new Date(now);
  let hour = Number(match[1]) % 12;
  if (/^p/i.test(match[3])) hour += 12;
  const reset = new Date(current);
  reset.setHours(hour, Number(match[2] || 0), 0, 0);
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
  return reset.getTime() - now;
}

function headerValue(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  return match ? String(match[1] ?? "") : "";
}

function responseMessage(body) {
  if (typeof body === "string") {
    try {
      return responseMessage(JSON.parse(body));
    } catch {
      return body.replace(/\s+/g, " ").trim().slice(0, 500);
    }
  }
  if (!body || typeof body !== "object") return "";
  const values = [
    body.message,
    body.detail,
    body.error?.message,
    body.error?.detail,
    body.detail?.message,
    body.detail?.detail,
  ];
  const direct = values.find((value) => typeof value === "string" && value.trim());
  if (direct) return direct.replace(/\s+/g, " ").trim().slice(0, 500);
  try {
    return JSON.stringify(body).replace(/\s+/g, " ").slice(0, 500);
  } catch {
    return "";
  }
}

function responseBackoffMs(body, now = Date.now()) {
  let parsed = body;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return 0;
    }
  }
  if (!parsed || typeof parsed !== "object") return 0;
  const values = [
    parsed.retry_after_ms,
    parsed.retryAfterMs,
    parsed.error?.retry_after_ms,
    parsed.error?.retryAfterMs,
    parsed.detail?.retry_after_ms,
  ];
  const milliseconds = values
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0);
  if (milliseconds) return milliseconds;
  const seconds = [
    parsed.retry_after,
    parsed.retryAfter,
    parsed.error?.retry_after,
    parsed.error?.retryAfter,
    parsed.detail?.retry_after,
  ]
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0);
  if (seconds) return seconds * 1000;
  return [
    parsed.reset_at,
    parsed.resetAt,
    parsed.error?.reset_at,
    parsed.error?.resetAt,
    parsed.detail?.reset_at,
  ]
    .map((value) => absoluteBackoffMs(value, now))
    .find((value) => value > 0) || 0;
}

/**
 * Parse "try again in N minutes/seconds" from a rate-limit banner.
 * Falls back to RATE_LIMIT_BACKOFF_MS. Clamped to [30s, 15min] with a 5s buffer.
 */
export function parseRateLimitBackoffMs(
  reply,
  fallbackMs = RATE_LIMIT_BACKOFF_DEFAULT_MS,
  now = Date.now()
) {
  const text = String(reply || "");
  const m =
    text.match(
      /(?:try again|wait|retry|come back)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i
    ) ||
    text.match(/\bin\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i);
  if (!m) {
    const absolute = clockBackoffMs(text, now);
    return clampRateLimitBackoffMs(absolute, fallbackMs);
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) {
    return clampRateLimitBackoffMs(0, fallbackMs);
  }
  const unit = m[2].toLowerCase();
  let ms;
  if (unit.startsWith("h")) ms = n * 3_600_000;
  else if (unit.startsWith("m")) ms = n * 60_000;
  else ms = n * 1000;
  // Small buffer so we don't retry the instant the banner says we're clear.
  ms += 5_000;
  return clampRateLimitBackoffMs(ms, fallbackMs);
}

export function isRateLimitReply(reply) {
  if (!reply || reply.length >= 1_000 || !RATE_LIMIT_RE.test(reply)) return false;
  const text = String(reply);
  if (
    /(you(?:'|’)re making requests too quickly|too many requests|please slow down|(?:your|this|the) request (?:was|has been|is) rate[- ]limited|you (?:are|have been) rate[- ]limited|usage limit (?:has been )?reached|reached (?:your|the|our|this) .*limit|reached the maximum number of messages|hit (?:your|the|our) .*limit|limit (?:will )?resets?)/i.test(
      text
    )
  ) {
    return true;
  }
  return /(?:try again|available again|come back)\s+(?:in\s+\d|after\s+\d|at\s+\d)/i.test(
    text
  );
}

export function rateLimitResponseInfo(
  { status = 0, headers = {}, body = "" } = {},
  fallbackMs = RATE_LIMIT_BACKOFF_DEFAULT_MS,
  now = Date.now()
) {
  const message = responseMessage(body);
  const raw = typeof body === "string" ? body : (() => {
    try {
      return JSON.stringify(body);
    } catch {
      return "";
    }
  })();
  const codeMatch =
    /\b(?:rate[_-]?limit(?:ed|_exceeded)?|too_many_requests|usage_limit(?:_reached)?|message_cap(?:_exceeded)?|model_cap(?:_exceeded)?|quota_exceeded)\b/i.test(
      raw
    );
  if (Number(status) !== 429 && !codeMatch && !isRateLimitReply(message)) {
    return null;
  }

  const retryAfterMs = Number(headerValue(headers, "retry-after-ms"));
  const retryAfter = headerValue(headers, "retry-after");
  const retryAfterNumber = Number(retryAfter);
  const headerBackoff =
    Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : Number.isFinite(retryAfterNumber) && retryAfterNumber > 0
        ? retryAfterNumber * 1000
        : absoluteBackoffMs(retryAfter, now) ||
          absoluteBackoffMs(
            headerValue(headers, "x-ratelimit-reset-ms") ||
              headerValue(headers, "x-ratelimit-reset"),
            now
          );
  const bodyBackoff = responseBackoffMs(body, now);
  const textBackoff = parseRateLimitBackoffMs(message, fallbackMs, now);
  return {
    backoffMs: clampRateLimitBackoffMs(
      headerBackoff || bodyBackoff || textBackoff,
      fallbackMs
    ),
    message: message || "ChatGPT rate limit reached",
    status: Number(status) || null,
    source:
      headerBackoff > 0
        ? "response-header"
        : bodyBackoff > 0
          ? "response-body"
          : message
            ? "response-message"
            : "http-status",
  };
}

// ---- 5. Compact tool preamble -----------------------------------------------
// OpenCode ships 8 MCP servers with multi-KB descriptions. Truncating each
// description and collapsing JSON Schema to "name:type" keeps the opening
// composer prompt small enough that ChatGPT still pays attention to the
// TOOL_CALL protocol.

export const TOOL_DESC_MAX = Number(process.env.TOOL_DESC_MAX || 280);
export const TOOL_PREAMBLE_MAX = Number(process.env.TOOL_PREAMBLE_MAX || 12_000);
export const RECOVERY_PROMPT_MAX = 32_000;

function propertyType(value) {
  if (!value || typeof value !== "object") return "any";
  if (Object.prototype.hasOwnProperty.call(value, "const")) return JSON.stringify(value.const);
  if (Array.isArray(value.enum) && value.enum.length > 0 && value.enum.length <= 6) {
    return value.enum.map((item) => JSON.stringify(item)).join("|");
  }
  if (typeof value.type === "string") return value.type;
  if (Array.isArray(value.type)) return value.type.join("|");
  if (value.anyOf || value.oneOf) return "union";
  return "any";
}

function objectSchemaBrief(params, limit = 24) {
  const props = params?.properties;
  if (!props || typeof props !== "object") return "";
  const required = new Set(params.required || []);
  const entries = Object.entries(props);
  const parts = entries
    .slice(0, limit)
    .map(([key, value]) => `${required.has(key) ? key + "*" : key}:${propertyType(value)}`);
  if (!parts.length) return "";
  const more = entries.length > limit ? `, …+${entries.length - limit}` : "";
  return `{${parts.join(", ")}${more}}`;
}

/** Collapse a JSON Schema parameters object to `args={name*:type, ...}`. */
export function schemaBrief(params) {
  if (!params || typeof params !== "object") return "";
  const variants = Array.isArray(params.oneOf)
    ? params.oneOf
    : Array.isArray(params.anyOf)
      ? params.anyOf
      : [];
  const output = variants.length
    ? ` args=oneOf(${variants
        .slice(0, 8)
        .map((variant) => objectSchemaBrief(variant, 16))
        .filter(Boolean)
        .join(" | ")}${variants.length > 8 ? ` | …+${variants.length - 8}` : ""})`
    : objectSchemaBrief(params)
      ? ` args=${objectSchemaBrief(params)}`
      : "";
  return output.length > 700 ? output.slice(0, 697) + "…" : output;
}

export function toolsToPreamble(tools, priorityNames = []) {
  const priority = new Map(
    [...new Set([...priorityNames, "tui_visual_test"].filter(Boolean))].map((name, index) => [name, index])
  );
  const ordered = [...(tools || [])]
    .map((tool, index) => ({ tool, index }))
    .sort((left, right) => {
      const leftName = left.tool?.function?.name || left.tool?.name;
      const rightName = right.tool?.function?.name || right.tool?.name;
      const leftRank = priority.get(leftName) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = priority.get(rightName) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.index - right.index;
    })
    .map((item) => item.tool);
  const lines = [];
  for (const t of ordered) {
    const fn = t?.function || t;
    if (!fn?.name) continue;
    const desc = String(fn.description || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, TOOL_DESC_MAX);
    lines.push(`- ${fn.name}: ${desc}${schemaBrief(fn.parameters)}`);
  }
  let out = lines.join("\n");
  if (out.length > TOOL_PREAMBLE_MAX) {
    out = out.slice(0, TOOL_PREAMBLE_MAX).replace(/\n[^\n]*$/, "") + "\n… (tool list truncated)";
  }
  return out;
}

export function tuiVisualReviewReady(messages) {
  let latest;
  for (const message of messages || []) {
    if (message?.role !== "tool" || message?.name !== "tui_visual_test") continue;
    const match = contentToText(message.content).match(
      /(?:^|\n)tui_visual_review_ready:\s*(true|false)(?:\n|$)/i
    );
    if (match) latest = match[1].toLowerCase() === "true";
  }
  return latest;
}

export function toolProtocolPreamble(tools, toolChoice, policy = null) {
  const required = policy?.required === true;
  const requiredBlock = required
    ? "\n\nCRITICAL: an OpenCode tool request is REQUIRED for this turn" +
      (policy?.expectedTool ? `; call exactly ${policy.expectedTool}` : "; call any one advertised tool") +
      ". Do not answer from ChatGPT's sandbox, refuse, explain, or say tools are unavailable. " +
      "Reply only with one valid SHELL_CALL envelope or one TOOL_CALL line."
    : "";
  const noneBlock =
    policy?.mode === "none"
      ? "\n\nCRITICAL: tool calls are disabled for this turn. Reply with normal text only; do not emit TOOL_CALL or SHELL_CALL."
      : "";
  const hasBash = (tools || []).some((t) => {
    const n = String(t?.function?.name || t?.name || "").toLowerCase();
    return n === "bash" || n === "shell" || n === "run_terminal_cmd";
  });
  const bashBlock = hasBash
    ? "\n\nFor bash/shell, do NOT put the command inside TOOL_CALL JSON. Use this exact line-based envelope so raw shell quotes, " +
      "percent signs, and backslashes remain intact:\n" +
      "SHELL_CALL: bash\n" +
      "PURPOSE: Brief user-facing reason for this command.\n" +
      "WORKDIR: /root\n" +
      "TIMEOUT_MS: 120000\n" +
      "COMMAND:\n" +
      "<raw shell command>\n" +
      "WORKDIR and TIMEOUT_MS are optional. COMMAND must be the final field; all remaining lines are raw shell text. " +
      "The command has a hard limit of about 4096 characters."
    : "";
  const writeBlock = hasFileWriteTool(tools)
    ? "\n\nLOCAL FILES RULE: When the user asks to create/build/write an app, project, or files, you MUST call write/edit/bash " +
      "tools so files land on THEIR machine. Never invent a ChatGPT sandbox/container/canvas deliverable. " +
      "Never say 'Files are located at …', 'Download the …', or claim you already created files unless a prior [tool result] " +
      "proves the write succeeded. Your ChatGPT sandbox is NOT the user's disk."
    : "";
  const hasTuiVisual = (tools || []).some((tool) => {
    const name = String(tool?.function?.name || tool?.name || "");
    return name === "tui_visual_test";
  });
  const tuiVisualBlock = hasTuiVisual
    ? "\n\nTUI VISUAL RULE: tui_visual_test is an OpenCode TOOL_CALL, never a shell command. For TUI creation, " +
      "material changes, design review, or release-readiness claims, call it proactively. Inspect its PNGs and continue " +
      "until the latest result says `tui_visual_review_ready: true`; a text PTY dump is not visual proof. Exercise keyboard, " +
      "mouse when advertised, resizing, dark/light palettes, and the complete WSL/PowerShell/cmd matrix. " +
      "Use start with action/target/command/cwd/cols/rows/theme; step with action/session_id/events; and matrix with " +
      "action/targets/commands/cwd/sizes/themes plus either scenario_name or an inline scenario array. Event shapes are " +
      "{type:'key',key:'ArrowDown',repeat?:n}, {type:'text'|'paste',text}, {type:'mouse',action:'click'|'down'|'up'|'move'|'scroll',row,col}, " +
      "{type:'click_text',text}, {type:'resize',cols,rows}, {type:'wait',until:{contains|not_contains|matches|stable|exited|exit_code}}, " +
      "and {type:'assert',condition:{...}}."
    : "";
  return (
    "[system]: You are wired into OpenCode, an automated coding agent harness. This conversation is " +
    "machine-to-machine: your reply is parsed by a program, not read directly by a human.\n\n" +
    "The harness (not you) can execute tools on the user's machine. For non-shell tools, request execution with one " +
    "plain-text line in this exact format:\n" +
    'TOOL_CALL: {"name":"<tool_name>","arguments":{ ... },"purpose":"<brief user-facing explanation>"}\n' +
    'Example: TOOL_CALL: {"name":"read","arguments":{"filePath":"/root/project/package.json"},"purpose":"Read the project manifest before proposing changes."}\n' +
    "For bash, shell, or run_terminal_cmd, use the SHELL_CALL envelope described below instead of JSON.\n\n" +
    "You never execute anything yourself — you only WRITE the request line. The harness parses it, runs the tool on " +
    "the user's machine, and posts the output back as a message starting with [tool result. This works even though " +
    "you cannot run commands: the harness does the running. Therefore:\n" +
    "- Never refuse a tool call as impossible or say the tool isn't available; it is available to the harness.\n" +
    "- Never tell the user to run commands themselves.\n" +
    "- Never answer questions about the user's machine, OS, or files from your own knowledge or environment; " +
    "get a tool result first. Your own sandbox is NOT the user's machine.\n" +
    "- Never invoke ChatGPT-native tools such as container.exec, file_search, python, browser, or web search. " +
    "They run outside OpenCode and cannot inspect the user's host. Request the matching OpenCode tool instead.\n" +
    "- Never build apps/files inside ChatGPT's container/sandbox and offer a Download — always TOOL_CALL write/bash on the user host.\n\n" +
    "Available tools (name: description, then compact args schema):\n" +
    toolsToPreamble(tools, policy?.expectedTool ? [policy.expectedTool] : []) +
    "\n\n" +
    "Rules:\n" +
    "- To request a tool: reply with ONLY one TOOL_CALL line or one SHELL_CALL envelope. No other words or code fences.\n" +
    "- Include `purpose` as one short sentence explaining to the user why this specific call is needed. " +
    "Do not include hidden reasoning, secrets, or generic filler.\n" +
    "- Arguments must be valid JSON matching the tool's schema. One tool call per reply.\n" +
    '- Any " inside a JSON string value must be escaped as \\". Prefer shell single quotes so bash commands need no inner doubles.\n' +
    '- If an argument is itself a JSON string (e.g. replacements_json), escape every inner quote as \\" ' +
    'and wrap arrays as "[{\\"find\\":...}]". Unescaped nested quotes break the TOOL_CALL line.\n' +
    "- Keep bash commands under ~4096 chars and put their raw text after the final COMMAND field in a SHELL_CALL envelope.\n" +
    "- After a [tool result ...] message: either send another SHELL_CALL / TOOL_CALL request, or give the user their final answer " +
    "as normal text (without a call envelope)." +
    bashBlock +
    writeBlock +
    tuiVisualBlock +
    requiredBlock +
    noneBlock
  );
}

function clipHeadTail(value, max) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  const marker = "\n… [compacted for recovery] …\n";
  const side = Math.max(0, Math.floor((max - marker.length) / 2));
  return text.slice(0, side) + marker + text.slice(-side);
}

/**
 * Build a bounded fresh-chat recovery packet without replaying an entire
 * OpenCode transcript. Grammar, current intent, recent execution evidence,
 * and the rejection are retained in that order.
 */
export function buildCompactRecoveryPrompt(
  messages,
  tools,
  toolChoice,
  { nudge = "", rejectedReply = "", error = "", policy = null } = {}
) {
  const protocol = clipHeadTail(toolProtocolPreamble(tools, toolChoice, policy), 10_000);
  const users = (messages || [])
    .filter((message) => message?.role === "user")
    .slice(-2)
    .map((message) => contentToText(message.content).trim())
    .filter(Boolean);
  // Reserve most of the intent budget for the newest user turn. Clipping the
  // two turns only after concatenation can discard the beginning of the
  // current request when the previous turn is unusually large.
  const intent =
    users.length === 1
      ? `[current user request]: ${clipHeadTail(users[0], 10_000)}`
      : users.length > 1
        ? `[prior user context]: ${clipHeadTail(users[0], 3_500)}\n\n` +
          `[current user request]: ${clipHeadTail(users[1], 6_500)}`
        : "";
  const ledger = buildExecutionLedger(messages)
    .completed.slice(-12)
    .map((item) => {
      const args = clipHeadTail(item.args, 320);
      const result = clipHeadTail(item.content, 720);
      return (
        `[tool ${item.name || "unknown"}; result=${item.success ? "success" : "failed"}; mutation=${item.mutated ? "yes" : "no"}]` +
        (args ? `\nrequest: ${args}` : "") +
        (result ? `\nresult: ${result}` : "")
      );
    })
    .join("\n\n");
  const rejection = clipHeadTail(
    [
      rejectedReply ? `[rejected assistant reply]: ${rejectedReply}` : "",
      error ? `[harness error]: ${error}` : "",
      nudge,
    ]
      .filter(Boolean)
      .join("\n\n"),
    2_000
  );
  const prompt = [
    protocol,
    intent ? `[current intent]\n${intent}` : "",
    ledger ? `[recent execution ledger]\n${clipHeadTail(ledger, 8_000)}` : "",
    rejection ? `[recovery instruction]\n${rejection}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return clipHeadTail(prompt, RECOVERY_PROMPT_MAX);
}

/** True when the latest user turn asks for a Google Doc action. */
export function userAskedForGoogleDoc(messages) {
  if (isPlanMode(messages)) return false;
  const lastUser = [...(messages || [])].reverse().find((m) => m?.role === "user");
  if (!lastUser) return false;
  const t = contentToText(lastUser.content);
  if (/\bdocs\.google\.com\/document\b/i.test(t)) return true;
  const action = /\b(create|make|write|edit|format|update|append|insert|replace|rewrite|restructure|share)\b/i;
  return action.test(t) && /\b(?:new\s+)?google\s*doc(?:ument)?s?\b/i.test(t);
}

/** True when tools include a bash/shell execution tool. */
export function hasBashTool(tools) {
  return (tools || []).some((t) => {
    const n = String(t?.function?.name || t?.name || "").toLowerCase();
    return n === "bash" || n === "shell" || n === "run_terminal_cmd";
  });
}

/**
 * Detect invented "this environment can't SSH / has no keys / port refused"
 * excuses. These are ChatGPT sandbox hallucinations — OpenCode's bash tool
 * runs on the real WSL host which already has SSH keys to netcup.
 */
export function isFakeEnvironmentBlock(reply) {
  const t = String(reply || "");
  if (!t.trim()) return false;
  const mentionsLocalPath =
    /(?:[a-z]:[\\/]|~\/|\.\.?\/|\/(?:root|home|mnt|tmp|var|etc|opt|srv|workspace)(?:\/|\b))/i.test(
      t
    );
  const claimsLocalMissing =
    mentionsLocalPath &&
    /\b(?:not\s+mounted|does\s+not\s+exist|doesn'?t\s+exist|no\s+such\s+(?:file|directory)|not\s+accessible|is\s+unavailable|cannot\s+access|can'?t\s+access)\b/i.test(
      t
    );
  const claimsBlocked =
    /\b(port\s*22|ssh).{0,40}\b(refused|blocked|unreachable|timed?\s*out|no route)\b/i.test(t) ||
    /\b(actively\s+refused|connection\s+refused).{0,40}\b(22|ssh)\b/i.test(t) ||
    /\b(?:no|without|missing|unavailable)\s+(?:usable\s+|working\s+)?(?:ssh\s*key|ssh\s*agent|tailscale(?:\s+credentials?)?|tailnet(?:\s+access)?|credentials)\b/i.test(
      t
    ) ||
    /\b(?:ssh\s*key|ssh\s*agent|tailscale(?:\s+credentials?)?|tailnet(?:\s+access)?|credentials)\s+(?:is|are|was|were)?\s*(?:not\s+available|unavailable|missing|not\s+configured|not\s+accessible)\b/i.test(
      t
    ) ||
    /\b(this|current)\s+(environment|session|sandbox|chat).{0,60}\b(can'?t|cannot|unable|no access|blocked|refused)\b/i.test(
      t
    ) ||
    /\b(can'?t|cannot|unable to)\s+(ssh|reach|connect|access).{0,40}\b(server|host|152\.|netcup|remote)\b/i.test(
      t
    ) ||
    /\brequires?\s+temporary\s+(non-interactive\s+)?ssh\b/i.test(t) ||
    /\bfrom this environment\b/i.test(t) ||
    claimsLocalMissing;
  return claimsBlocked;
}

/**
 * Keep action guards focused on the user's request framing, not commands and
 * operational phrases inside a pasted Markdown handoff. The model still sees
 * the full message; only heuristic safety triggers use this conservative view.
 */
export function latestUserIntentText(messages) {
  const lastUser = [...(messages || [])].reverse().find((m) => m?.role === "user");
  if (!lastUser) return "";
  const text = contentToText(lastUser.content);
  const heading = text.search(/^[ \t]*#{1,6}[ \t]+\S/m);
  if (heading < 0) return text;
  const lead = text.slice(0, heading).trim();
  if (lead) return lead;
  return text.slice(heading).split(/\r?\n/, 1)[0] || "";
}

/** User asked to probe/test a remote host / SSH / Discord delivery / services. */
export function userAskedForRemoteProbe(messages) {
  if (isPlanMode(messages)) return false;
  const t = latestUserIntentText(messages);
  if (!t) return false;
  const target =
    "(?:ssh|152\\.53\\.|netcup|tailscale|tailnet|wallos|discord\\s*dm|remote\\s+(?:host|server)|supabase-01)";
  const action =
    "(?:test|probe|verify|check|inspect|diagnose|troubleshoot|connect|log\\s+in|query|restart|deploy|update|fix|run|execute|show|get\\s+(?:the\\s+)?status)";
  return (
    new RegExp(`\\b${action}\\b.{0,100}\\b${target}\\b`, "i").test(t) ||
    new RegExp(`\\b${target}\\b.{0,100}\\b${action}\\b`, "i").test(t) ||
    /\bssh\s+(?:-[^\s]+\s+)*(?:root@)?(?:152\.53\.|[a-z0-9.-]+\.[a-z]{2,})/i.test(t) ||
    /\b(?:is|are)\b.{0,50}\b(?:wallos|netcup|supabase-01|remote\s+(?:host|server))\b.{0,50}\b(?:up|running|healthy|reachable|online)\b/i.test(
      t
    )
  );
}

/** True when tools can create/modify files on the user host. */
export function hasFileWriteTool(tools) {
  return (tools || []).some((t) => {
    const n = String(t?.function?.name || t?.name || "").toLowerCase();
    return (
      n === "bash" ||
      n === "shell" ||
      n === "run_terminal_cmd" ||
      n === "write" ||
      n === "edit" ||
      n === "apply_patch" ||
      n === "str_replace" ||
      n.includes("write") ||
      n.includes("edit")
    );
  });
}

/** User asked to create/build/write local code, an app, or project files. */
export function userAskedToBuildLocal(messages) {
  if (isPlanMode(messages)) return false;
  const t = latestUserIntentText(messages);
  if (!t) return false;
  return (
    /\b(create|build|make|write|scaffold|implement|generate|spin\s*up)\b.{0,60}\b(app|application|project|website|webpage|page|script|todo|component|api|server|site)\b/i.test(
      t
    ) ||
    /\b(add|implement|fix|refactor|update)\b.{0,40}\b(file|code|feature|function|module)\b/i.test(
      t
    ) ||
    /\b(to-?do|todo)\s+list\b/i.test(t)
  );
}

/**
 * User asked for a plan / design first — not an immediate tool-driven mutation.
 * Uses latestUserIntentText so pasted handoff bodies do not false-trigger.
 */
export function userAskedToPlan(messages) {
  if (isPlanMode(messages)) return true;
  const t = latestUserIntentText(messages);
  if (!t) return false;
  return (
    /\blet'?s\s+plan\b/i.test(t) ||
    /\bplan\s+this\s+first\b/i.test(t) ||
    /\bplan\s+first\b/i.test(t) ||
    /\bdon'?t\s+implement\s+yet\b/i.test(t) ||
    /\bdo\s+not\s+implement\b/i.test(t) ||
    /\bdesign\s+the\s+approach\b/i.test(t) ||
    /\bpropose\s+a\s+plan\b/i.test(t) ||
    /\bplanning\s+only\b/i.test(t) ||
    /\bjust\s+plan\b/i.test(t)
  );
}

/**
 * Hard "I cannot use tools" refusals — still force a nudge even on plan-only asks.
 * Softer phrases like "not reachable from this environment" in a written plan
 * are evaluated separately from ordinary auto-mode text replies.
 */
export function isHardToolRefusal(reply) {
  const t = String(reply || "");
  if (!t.trim()) return false;
  return (
    /\btools? (?:are|is)n'?t available\b/i.test(t) ||
    /\bno (?:bash|shell|mcp|tool) (?:tool|access)\b/i.test(t) ||
    /\b(?:i )?(?:can(?:no|')t|cannot|am unable|'m unable|don'?t have)(?: the| any| direct)? (?:access to )?(?:bash|shell|mcp|harness|tools?)\b/i.test(
      t
    )
  );
}

/** Prior turns already include a harness tool result (any — may have failed). */
export function messagesHaveToolResult(messages) {
  return (messages || []).some((m) => {
    if (!m) return false;
    if (m.role === "tool" || m.role === "function") return true;
    const text = contentToText(m.content);
    return /^\[tool result/i.test(text.trim());
  });
}

function isMutationToolName(name) {
  const n = String(name || "").toLowerCase();
  return (
    n === "write" ||
    n === "edit" ||
    n === "apply_patch" ||
    n === "str_replace" ||
    n.includes("write") ||
    n.includes("edit")
  );
}

/** True when a bash/shell command looks like it mutates the filesystem. */
export function bashCommandMutates(command) {
  const c = String(command || "");
  if (!c.trim()) return false;
  if (
    /\b(mkdir|rm|rmdir|mv|cp|tee|dd|chmod|chown|chgrp|touch|install|truncate|ln|unlink|shred)\b/i.test(
      c
    )
  ) {
    return true;
  }
  if (/\b(npm\s+i(nstall)?|pnpm\s+i|yarn\s+add|pip3?\s+install|cargo\s+install)\b/i.test(c)) {
    return true;
  }
  // Redirection / heredoc writes
  if (/>{1,2}/.test(c) || /<<\s*['"]?\w+/.test(c) || /\btee\b/i.test(c)) return true;
  if (/\bsed\s+-i\b|\bperl\s+-i\b|\bgawk\s+-i\b/i.test(c)) return true;
  return false;
}

function toolArgsMutate(name, args) {
  const n = String(name || "").toLowerCase();
  if (isMutationToolName(n)) return true;
  if (n === "bash" || n === "shell" || n === "run_terminal_cmd") {
    let obj = args;
    if (typeof obj === "string") {
      try {
        obj = JSON.parse(obj);
      } catch {
        return bashCommandMutates(obj);
      }
    }
    return bashCommandMutates(obj?.command);
  }
  return false;
}

/**
 * Heuristic: did this tool result indicate success?
 * Failed bash (exit: 1, ENOENT, …) must NOT unlock "I created the app" claims.
 */
export function toolResultIndicatesSuccess(content) {
  const t = contentToText(content);
  if (!String(t || "").trim()) return false;
  if (/\bexit(?:_code)?\s*[:=]\s*[1-9]\d*\b/i.test(t)) return false;
  if (/\bexit:\s*[1-9]/i.test(t)) return false;
  if (
    /\b(ENOENT|EACCES|EPERM|command not found|Permission denied|numeric argument required)\b/i.test(
      t
    )
  ) {
    return false;
  }
  if (/^\s*Error\b/im.test(t)) return false;
  if (/\bstatus:\s*error\b/i.test(t)) return false;
  if (/\b(tool|command|operation)\s+failed\b/i.test(t)) return false;
  if (/\bfailed\b/i.test(t) && /\b(error|exit|command|spawn)\b/i.test(t)) return false;
  return true;
}

/**
 * Execution ledger: tool_call_id → request + matching result + success/mutation.
 * Build success claims require a successful *mutating* tool (not hostname/ls).
 */
export function buildExecutionLedger(messages) {
  /** @type {Map<string, { name: string, args: string }>} */
  const pending = new Map();
  /** @type {Array<{ id: string, name: string, args: string, content: string, success: boolean, mutated: boolean }>} */
  const completed = [];

  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === "assistant") {
      for (const tc of m.tool_calls || []) {
        const id = tc?.id;
        if (!id) continue;
        pending.set(id, {
          name: String(tc?.function?.name || tc?.name || ""),
          args: String(tc?.function?.arguments || ""),
        });
      }
    }
    if (m.role === "tool" || m.role === "function") {
      const id = m.tool_call_id || m.id || "";
      const req = pending.get(id) || {
        name: String(m.name || ""),
        args: "",
      };
      const content = contentToText(m.content);
      const success = toolResultIndicatesSuccess(content);
      const mutated = toolArgsMutate(req.name, req.args);
      completed.push({
        id,
        name: req.name,
        args: req.args,
        content,
        success,
        mutated,
      });
      if (id) pending.delete(id);
    }
    // Flattened transcript form from messagesToPrompt deltas
    const flat = contentToText(m.content);
    if (/^\[tool result for /i.test(flat.trim())) {
      const nameMatch = flat.match(/^\[tool result for ([^\]]+)\]:\s*([\s\S]*)$/i);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        const content = nameMatch[2];
        completed.push({
          id: "",
          name,
          args: "",
          content,
          success: toolResultIndicatesSuccess(content),
          // Flat form has no args — treat write-named tools as mutation, bash as not.
          mutated: isMutationToolName(name),
        });
      }
    }
  }

  const successful = completed.filter((c) => c.success);
  const successfulMutations = successful.filter((c) => c.mutated);
  return {
    completed,
    successful,
    successfulMutations,
    hasSuccessfulTool: successful.length > 0,
    hasSuccessfulWrite: successfulMutations.length > 0,
    hasSuccessfulMutation: successfulMutations.length > 0,
  };
}

/** True when at least one tool result in the transcript indicates success. */
export function messagesHaveSuccessfulToolResult(messages) {
  return buildExecutionLedger(messages).hasSuccessfulTool;
}

/**
 * Allow "I created the app at /path" only after a successful mutating tool
 * (write/edit/apply_patch, or bash that clearly writes — not hostname/ls).
 */
export function canClaimLocalBuildSuccess(messages) {
  return buildExecutionLedger(messages).hasSuccessfulMutation;
}

/**
 * Detect ChatGPT inventing a sandbox/container deliverable instead of writing
 * files on the user's machine via OpenCode tools.
 */
export function isFakeLocalFileDeliverable(reply, { userAskedBuild = false } = {}) {
  const t = String(reply || "");
  if (!t.trim()) return false;
  if (/\bDownload the\b/i.test(t)) return true;
  if (/\bfiles? (?:are )?(?:located|saved|written) (?:at|to|in)\b/i.test(t)) return true;
  if (
    /\b(?:created|wrote|saved|built|scaffolded).{0,100}\/(?:root|home|tmp|Users|mnt|var)\//i.test(t)
  ) {
    return true;
  }
  if (
    /\b(?:in|on|inside)\s+(?:my|the|this|chatgpt(?:'s)?|openai(?:'s)?)\s+(?:sandbox|container|canvas|artifact|environment)\b/i.test(
      t
    )
  ) {
    return true;
  }
  if (
    /\b(?:chatgpt|this)\s+(?:sandbox|container|machine|environment)\b.{0,60}\b(?:created|built|ran|running)\b/i.test(
      t
    )
  ) {
    return true;
  }
  // Completion narrative for a build request with no tool proof in this reply.
  if (
    userAskedBuild &&
    /\b(created|built|implemented|scaffolded|wrote|shipped)\b.{0,80}\b(app|application|project|todo|website|page|files?)\b/i.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

/** True when tools include direct Google Docs creation or its lazy MCP facade. */
export function hasGoogleDocsCreateTool(tools) {
  return (tools || []).some((t) => {
    const n = String(t?.function?.name || t?.name || "");
    return /google-docs_docs_create/i.test(n) || /^docs_create$/i.test(n) || /^mcp_google-docs$/i.test(n);
  });
}

/** True when any direct Google Docs tool or its lazy MCP facade is present. */
export function hasGoogleDocsTool(tools) {
  return (tools || []).some((t) => {
    const n = String(t?.function?.name || t?.name || "");
    return (
      /google-docs_/i.test(n) ||
      /^mcp_google-docs$/i.test(n) ||
      /^docs_(create|get|append|insert|search|batch|list|add_comment|read_comments)/i.test(n)
    );
  });
}

/**
 * Detect replies that dodge Google Docs MCP: local .docx substitutes, or
 * ChatGPT-web "connected apps / Drive connector" advice (wrong product).
 */
export function isFakeGoogleDocsDeliverable(reply) {
  const t = String(reply || "");
  if (!t.trim()) return false;
  const claimsUnavailable =
    /\b(google\s*docs?\s+connector|docs?\s+connector|google\s*docs?\s+(?:mcp|tool|integration)|google\s*drive(?:\/docs)?(?:\s+connector)?).{0,80}(wasn'?t|was not|isn'?t|is not|not)\s+available\b/i.test(
      t
    ) ||
    /\b(wasn'?t|was not|isn'?t|is not|no)\s+(?:Google\s+Docs|Google\s+Drive|Docs|Drive).{0,40}(?:or|\/|,)?.{0,40}(?:connector|available)\b/i.test(
      t
    ) ||
    /\bno Google Docs or Google Drive connector\b/i.test(t) ||
    /\bconnect(?:ed)? apps\b/i.test(t) ||
    /\bChatGPT'?s connected apps\b/i.test(t) ||
    /\bplugin lookup\b/i.test(t) ||
    (/\bauthorization error\b/i.test(t) && /\b(connector|plugin|drive|docs)\b/i.test(t));
  const claimsLocalSub =
    /\b\.docx\b/i.test(t) ||
    /\bgoogle docs?-compatible\b/i.test(t) ||
    /\b(word document|microsoft word)\b/i.test(t) ||
    /\bcreated a (?:local )?(?:word|docx|odt)\b/i.test(t);
  return claimsUnavailable || (claimsLocalSub && /\b(created|wrote|saved|exported)\b/i.test(t));
}

/**
 * Map known failure shapes to short, actionable messages for OpenCode's TUI.
 * Unknown errors pass through (trimmed). Prefer err.flags set by our code.
 */
export function humanizeError(err) {
  if (!err) return "Unknown error";
  const message = sanitizeDiagnosticText(err.message || err);
  if (err.cancelled || /request cancelled/i.test(message)) {
    return "Request cancelled — retry when ready (or POST /cancel cleared a stuck turn)";
  }
  if (err.stalled || /chatgpt stalled/i.test(message)) {
    return "ChatGPT stalled with no progress — cancelled; retry or lower effort (Medium/Instant)";
  }
  if (
    err.mcpMissing ||
    err.toolMissing ||
    err.toolPolicy ||
    err.fakeDeliverable ||
    err.malformedToolCall
  ) {
    return message.slice(0, 300);
  }
  if (err.streamAbandoned) {
    return message || "Stream abandoned — retry without live streaming (LIVE_STREAM=0)";
  }
  if (err.modelSelectionFailed) {
    return message.slice(0, 300);
  }
  if (err.sessionExpired) {
    return "ChatGPT session expired — re-export the native chatgpt-web session.json";
  }
  if (err.rateLimited) {
    const ms = err.backoffMs || 0;
    if (ms > 0) {
      const secs = Math.round(ms / 1000);
      const label = secs >= 90 ? `${Math.round(secs / 60)}m` : `${secs}s`;
      return `ChatGPT rate-limited, retrying in ${label}`;
    }
    return "ChatGPT rate-limited — wait and retry";
  }
  if (err.conversationTooLong) {
    return "ChatGPT conversation hit length cap — started a fresh chat";
  }
  if (err.continuationFailed) {
    return "ChatGPT conversation unavailable — retried in a fresh chat";
  }
  const msg = message;
  if (/session expired|re-export (?:auth\/)?session/i.test(msg)) {
    return "ChatGPT session expired — re-export the native chatgpt-web session.json";
  }
  if (/rate[- ]limited/i.test(msg)) return msg;
  if (/conversation (?:hit length|too long)/i.test(msg)) {
    return "ChatGPT conversation hit length cap — started a fresh chat";
  }
  if (/no usable assistant reply before timeout/i.test(msg)) {
    return "ChatGPT returned no reply before timeout — check session or try again";
  }
  if (/No session file|session file missing/i.test(msg)) {
    return "ChatGPT session file missing — run npm run export-session";
  }
  return msg.slice(0, 300);
}

/** Self-refreshing HTML status dashboard for GET /. */
export function statusPageHtml(status) {
  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const busy = status.busy
    ? `<div class="busy">Busy: <b>${esc(status.busy.kind)}</b> for ${Math.round(
        (status.busy.sinceMs || 0) / 1000
      )}s — ${esc(status.busy.preview || "")}</div>`
    : `<div class="idle">Idle</div>`;
  const cancelBtn = status.busy
    ? `<div style="margin-top:10px">
        <button type="button" id="cancel-btn" style="cursor:pointer;padding:6px 12px;border-radius:6px;border:1px solid color-mix(in srgb,var(--bad) 50%,transparent);background:transparent;color:var(--bad)">
          Cancel stuck request
        </button>
        <span class="muted"> · or <code>curl -X POST http://127.0.0.1:8787/cancel</code></span>
      </div>
      <script>
        document.getElementById("cancel-btn")?.addEventListener("click", async () => {
          const btn = document.getElementById("cancel-btn");
          if (btn) btn.disabled = true;
          try {
            await fetch("/cancel", { method: "POST" });
          } catch (e) {}
          location.reload();
        });
      </script>`
    : "";
  const rl =
    status.rateLimitedForMs > 0
      ? `<div class="warn">Rate-limit backoff: ${Math.round(status.rateLimitedForMs / 1000)}s remaining</div>`
      : "";
  const chats = (status.chats || [])
    .map(
      (c) =>
        `<li><a href="${esc(c.chatUrl)}" target="_blank" rel="noopener">${esc(
          c.chatUrl
        )}</a> · ${c.turns} msgs${c.hadTools ? " · tools" : ""}</li>`
    )
    .join("");
  const recent = (status.recent || [])
    .map((r) => {
      const ago = Math.round((Date.now() - r.ts) / 1000);
      const mark = r.ok ? "✓" : "✗";
      return `<tr><td>${mark}</td><td>${ago}s ago</td><td>${esc(
        r.kind
      )}</td><td>${r.ms}ms</td><td>${r.charsIn}→${r.charsOut}</td><td>${esc(r.error || r.chatUrl || "")}</td></tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta http-equiv="refresh" content="3"/>
<title>Overleaf ChatGPT-Web Sidecar</title>
<style>
  :root { color-scheme: light dark; --bg:#0f1115; --fg:#e8eaed; --muted:#9aa0a6; --ok:#81c995; --warn:#fdd663; --bad:#f28b82; --card:#1a1d24; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --fg:#202124; --muted:#5f6368; --card:#fff; }
  }
  body { margin:0; font:14px/1.45 ui-sans-serif,system-ui,sans-serif; background:var(--bg); color:var(--fg); padding:24px; }
  h1 { font-size:18px; margin:0 0 12px; }
  .card { background:var(--card); border-radius:10px; padding:14px 16px; margin:0 0 14px; }
  .busy { color:var(--warn); } .idle { color:var(--ok); } .warn { color:var(--warn); margin-top:6px; }
  .muted { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td,th { text-align:left; padding:4px 6px; border-bottom:1px solid color-mix(in srgb, var(--fg) 12%, transparent); }
  a { color:inherit; }
  ul { margin:6px 0 0; padding-left:18px; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
</style>
</head><body>
  <h1>Overleaf ChatGPT-Web Sidecar</h1>
  <div class="card">
    ${busy}${cancelBtn}${rl}
    <div class="muted" style="margin-top:8px">
      backend=<code>${esc(status.backend)}</code>
      · persist=<code>${status.persistChat ? "on" : "off"}</code>
      · titles=<code>${status.localTitle ? "local" : "remote"}</code>
      · stream=<code>${status.liveStream ? "on" : "off"}</code>
      · thinking=<code>${status.streamThinking ? "on" : "off"}</code>
      · model=<code>${esc(status.chatModel || "default")}</code>
      · effort=<code>${esc(status.chatEffort || "default")}</code>
      · cooldown=<code>${status.cooldownMs}ms</code>
      · tracked=<code>${status.trackedChats ?? 0}</code>
      · store=<code>${esc(status.storeFile || "memory")}</code>
    </div>
  </div>
  <div class="card">
    <b>Tracked chats</b>
    ${chats ? `<ul>${chats}</ul>` : `<div class="muted">none</div>`}
  </div>
  <div class="card">
    <b>Recent requests</b>
    ${
      recent
        ? `<table><thead><tr><th></th><th>when</th><th>kind</th><th>ms</th><th>chars</th><th>detail</th></tr></thead><tbody>${recent}</tbody></table>`
        : `<div class="muted">none yet</div>`
    }
  </div>
  <div class="muted">Auto-refreshes every 3s · <a href="/health">/health</a> JSON · POST <a href="/cancel">/cancel</a> aborts the in-flight turn</div>
</body></html>`;
}

export { flag };
