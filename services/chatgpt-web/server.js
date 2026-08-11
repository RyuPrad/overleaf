// server.js
// Local HTTP server exposing your logged-in ChatGPT as an API.
//
// Routes:
//   POST /v1/chat/completions   OpenAI-compatible (messages[], optional stream)
//   POST /chat                  Simple ({ message } -> { reply })
//   GET  /health                liveness probe
//
// One request runs at a time (ChatGPT's session isn't safe to drive
// concurrently). A simple promise-chain queue serializes them.
//
// DRY_RUN=1 (default) returns what the server WOULD send without touching
// ChatGPT — safe smoke testing. Set DRY_RUN=0 to actually send.

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

import "./env.js";

import { chatAPI } from "./backends/api-backend.js";
import { chatUI } from "./backends/playwright-backend.js";
import { closeSharedSession, resetSharedSession } from "./session.js";
import {
  findConversation,
  findConversationByKey,
  findQuarantinedRecoveryConversation,
  findRecoveryConversation,
  rememberConversation,
  trackedConversations,
  listConversations,
  rememberConversationRecovery,
  rememberConversationPendingTurn,
  forgetConversation,
  forgetConversationByKey,
  STORE_ENABLED,
  STORE_FILE,
} from "./conversation-store.js";
import {
  parseToolCallsStrict,
  malformedToolNudge,
  formatToolCallForPrompt,
} from "./tool-call-parse.js";
import { idempotencyKeyFromRequest, beginIdempotent } from "./idempotency.js";
import { readRequestJson } from "./http-body.js";
import {
  resolveToolUsePolicy,
  toolCallPolicyError,
} from "./tool-use-policy.js";
import { debugLog } from "./debug-log.js";
import { rejectedReplyFromError } from "./rejected-reply.js";
import {
  flag,
  contentToText,
  imagesFromMessages,
  recentUserImages,
  toolProtocolPreamble,
  isTitleGenerationRequest,
  localTitleFromMessages,
  isConversationTooLong,
  isRateLimitReply,
  isTransientFailureReply,
  parseRateLimitBackoffMs,
  humanizeError,
  statusPageHtml,
  userAskedForGoogleDoc,
  hasGoogleDocsCreateTool,
  hasGoogleDocsTool,
  isFakeGoogleDocsDeliverable,
  hasBashTool,
  isFakeEnvironmentBlock,
  userAskedForRemoteProbe,
  hasFileWriteTool,
  userAskedToBuildLocal,
  userAskedToPlan,
  isHardToolRefusal,
  canClaimLocalBuildSuccess,
  isFakeLocalFileDeliverable,
  buildCompactRecoveryPrompt,
  tuiVisualReviewReady,
} from "./request-helpers.js";
import {
  beginBusy,
  endBusy,
  recordRequest,
  setCooldownMs,
  setRateLimitedUntil,
  getStatus,
  setActiveController,
  clearActiveController,
  requestCancel,
  noteRecovery,
} from "./status.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DRY_RUN = flag(process.env.DRY_RUN) !== "0"; // default ON (safe)
// Persist one ChatGPT chat per conversation thread: follow-up OpenCode turns
// are sent into the SAME web chat (only the new messages), instead of opening
// a fresh chat and replaying the whole transcript each request. Set
// PERSIST_CHAT=0 to restore the old fresh-chat-per-request behavior.
const PERSIST_CHAT = flag(process.env.PERSIST_CHAT || "1") !== "0";
// Answer OpenCode's title-agent requests locally (no ChatGPT web send).
const LOCAL_TITLE = flag(process.env.LOCAL_TITLE || "1") !== "0";
// Live-stream guarded deltas into OpenCode's TUI (prefix-extend only).
const LIVE_STREAM = flag(process.env.LIVE_STREAM || "1") !== "0";
// Stream ChatGPT thinking status as OpenAI-compatible reasoning_content.
// (Web UI does not expose full chain-of-thought — only shimmer + "Thought for …".)
const STREAM_THINKING = flag(process.env.STREAM_THINKING || "1") !== "0";
// One native provider request may perform a bounded correction/recovery send.
// Keep those attempts under one wall-clock budget instead of resetting the
// Playwright generation cap for every attempt.
const TURN_HARD_CAP_MS = Math.max(
  1_000,
  Number(process.env.TURN_HARD_CAP_MS || 1_200_000) || 1_200_000,
);
const PRE_SUBMIT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.PRE_SUBMIT_TIMEOUT_MS || 180_000) || 180_000,
);
const TURN_ABORT_GRACE_MS = Math.max(
  100,
  Number(process.env.TURN_ABORT_GRACE_MS || 5_000) || 5_000,
);
const IMAGE_UPLOAD_RETRY_LIMIT = Math.max(
  0,
  Math.min(3, Number(process.env.IMAGE_UPLOAD_RETRY_LIMIT || 2) || 0),
);
const IMAGE_UPLOAD_RETRY_DELAY_MS = Math.max(
  100,
  Math.min(
    60_000,
    Number(process.env.IMAGE_UPLOAD_RETRY_DELAY_MS || 15_000) || 15_000,
  ),
);
// ChatGPT web Intelligence picker defaults (playwright backend).
const CHAT_MODEL = String(process.env.CHAT_MODEL || "GPT-5.6 Sol").trim();
const CHAT_EFFORT = String(process.env.CHAT_EFFORT || "High").trim();
// Default to playwright: the direct api backend almost always 422s (no sentinel
// tokens) but still launches a full Chromium first. OpenCode fires title+main
// in parallel, so that wasted launch made the real reply sit in the queue while
// ChatGPT had already answered in the browser.
const BACKEND = flag(process.env.BACKEND || "playwright").toLowerCase();

/**
 * Map an OpenAI-compatible model id (from OpenCode / curl) onto ChatGPT web
 * Intelligence picker labels. Unknown ids fall back to CHAT_MODEL/CHAT_EFFORT.
 */
export function resolveChatIntelligence(modelId) {
  const id = String(modelId || "gpt")
    .trim()
    .toLowerCase();
  // Explicit effort suffixes
  if (/^(gpt-5\.6-sol|gpt-5\.6\/sol|sol)(-high)?$/.test(id) || id === "gpt") {
    return { model: "GPT-5.6 Sol", effort: "High" };
  }
  if (/^(gpt-5\.6-sol|sol)-medium$/.test(id)) {
    return { model: "GPT-5.6 Sol", effort: "Medium" };
  }
  if (/^(gpt-5\.6-sol|sol)-(instant|low)$/.test(id) || id === "instant") {
    return { model: "GPT-5.6 Sol", effort: "Instant" };
  }
  if (id === "medium") return { model: CHAT_MODEL, effort: "Medium" };
  if (id === "high") return { model: CHAT_MODEL, effort: "High" };
  // Default env (also covers legacy "gpt")
  return { model: CHAT_MODEL, effort: CHAT_EFFORT };
}

// ---- Request serialization + adaptive cooldown -------------------------------
// ChatGPT's UI/backend is single-session; concurrent requests would race on the
// same browser context. Chain promises so each waits for the prior to finish.
// Cooldown starts at COOLDOWN_MS and adapts: shrinks toward COOLDOWN_MIN_MS after
// clean sends, stretches toward COOLDOWN_MAX_MS after a rate-limit hit.
const COOLDOWN_BASE_MS = Number(process.env.COOLDOWN_MS || 5000);
const COOLDOWN_MIN_MS = Number(process.env.COOLDOWN_MIN_MS || 2000);
const COOLDOWN_MAX_MS = Number(process.env.COOLDOWN_MAX_MS || 30_000);
let currentCooldownMs = COOLDOWN_BASE_MS;
setCooldownMs(currentCooldownMs);

function noteCleanSend() {
  // Move halfway toward the floor after each clean reply.
  currentCooldownMs = Math.max(
    COOLDOWN_MIN_MS,
    Math.round((currentCooldownMs + COOLDOWN_MIN_MS) / 2),
  );
  setCooldownMs(currentCooldownMs);
}

function noteRateLimitHit(backoffMs) {
  // Jump toward the ceiling, at least as long as the parsed backoff / 3.
  const stretch = Math.max(
    COOLDOWN_BASE_MS * 2,
    Math.round((backoffMs || 0) / 3),
  );
  currentCooldownMs = Math.min(
    COOLDOWN_MAX_MS,
    Math.max(currentCooldownMs, stretch),
  );
  setCooldownMs(currentCooldownMs);
}

const serialQueue = [];
let activeSerialTask = null;
let serialTaskID = 0;
/** Timestamp when the last serialized task finished (for remaining-cooldown). */
let lastTaskEndedAt = 0;

function finishSerialized(item, error, value) {
  if (item.settled) return;
  item.settled = true;
  clearTimeout(item.abandonTimer);
  item.signal?.removeEventListener("abort", item.onAbort);
  const wasActive = activeSerialTask === item;
  if (wasActive) {
    activeSerialTask = null;
    lastTaskEndedAt = Date.now();
  }
  if (error) item.reject(error);
  else item.resolve(value);
  queueMicrotask(pumpSerialized);
}

async function abandonSerialized(item) {
  item.fenced = true;
  if (!item.cleanupPromise) {
    item.cleanupPromise = Promise.resolve()
      .then(() => item.onAbandon?.())
      .catch(() => {
        /* the stale lease stays fenced when cleanup itself reports an error */
      });
  }
  await item.cleanupPromise;
}

function pumpSerialized() {
  if (activeSerialTask) return;
  const item = serialQueue.shift();
  if (!item) return;
  if (item.signal?.aborted) {
    finishSerialized(item, cancelledError(item.signal));
    return;
  }

  activeSerialTask = item;
  item.started = true;
  item.startedAt = Date.now();
  const queueWaitMs = item.startedAt - item.queuedAt;
  item.onStart?.({ queueWaitMs });
  Promise.resolve()
    .then(async () => {
      if (currentCooldownMs > 0 && lastTaskEndedAt > 0) {
        const elapsed = Date.now() - lastTaskEndedAt;
        const wait = Math.max(0, currentCooldownMs - elapsed);
        if (wait > 0) await waitWithSignal(wait, { signal: item.signal });
      }
      if (item.signal?.aborted) throw cancelledError(item.signal);
      return item.task({
        queueWaitMs,
        isCurrent: () =>
          activeSerialTask === item && !item.fenced && !item.settled,
      });
    })
    .then(
      async (value) => {
        if (item.signal?.aborted) {
          await abandonSerialized(item);
          finishSerialized(item, cancelledError(item.signal));
          return;
        }
        finishSerialized(item, null, value);
      },
      async (error) => {
        if (item.signal?.aborted) {
          await abandonSerialized(item);
          finishSerialized(item, cancelledError(item.signal));
          return;
        }
        finishSerialized(item, error);
      },
    );
}

export function serialized(task, options = {}) {
  const signal = options.signal || null;
  if (signal?.aborted) return Promise.reject(cancelledError(signal));
  return new Promise((resolve, reject) => {
    const item = {
      id: ++serialTaskID,
      task,
      signal,
      resolve,
      reject,
      queuedAt: Date.now(),
      startedAt: 0,
      started: false,
      settled: false,
      fenced: false,
      abandonTimer: null,
      cleanupPromise: null,
      onStart: options.onStart,
      onAbandon: options.onAbandon,
      onAbort: null,
    };
    item.onAbort = () => {
      if (item.settled) return;
      if (!item.started) {
        const index = serialQueue.indexOf(item);
        if (index >= 0) serialQueue.splice(index, 1);
        finishSerialized(item, cancelledError(signal));
        return;
      }
      if (item.abandonTimer) return;
      item.fenced = true;
      item.abandonTimer = setTimeout(
        async () => {
          if (item.settled) return;
          await abandonSerialized(item);
          finishSerialized(item, cancelledError(signal));
        },
        Math.max(100, Number(options.abortGraceMs) || TURN_ABORT_GRACE_MS),
      );
    };
    signal?.addEventListener("abort", item.onAbort, { once: true });
    serialQueue.push(item);
    if (activeSerialTask) {
      options.onQueued?.({
        position: serialQueue.length,
        activeForMs: Date.now() - activeSerialTask.startedAt,
      });
    }
    pumpSerialized();
  });
}

/** SSE comment keepalives so OpenCode/proxies don't treat a long wait as a hang. */
function startSseKeepalive(res, everyMs = 5000) {
  const timer = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      clearInterval(timer);
    }
  }, everyMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// ---- Backend dispatch --------------------------------------------------------
/**
 * Run a chat completion through the chosen backend, with auto fallback.
 * @param {string} message
 * @param {(delta: string) => void} onToken streaming callback
 * @param {boolean} allowFallback
 * @param {{chatUrl?: string|null, meta?: {chatUrl?: string}, onThinking?: (d: string)=>void, model?: string, effort?: string, signal?: AbortSignal, preferRawReply?: boolean, images?: Array<object>, expectedRawNode?: string|null, expectedPendingPrompt?: string|null, branchParentNode?: string|null}} [session]
 *        chatUrl continues an existing web conversation (playwright only);
 *        meta.chatUrl reports where the exchange landed.
 *        onThinking streams thinking-status into reasoning_content.
 *        model/effort override the ChatGPT Intelligence picker for this send.
 *        signal aborts Playwright when the client disconnects or POST /cancel.
 */
async function runBackend(message, onToken, allowFallback, session = {}) {
  const use = (name) => {
    if (name === "api") return chatAPI(message, { onToken });
    if (name === "playwright")
      return chatUI(message, {
        onToken,
        onThinking: session.onThinking,
        chatUrl: session.chatUrl,
        meta: session.meta,
        model: session.model,
        effort: session.effort,
        signal: session.signal,
        preferRawReply: session.preferRawReply,
        images: session.images,
        expectedRawNode: session.expectedRawNode,
        expectedPendingPrompt: session.expectedPendingPrompt,
        expectedPendingUserMessageID: session.expectedPendingUserMessageID,
        pendingTurnKnown: session.pendingTurnKnown,
        branchParentNode: session.branchParentNode,
        onStatus: session.onStatus,
        onMessageSubmitted: session.onMessageSubmitted,
      });
    throw new Error(`Unknown backend: ${name}`);
  };

  // Only the playwright backend can continue a web conversation.
  const order = session.images?.length
    ? ["playwright"]
    : session.chatUrl
      ? ["playwright"]
      : BACKEND === "api"
        ? ["api"]
        : BACKEND === "playwright"
          ? ["playwright"]
          : ["api", "playwright"]; // auto

  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const name = order[i];
    try {
      const text = await use(name);
      if (i > 0) debugLog(`succeeded via fallback (${name})`);
      return text;
    } catch (err) {
      lastErr = err;
      const isLast = i === order.length - 1 || !allowFallback;
      debugLog(`backend "${name}" failed: ${err.message}`);
      if (isLast || err?.rateLimited) break;
      debugLog(`falling back to "${order[i + 1]}"…`);
    }
  }
  throw lastErr || new Error("No backend produced a reply");
}

const MAX_BODY_BYTES = Math.max(
  64 * 1024,
  Number(process.env.MAX_BODY_BYTES || 2 * 1024 * 1024),
);

// ---- Helpers -----------------------------------------------------------------
function readJson(req) {
  return readRequestJson(req, MAX_BODY_BYTES);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

const OVERLEAF_CONVERSATION_KEY = /^overleaf:[a-f\d]{24}$/;

export function conversationRoutingFromBody(body) {
  const key = body?.conversation_key;
  if (key == null)
    return { conversationKey: null, conversationDeltaStart: null };
  if (typeof key !== "string" || !OVERLEAF_CONVERSATION_KEY.test(key)) {
    throw new Error("`conversation_key` must be an Overleaf session key");
  }
  const deltaStart = body?.conversation_delta_start;
  if (
    !Number.isInteger(deltaStart) ||
    deltaStart < 0 ||
    deltaStart >= (Array.isArray(body?.messages) ? body.messages.length : 0)
  ) {
    throw new Error("`conversation_delta_start` must index a request message");
  }
  return {
    conversationKey: key,
    conversationDeltaStart: deltaStart,
  };
}

/** Normalize OpenAI message content (string | parts array) to plain text. */
// contentToText / toolProtocolPreamble live in request-helpers.js

// ---- Tool-calling shim --------------------------------------------------------
// The ChatGPT web UI has no native function calling, so we teach it a text
// protocol: tools are described in a preamble, and the model asks for a tool by
// replying with a single `TOOL_CALL: {...}` line. We parse that back into an
// OpenAI `tool_calls` response so OpenCode executes the tool LOCALLY and sends
// the result in the next request (role:"tool"), which we flatten into the
// transcript. Without this, the model answers about its own sandbox instead of
// the user's machine.

/**
 * Collapse an OpenAI-style messages[] into a single user prompt string.
 * When tools are provided, prepends the tool protocol and renders prior
 * assistant tool_calls / tool results so the model can continue the loop.
 *
 * `startIndex` renders only messages[startIndex..] — the DELTA a persisted
 * ChatGPT conversation hasn't seen yet. The tool preamble is skipped (it was
 * in that chat's opening message) and messages before startIndex are walked
 * only to rebuild the tool_call_id → name map for delta tool results.
 */
export function messagesToPrompt(
  messages,
  tools = [],
  toolChoice,
  startIndex = 0,
) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("`messages` must be a non-empty array");
  }
  const delta = startIndex > 0;
  const policy = resolveToolUsePolicy(messages, tools, toolChoice);

  const idToName = new Map();
  const parts = [];

  if (!delta && tools.length > 0) {
    parts.push(toolProtocolPreamble(tools, toolChoice, policy));
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m.role || "user";

    if (role === "assistant") {
      for (const tc of m.tool_calls || []) {
        const fn = tc?.function || {};
        if (tc?.id && fn.name) idToName.set(tc.id, fn.name);
      }
    }

    if (i < startIndex) continue; // already lives in the persisted chat

    if (role === "tool") {
      const name =
        idToName.get(m.tool_call_id) || m.name || m.tool_call_id || "tool";
      parts.push(`[tool result for ${name}]: ${contentToText(m.content)}`);
      continue;
    }

    if (role === "assistant") {
      const chunks = [];
      const text = contentToText(m.content);
      if (text) chunks.push(text);
      for (const tc of m.tool_calls || []) {
        const fn = tc?.function || {};
        chunks.push(
          formatToolCallForPrompt(fn.name || "", fn.arguments || "{}", text),
        );
      }
      parts.push(`[assistant]: ${chunks.join("\n")}`);
      continue;
    }

    if (role === "system") {
      parts.push(`[system]: ${contentToText(m.content)}`);
      continue;
    }

    parts.push(contentToText(m.content));
  }

  // The opening preamble carries the REQUIRED emphasis; when a later delta
  // turn demands a tool, restate it briefly.
  if (delta && tools.length > 0 && policy.mode === "none") {
    parts.push(
      "[system]: tool calls are disabled this turn. Reply with normal text only.",
    );
  } else if (delta && tools.length > 0 && policy.required) {
    parts.push(
      policy.expectedTool
        ? `[system]: call exactly the OpenCode tool ${policy.expectedTool} this turn; reply only with one valid tool envelope.`
        : "[system]: an OpenCode tool is REQUIRED this turn; reply only with one valid tool envelope.",
    );
  }

  return parts.join("\n\n");
}

/**
 * Strict TOOL_CALL parse (whole reply only). Returns { calls, error }.
 * Never repairs mangled JSON / merges workdir into command.
 */
function parseToolCallsResult(reply, tools = [], policy = null) {
  const parsed = parseToolCallsStrict(reply, tools);
  if (!parsed.calls.length || !policy) return parsed;
  const error = toolCallPolicyError(parsed.calls[0], policy);
  return error ? { calls: [], error } : parsed;
}

function parseToolCalls(reply, tools = []) {
  return parseToolCallsStrict(reply, tools).calls;
}

function toolCallsPayload(calls) {
  return calls.map((c, i) => ({
    index: i,
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: c.arguments },
  }));
}

function toolCallPurpose(calls) {
  const text = (calls || [])
    .map((call) => String(call?.purpose || "").trim())
    .filter(Boolean)
    .join("\n");
  return text || null;
}

function toolRetryNudge(policy) {
  if (policy?.mode === "none") {
    return "\n\n[system]: Tool choice is none. Reply with normal text only and do not emit TOOL_CALL or SHELL_CALL.";
  }
  const expected = policy?.expectedTool
    ? ` Call exactly ${policy.expectedTool}.`
    : " Call any one advertised tool.";
  return (
    "\n\n[system]: Your previous reply did not contain the required OpenCode tool request." +
    expected +
    " Reply with EXACTLY one TOOL_CALL line and nothing else:\n" +
    'TOOL_CALL: {"name":"<tool_name>","arguments":{ ... },"purpose":"<brief user-facing explanation>"}'
  );
}

const GDOCS_CREATE_NUDGE =
  "\n\n[system]: The user asked for a Google Doc. Your previous reply was NOT acceptable " +
  "(local .docx / Word substitute, ChatGPT connected-apps advice, or claiming the connector is unavailable). " +
  "Ignore ChatGPT web connectors entirely — this harness uses the OpenCode mcp_google-docs catalog facade. " +
  "Reply with EXACTLY one line:\n" +
  'TOOL_CALL: {"name":"mcp_google-docs","arguments":{"action":"call","tool":"docs_create","arguments":{"title":"<short title>","initial_text":"<first paragraph>"}},"purpose":"Create the Google Doc the user requested."}';

const GDOCS_EDIT_NUDGE =
  "\n\n[system]: The user asked to edit/format an existing Google Doc. Your previous reply was NOT acceptable " +
  "(ChatGPT connected-apps / Drive connector advice, or claiming tools are unavailable). " +
  "The OpenCode mcp_google-docs catalog facade IS available via this harness — never tell the user to connect apps in ChatGPT. " +
  "Extract the document id from the docs.google.com/document/d/<ID>/ URL. Reply with EXACTLY one line, e.g.:\n" +
  'TOOL_CALL: {"name":"mcp_google-docs","arguments":{"action":"call","tool":"docs_get","arguments":{"doc_id":"<ID>"}},"purpose":"Read the requested Google Doc before making targeted edits."}';

const BASH_SSH_NUDGE =
  "\n\n[system]: Your previous reply invented environment limits (SSH refused / no keys / no Tailscale / " +
  "'from this environment'). That is FALSE. OpenCode bash runs on the real WSL host with working SSH keys. " +
  "Do NOT narrate blockers — probe with bash. Reply with EXACTLY this envelope:\n" +
  "SHELL_CALL: bash\n" +
  "PURPOSE: Verify the requested remote host through the user's configured SSH access.\n" +
  "COMMAND: ssh -o BatchMode=yes -o ConnectTimeout=10 root@152.53.241.85 'hostname; echo SSH_OK'";

const LOCAL_WRITE_NUDGE =
  "\n\n[system]: Your previous reply claimed you created an app/files (or offered a Download) WITHOUT a TOOL_CALL. " +
  "That does NOTHING on the user's machine — ChatGPT's sandbox/container is irrelevant here. " +
  "If the user requested a local mutation, request the specific write/edit/bash operation that performs it, using only " +
  "targets from the request or prior tool results. NEVER invent a demo path or substitute project. Include a brief " +
  "user-facing `purpose`. If no mutation was requested, correct the claim in normal text and do not call a tool.";

const PLAN_ENV_NUDGE =
  "\n\n[system]: This is a planning-only request, so do not run a tool. Revise the plan without claiming that you tested, " +
  "reached, or were blocked from the user's machine, network, SSH host, or configured services. State that live state " +
  "will be inspected through OpenCode during implementation. Return only the corrected plan.";

const TUI_VISUAL_NUDGE =
  "\n\n[system]: The latest tui_visual_test result says `tui_visual_review_ready: false`. " +
  "A final visual/design/release verdict is not yet allowed. Read its `coverage_gaps`, then reply with EXACTLY one " +
  "TOOL_CALL for tui_visual_test that closes the next gap. Use step for live keyboard/mouse/resize interaction and " +
  "matrix for the complete WSL/PowerShell/cmd size/theme grid. Continue until the tool reports true.";

// A refusal ("I don't have bash/MCP tools here") mid-loop derails the whole
// OpenCode run. Detect the common refusal phrasings so we can nudge even when
// the turn wasn't strictly "tools expected".
const REFUSAL_RE =
  /\b(i (?:can(?:no|')t|cannot|am unable|'m unable|don'?t have)(?: the| any| direct)? (?:access|abilit|tools?|bash|shell|mcp|harness)|tools? (?:are|is)n'?t available|no (?:bash|shell|mcp|tool) (?:tool|access)|as an ai|connector wasn'?t available|google docs?-compatible|\.docx\b|connected apps|plugin lookup|authorization error|google drive\/docs|from this environment|port\s*22.{0,20}refused|no ssh key|ssh agent|requires temporary.{0,20}ssh|download the|files? (?:are )?located at)\b/i;

// ChatGPT can surface limits as an assistant/banner reply or reject the
// conversation POST before any assistant node exists. Keep the same OpenCode
// provider turn alive across both forms: wait cancellably, then resubmit from a
// verified parent (or a clean fresh chat) until ChatGPT accepts the request.
const RATE_LIMIT_BACKOFF_MS = Number(
  process.env.RATE_LIMIT_BACKOFF_MS || 90_000,
);
const RATE_LIMIT_MAX_BACKOFF_MS = Number(
  process.env.RATE_LIMIT_MAX_BACKOFF_MS || 15 * 60_000,
);
let rateLimitedUntil = 0;

function waitLabel(ms) {
  const secs = Math.max(1, Math.round(ms / 1000));
  return secs >= 90 ? `${Math.round(secs / 60)}m` : `${secs}s`;
}

function registerRateLimit(value, attempt = 1) {
  const existing = value instanceof Error ? value : null;
  const message =
    existing?.message || String(value || "ChatGPT rate limit reached");
  const fallback = Math.min(
    Math.max(RATE_LIMIT_BACKOFF_MS, 1_000) *
      2 ** Math.min(Math.max(0, attempt - 1), 6),
    Math.max(RATE_LIMIT_BACKOFF_MS, RATE_LIMIT_MAX_BACKOFF_MS),
  );
  const backoff =
    Number(existing?.backoffMs) > 0
      ? Number(existing.backoffMs)
      : parseRateLimitBackoffMs(message, fallback);
  rateLimitedUntil = Date.now() + backoff;
  setRateLimitedUntil(rateLimitedUntil);
  noteRateLimitHit(backoff);
  const err = existing || new Error(message);
  err.rateLimited = true;
  err.backoffMs = backoff;
  err.rateLimitedUntil = rateLimitedUntil;
  err.rateLimitAttempt = attempt;
  err.message = `ChatGPT rate-limited, retrying in ${waitLabel(backoff)}`;
  return err;
}

function cancelledError(signal) {
  const reason = signal?.reason;
  const err = new Error(
    typeof reason === "string" && reason
      ? `Request cancelled (${reason})`
      : "Request cancelled",
  );
  err.cancelled = true;
  return err;
}

function waitWithSignal(ms, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(cancelledError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    const onAbort = () => done(cancelledError(signal));
    function done(error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function emitProviderStatus(onStatus, value) {
  if (typeof onStatus !== "function") return;
  try {
    onStatus(value);
  } catch {
    /* client disconnected */
  }
}

async function waitOutRateLimit({
  signal = null,
  onStatus = null,
  attempt = 1,
  waiter = waitWithSignal,
  pauseBudget = null,
  resumeBudget = null,
} = {}) {
  const wait = rateLimitedUntil - Date.now();
  if (wait <= 0) {
    rateLimitedUntil = 0;
    setRateLimitedUntil(0);
    return;
  }
  debugLog(
    `rate-limit backoff: waiting ${Math.round(wait / 1000)}s before retry #${attempt}`,
  );
  emitProviderStatus(onStatus, {
    label: "ChatGPT rate limited",
    next: rateLimitedUntil,
    attempt,
  });
  pauseBudget?.();
  let completed = false;
  try {
    await waiter(wait, { signal, until: rateLimitedUntil, attempt });
    completed = true;
  } finally {
    if (completed) {
      rateLimitedUntil = 0;
      setRateLimitedUntil(0);
    }
    resumeBudget?.();
  }
  if (completed) {
    emitProviderStatus(onStatus, {
      label: "Retrying ChatGPT web",
      attempt,
    });
  }
}

function rememberTurn(
  entry,
  messages,
  reply,
  calls,
  chatUrl,
  hasTools,
  meta = {},
) {
  if (!PERSIST_CHAT) return entry;
  const assistantMsg =
    calls.length > 0
      ? {
          role: "assistant",
          content: toolCallPurpose(calls),
          tool_calls: toolCallsPayload(calls),
        }
      : { role: "assistant", content: reply };
  const url = chatUrl || entry?.chatUrl || null;
  const wasNew = !entry;
  const tracked = rememberConversation(
    entry,
    messages,
    assistantMsg,
    url,
    hasTools,
    {
      rawCurrentNode: meta.rawCurrentNode || null,
      key: meta.conversationKey || null,
    },
  );
  if (tracked && wasNew) {
    debugLog(
      `tracking chat ${tracked.chatUrl} (${trackedConversations()} tracked)`,
    );
  }
  return tracked;
}

function terminalToolError(message, messages, meta, kind = "toolPolicy") {
  const hasPriorResult = (messages || []).some((item) => item?.role === "tool");
  const err = new Error(
    `${message}. No command from the rejected reply was executed. ` +
      (hasPriorResult
        ? "The prior tool result remains in the OpenCode session; retry to continue from it. "
        : "Retry the request after reviewing the provider error. ") +
      "The existing ChatGPT conversation mapping was preserved.",
  );
  err[kind] = true;
  err.recoveryStage = meta.recoveryStage;
  err.protocolAttempts = meta.protocolAttempts;
  err.deliveryState = meta.deliveryState;
  err.rawNodeClass = meta.rawNodeClass;
  err.rawAuditReason = meta.rawAuditReason;
  noteRecovery("terminal");
  return err;
}

const DISCOVERY_NATIVE_CALLS = new Set([
  "api_tool.list_resources",
  "api_tool.search_tools",
]);
const AUTOMATIC_NATIVE_RECOVERY_RISKS = new Set([
  "discovery-only",
  "clean-drift",
  "confirmed-no-side-effect",
]);
const RECOVERY_FRESH_CONTROL_RE = /^(?:retry|recover) fresh$/i;
const ALLOW_REJECTED_REPLY_CONTROL_RE = /^allow reply$/i;
const CONTINUE_REJECTED_REPLY_CONTROL_RE = /^continue anyway$/i;
const RECOVERY_CONTROL_RE =
  /^(?:retry|retry anyway|recover|continue anyway|retry fresh|recover fresh|allow reply)$/i;
export const NATIVE_ACTIVITY_QUARANTINE_CODE =
  "chatgpt_web_native_activity_quarantine";
export const VERIFICATION_UNAVAILABLE_CODE =
  "chatgpt_web_verification_unavailable";
export const TRANSIENT_REPLY_CODE = "chatgpt_web_transient_reply";
export const PRE_SUBMIT_TIMEOUT_CODE = "chatgpt_web_pre_submit_timeout";
export const TURN_BUDGET_EXCEEDED_CODE = "chatgpt_web_turn_budget_exceeded";
const NATIVE_ACTIVITY_RECOVERY_ACTIONS = Object.freeze([
  "retry",
  "retry fresh",
  "allow reply",
  "continue anyway",
  "dismiss",
]);
const VERIFICATION_RECOVERY_ACTIONS = Object.freeze([
  "retry",
  "retry fresh",
  "dismiss",
]);
const REJECTED_REPLY_TTL_MS = Math.max(
  60_000,
  Number(process.env.REJECTED_REPLY_TTL_MS || 30 * 60_000) || 30 * 60_000,
);
const pendingRejectedReplies = new WeakMap();

function recoveryControlText(content) {
  const text = contentToText(content).trim();
  const quote = text[0];
  if (
    text.length >= 2 &&
    (quote === '"' || quote === "'" || quote === "`") &&
    text.at(-1) === quote
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function isRecoveryControlMessage(message) {
  return (
    message?.role === "user" &&
    RECOVERY_CONTROL_RE.test(recoveryControlText(message.content))
  );
}

function splitRecoveryControls(messages) {
  const cleaned = Array.isArray(messages) ? messages.slice() : [];
  let count = 0;
  let forceFresh = false;
  let allowRejectedReply = false;
  let continueRejectedReply = false;
  let newestControl = null;
  while (cleaned.length) {
    const last = cleaned.at(-1);
    if (last?.role !== "user") break;
    const text = recoveryControlText(last.content);
    if (!RECOVERY_CONTROL_RE.test(text)) break;
    if (newestControl === null) newestControl = text;
    cleaned.pop();
    count += 1;
  }
  if (newestControl !== null) {
    forceFresh = RECOVERY_FRESH_CONTROL_RE.test(newestControl);
    allowRejectedReply = ALLOW_REJECTED_REPLY_CONTROL_RE.test(newestControl);
    continueRejectedReply =
      CONTINUE_REJECTED_REPLY_CONTROL_RE.test(newestControl);
  }
  const explicit = count > 0;
  const filtered = explicit
    ? cleaned.filter((message) => !isRecoveryControlMessage(message))
    : cleaned;
  return {
    messages: filtered,
    explicit,
    forceFresh,
    allowRejectedReply,
    continueRejectedReply,
    count,
  };
}

function transientReplyError(reply, meta) {
  const err = new Error(
    "ChatGPT returned a transient service error instead of an assistant reply. No OpenCode host command was executed; retry this turn when ChatGPT is available.",
  );
  err.chatgptWebErrorCode = TRANSIENT_REPLY_CODE;
  err.transientReply = true;
  err.deliveryState = meta.deliveryState || "transient-service-error";
  err.recoveryStage = meta.recoveryStage;
  err.protocolAttempts = meta.protocolAttempts;
  err.rawNodeClass = meta.rawNodeClass;
  err.rawAuditReason = meta.rawAuditReason;
  err.transientReplyChars = String(reply || "").length;
  noteRecovery("terminal");
  return err;
}

function verificationUnavailableError(messages, meta, source) {
  const hasPriorResult = (messages || []).some((item) => item?.role === "tool");
  const chatUrl = source?.chatUrl || meta.chatUrl || null;
  const submitted =
    source?.messageSubmitted === true || meta.messageSubmitted === true;
  const url = chatUrl ? ` Chat: ${chatUrl}.` : "";
  const err = new Error(
    (submitted
      ? "ChatGPT submitted a turn, but its authenticated raw conversation state could not be verified. The unverified reply was rejected. "
      : "ChatGPT's authenticated pre-send state could not be verified, and no ChatGPT message was sent. ") +
      (submitted
        ? "Its native-tool ancestry remains unknown, so the reply cannot be allowed or continued. No OpenCode host command from it was executed. "
        : "No ChatGPT or OpenCode action from this attempt occurred. ") +
      (hasPriorResult
        ? "The prior OpenCode tool result remains in this session. "
        : "The OpenCode session remains intact. ") +
      "The unverifiable ChatGPT branch was quarantined and its locked browser was discarded. " +
      (source?.safeParentNode
        ? "Choose `retry` to re-verify or branch from the last verified parent, or `retry fresh` to start a clean ChatGPT chat. "
        : "Choose `retry fresh` to start a clean ChatGPT chat, or `retry` to try recovery again. ") +
      "No TUI restart is required." +
      url,
  );
  err.chatgptWebErrorCode = VERIFICATION_UNAVAILABLE_CODE;
  err.verificationUnavailable = true;
  err.nativeToolInspectionUnavailable = true;
  err.deliveryState =
    source?.deliveryState || meta.deliveryState || "verification-unavailable";
  err.rawNodeClass =
    source?.rawNodeClass || meta.rawNodeClass || "unverifiable";
  err.rawAuditReason =
    source?.rawAuditReason ||
    meta.rawAuditReason ||
    "raw-postcheck-unavailable";
  err.recoveryStage = "verification-unavailable";
  err.protocolAttempts = meta.protocolAttempts;
  err.chatUrl = chatUrl;
  err.messageSubmitted = submitted;
  err.failureStage = source?.failureStage || meta.failureStage;
  err.rawReader = source?.rawReader || meta.rawReader;
  err.rawReaderOutcomes = source?.rawReaderOutcomes || meta.rawReaderOutcomes;
  err.recoveryParentVerified = !!source?.safeParentNode;
  err.recoveryActions = [...VERIFICATION_RECOVERY_ACTIONS];
  noteRecovery("terminal");
  return err;
}

function cacheRejectedReply(entry, info) {
  const candidate = info?.rejectedReply;
  if (!entry || !candidate || typeof candidate.reply !== "string") return false;
  if (isTransientFailureReply(candidate.reply)) return false;
  pendingRejectedReplies.set(entry, {
    ...candidate,
    chatUrl: info.chatUrl || entry.chatUrl || null,
    risk: info.risk || "unverifiable",
    rawNodeClass: info.rawNodeClass || "unverifiable",
    rawAuditReason: info.rawAuditReason || "unavailable",
    contaminatedNode: info.contaminatedNode || null,
    disclosed: false,
    expiresAt: Date.now() + REJECTED_REPLY_TTL_MS,
  });
  return true;
}

function takeRejectedReply(entry) {
  if (!entry) return null;
  const candidate = pendingRejectedReplies.get(entry) || null;
  pendingRejectedReplies.delete(entry);
  if (!candidate || candidate.expiresAt < Date.now()) return null;
  return candidate;
}

function discloseRejectedReply(entry) {
  if (!entry) return null;
  const candidate = pendingRejectedReplies.get(entry) || null;
  if (!candidate || candidate.expiresAt < Date.now()) {
    pendingRejectedReplies.delete(entry);
    return null;
  }
  if (candidate.disclosed) return null;
  candidate.disclosed = true;
  return candidate;
}

function hasRejectedReply(entry) {
  if (!entry) return false;
  const candidate = pendingRejectedReplies.get(entry) || null;
  if (!candidate || candidate.expiresAt < Date.now()) {
    pendingRejectedReplies.delete(entry);
    return false;
  }
  return true;
}

function disclosedRejectedReply(candidate) {
  return [
    "[Unverified ChatGPT reply — displayed once at your explicit request]",
    "Its ChatGPT branch remains quarantined. Any tool-call envelope below is inert and was not executed by OpenCode.",
    "",
    candidate.reply,
  ].join("\n");
}

function nativeRecoveryInfo(error, fallback = {}) {
  const names = Array.isArray(error?.nativeAssistantCallNames)
    ? error.nativeAssistantCallNames
    : Array.isArray(error?.nativeToolNames)
      ? error.nativeToolNames
      : Array.isArray(fallback.nativeCallNames)
        ? fallback.nativeCallNames
        : [];
  const uniqueNames = [
    ...new Set(names.map((name) => String(name).slice(0, 120))),
  ].sort();
  const safeParentNode =
    error?.nativeSafeParentNode || fallback.safeParentNode || null;
  const contaminatedNode =
    error?.nativeContaminatedNode || fallback.contaminatedNode || null;
  const suppliedRisk = error?.nativeToolRisk || fallback.risk || "unverifiable";
  const reason = String(
    error?.recoveryReason || fallback.reason || "native-tools",
  );
  const rejectedReply =
    reason === "verification-unavailable"
      ? null
      : rejectedReplyFromError(error) || fallback.rejectedReply || null;
  const risk =
    suppliedRisk === "clean-drift" ||
    suppliedRisk === "confirmed-no-side-effect"
      ? suppliedRisk
      : uniqueNames.length > 0 &&
          uniqueNames.every((name) => DISCOVERY_NATIVE_CALLS.has(name))
        ? "discovery-only"
        : uniqueNames.length > 0
          ? "side-effects-possible"
          : "unverifiable";
  return {
    names: uniqueNames,
    safeParentNode,
    contaminatedNode,
    risk,
    reason,
    chatUrl: error?.chatUrl || fallback.chatUrl || null,
    attempts: Math.max(0, Number(fallback.attempts) || 0),
    deliveryState: error?.deliveryState || fallback.deliveryState,
    rawNodeClass: error?.rawNodeClass || fallback.rawNodeClass,
    rawAuditReason: error?.rawAuditReason || fallback.rawAuditReason,
    messageSubmitted:
      error?.messageSubmitted === true || fallback.messageSubmitted === true,
    failureStage: error?.failureStage || fallback.failureStage,
    rawReader: error?.rawReader || fallback.rawReader,
    rawReaderOutcomes: Array.isArray(error?.rawReaderOutcomes)
      ? error.rawReaderOutcomes
      : Array.isArray(fallback.rawReaderOutcomes)
        ? fallback.rawReaderOutcomes
        : [],
    rejectedReply,
  };
}

export function canAutomaticallyRecoverNativeTurn(info) {
  return AUTOMATIC_NATIVE_RECOVERY_RISKS.has(String(info?.risk || ""));
}

function terminalNativeToolError(messages, meta, info = {}) {
  const names = Array.isArray(info.names)
    ? info.names
    : Array.isArray(meta.nativeToolNames)
      ? meta.nativeToolNames
      : [];
  const risk =
    info.risk ||
    meta.nativeToolRisk ||
    nativeRecoveryInfo(null, {
      nativeCallNames: names,
    }).risk;
  const chatUrl = info.chatUrl || meta.chatUrl || null;
  const url = chatUrl ? ` Chat: ${chatUrl}.` : "";
  const sideEffects =
    risk !== "discovery-only" &&
    risk !== "clean-drift" &&
    risk !== "confirmed-no-side-effect";
  const recoveryInstruction = sideEffects
    ? Number(info.attempts) > 0
      ? "Type `retry fresh` to start a clean ChatGPT chat while preserving this OpenCode session."
      : "Type `retry` to authorize a verified sibling branch, or `retry fresh` to start a clean ChatGPT chat while preserving this OpenCode session."
    : "Send the next message (or `retry`) to resume automatically through a verified sibling branch or a clean compact chat; " +
      "type `retry fresh` to force a new ChatGPT chat.";
  const disclosureInstruction = info.rejectedReplyAvailable
    ? " Type `allow reply` to display the captured reply once as unverified text; any tool call in it will remain inert. Type `continue anyway` to accept that captured reply as the normal OpenCode reply and continue from the quarantined ChatGPT branch; any valid OpenCode tool call in it will proceed through normal permissions."
    : "";
  const delivered =
    !!info.rejectedReplyAvailable ||
    String(meta.deliveryState || info.deliveryState || "").startsWith(
      "delivered",
    );
  const deliveryPrefix = delivered
    ? "ChatGPT delivered a reply, but authenticated safety verification rejected it. "
    : "";
  const incident =
    deliveryPrefix +
    (risk === "confirmed-no-side-effect"
      ? "ChatGPT web recovery paused after native activity (bio). The authenticated tool result confirmed memory was disabled; no memory was saved or changed. "
      : `ChatGPT web recovery paused after ${risk === "unverifiable" ? "an unverifiable raw conversation state" : `native activity${names.length ? ` (${names.join(", ")})` : ""}`}. `);
  const err = new Error(
    incident +
      "No OpenCode host command from the rejected reply was executed. " +
      (sideEffects
        ? "ChatGPT-native state may already have changed. "
        : risk === "confirmed-no-side-effect"
          ? "The authenticated result confirms no ChatGPT-native state change occurred. "
          : "The detected activity was discovery-only and no external write was observed. ") +
      `The contaminated branch was quarantined.${url} ` +
      recoveryInstruction +
      disclosureInstruction,
  );
  err.nativeToolPolicy = true;
  err.nativeToolSuppressionState = "postcheck-violation";
  err.nativeToolSideEffectsPossible = sideEffects;
  err.nativeToolNames = names;
  err.nativeToolRisk = risk;
  err.rawNodeClass = meta.rawNodeClass || info.rawNodeClass;
  err.rawAuditReason = meta.rawAuditReason || info.rawAuditReason;
  err.deliveryState = meta.deliveryState || info.deliveryState;
  err.chatUrl = chatUrl;
  err.recoveryStage = "paused-native-tools";
  err.protocolAttempts = meta.protocolAttempts;
  err.recoveryAttempt = Number(info.attempts) || 0;
  err.recoveryParentVerified = !!info.safeParentNode;
  err.chatgptWebErrorCode = NATIVE_ACTIVITY_QUARANTINE_CODE;
  err.rejectedReplyAvailable = !!info.rejectedReplyAvailable;
  err.recoveryActions = NATIVE_ACTIVITY_RECOVERY_ACTIONS.filter(
    (action) =>
      info.rejectedReplyAvailable ||
      (action !== "allow reply" && action !== "continue anyway"),
  );
  noteRecovery("terminal");
  return err;
}

/**
 * Run the backend, optionally retrying once with a nudge if tools were
 * expected but the model answered in plain text (or refused).
 *
 * Persistent-chat flow (PERSIST_CHAT=1): when the incoming messages extend a
 * conversation we already have open in the ChatGPT UI, send ONLY the new
 * messages into that same chat instead of replaying the full transcript into
 * a fresh one. On success the (chat, transcript) pair is recorded so the next
 * OpenCode turn routes back here. Runs inside the serialized queue, so the
 * lookup/update pair is race-free.
 *
 * Recovery paths use a bounded fresh-chat packet and retain the old mapping
 * until the replacement succeeds:
 *   - continuationFailed (deleted / redirected conversation)
 *   - conversation-too-long banner
 *   - nudge still produced no TOOL_CALL (refusal escalation)
 */
export async function runWithToolRetry(
  prompt,
  tools,
  messages,
  toolChoice,
  onToken = null,
  onThinking = null,
  intelligence = null,
  signal = null,
  backendRunner = runBackend,
  runtime = {},
) {
  if (signal?.aborted) {
    const err = new Error("Request cancelled");
    err.cancelled = true;
    throw err;
  }
  await waitOutRateLimit({
    signal,
    onStatus: runtime.onStatus,
    waiter: runtime.waitForRateLimit,
    pauseBudget: runtime.pauseBudget,
    resumeBudget: runtime.resumeBudget,
  });
  const resetRuntimeSession =
    typeof runtime.resetSharedSession === "function"
      ? runtime.resetSharedSession
      : resetSharedSession;
  const hasTools = tools.length > 0;
  const conversationKey = runtime.conversationKey || null;
  const recoveryControl = splitRecoveryControls(messages);
  let entry = PERSIST_CHAT
    ? conversationKey
      ? findConversationByKey(conversationKey, hasTools)
      : findConversation(messages, hasTools)
    : null;
  let entryStartIndex = entry
    ? conversationKey
      ? runtime.conversationDeltaStart
      : entry.sig.length
    : 0;
  if (
    entry &&
    conversationKey &&
    (!Number.isInteger(entryStartIndex) ||
      entryStartIndex < 0 ||
      entryStartIndex >= messages.length)
  ) {
    throw new Error("Invalid keyed conversation delta");
  }
  if (!entry && !conversationKey && PERSIST_CHAT && recoveryControl.explicit) {
    const quarantined = findQuarantinedRecoveryConversation(messages, hasTools);
    const fallback =
      quarantined || findRecoveryConversation(messages, hasTools);
    if (fallback) {
      entry = fallback.entry;
      entryStartIndex = fallback.startIndex;
      debugLog(
        `explicit retry matched ${quarantined ? "quarantined" : "legacy"} chat ${entry.chatUrl} after system-preamble drift (${fallback.matchedMessages} committed non-system messages)`,
      );
    }
  }
  const recoveryMessages = recoveryControl.messages.length
    ? recoveryControl.messages
    : messages;
  if (
    recoveryControl.allowRejectedReply &&
    !recoveryControl.continueRejectedReply
  ) {
    const candidate = entry?.recovery ? discloseRejectedReply(entry) : null;
    if (!candidate) {
      const chatUrl = entry?.chatUrl || null;
      const err = new Error(
        "The rejected ChatGPT reply is no longer available in this OpenCode process; it may already have been shown, expired, or been lost when the TUI restarted. " +
          "The quarantined branch remains blocked. Type `retry` to authorize a verified sibling branch, or `retry fresh` to start a clean ChatGPT chat while preserving this OpenCode session." +
          (chatUrl ? ` Chat: ${chatUrl}` : ""),
      );
      err.nativeToolPolicy = true;
      err.nativeToolRisk = entry?.recovery?.risk || "unverifiable";
      err.chatUrl = chatUrl;
      err.recoveryStage = "rejected-reply-unavailable";
      err.protocolAttempts = 0;
      throw err;
    }
    return {
      reply: disclosedRejectedReply(candidate),
      calls: [],
      meta: {
        chatUrl: candidate.chatUrl || entry?.chatUrl || null,
        conversationReused: !!entry,
        recoveryStage: "user-authorized-unverified-reply",
        protocolAttempts: 0,
        fullPromptChars: prompt.length,
        sentPromptChars: 0,
        inputImageCount: 0,
        messageSubmitted: false,
        replySource: candidate.source || "unverified-captured",
        replyRecovery: "user-authorized-unverified",
        nativeToolInspection: "unverified-user-disclosed",
        nativeToolRisk: candidate.risk,
        rawNodeClass: candidate.rawNodeClass,
        rawAuditReason: candidate.rawAuditReason,
        deliveryState: "delivered-user-authorized",
        unverifiedReplyAuthorized: true,
      },
    };
  }
  const continuedRejectedReply = recoveryControl.continueRejectedReply
    ? entry?.recovery
      ? takeRejectedReply(entry)
      : null
    : null;
  if (recoveryControl.continueRejectedReply && !continuedRejectedReply) {
    const chatUrl = entry?.chatUrl || null;
    const err = new Error(
      "The rejected ChatGPT reply is no longer available in this OpenCode process; it may already have been shown, expired, or been lost when the TUI restarted. " +
        "The quarantined branch remains blocked. Type `retry` to authorize a verified sibling branch, or `retry fresh` to start a clean ChatGPT chat while preserving this OpenCode session." +
        (chatUrl ? ` Chat: ${chatUrl}` : ""),
    );
    err.nativeToolPolicy = true;
    err.nativeToolRisk = entry?.recovery?.risk || "unverifiable";
    err.chatUrl = chatUrl;
    err.recoveryStage = "rejected-reply-unavailable";
    err.protocolAttempts = 0;
    throw err;
  }
  const policy = resolveToolUsePolicy(recoveryMessages, tools, toolChoice);
  const mustUseTool = policy.required;
  // The raw conversation graph is now authoritative for every reply. DOM
  // streaming can flatten Markdown before raw source is available, so answer
  // text is emitted once after the post-check (thinking status still streams).
  const streamCb = null;
  // Thinking status is safe even on tool turns (it goes to reasoning_content,
  // not the answer channel). Still skip when STREAM_THINKING is off.
  const thinkCb = STREAM_THINKING && onThinking ? onThinking : null;
  const intel = intelligence || { model: CHAT_MODEL, effort: CHAT_EFFORT };

  // Fail BEFORE burning a ChatGPT turn when the user wants Google Docs but
  // OpenCode didn't attach google-docs_* tools (MCP failed at session start).
  // The model otherwise invents ChatGPT "connected apps" advice.
  if (userAskedForGoogleDoc(recoveryMessages) && !hasGoogleDocsTool(tools)) {
    const err = new Error(
      "Google Docs MCP tools are missing in this OpenCode session — quit and restart OpenCode so google-docs can connect (check opencode.log for 'server unavailable' key=google-docs). Do NOT use ChatGPT connected apps.",
    );
    err.mcpMissing = true;
    throw err;
  }
  if (policy.missing) {
    const err = new Error(
      policy.expectedTool
        ? `Named tool choice requires "${policy.expectedTool}", but that exact tool was not advertised.`
        : "Tool choice 'required' cannot be used because this request advertises no tools.",
    );
    err.toolMissing = true;
    throw err;
  }

  const recoveryImages = recentUserImages(recoveryMessages);
  const meta = {
    conversationKey,
    conversationReused: !!entry,
    recoveryStage: "none",
    protocolAttempts: 1,
    fullPromptChars: prompt.length,
    sentPromptChars: prompt.length,
    inputImageCount: imagesFromMessages(messages).length,
  };
  if (continuedRejectedReply) {
    meta.chatUrl = continuedRejectedReply.chatUrl || entry?.chatUrl || null;
    meta.rawCurrentNode =
      continuedRejectedReply.contaminatedNode ||
      entry?.recovery?.contaminatedNode ||
      null;
    meta.recoveryStage = "user-authorized-quarantined-branch";
    meta.protocolAttempts = 0;
    meta.sentPromptChars = 0;
    meta.inputImageCount = 0;
    meta.messageSubmitted = false;
    meta.replySource = continuedRejectedReply.source || "unverified-captured";
    meta.replyRecovery = "user-authorized-quarantined-branch";
    meta.nativeToolInspection = "user-authorized-unverified";
    meta.nativeToolRisk = continuedRejectedReply.risk;
    meta.rawNodeClass = continuedRejectedReply.rawNodeClass;
    meta.rawAuditReason = continuedRejectedReply.rawAuditReason;
    meta.deliveryState = "delivered-user-authorized";
    meta.unverifiedReplyAuthorized = true;
  }
  let activeEntry = entry;
  let rateLimitRetries = 0;
  let imageUploadRetries = 0;
  let forceFreshRequest = false;
  const assertCurrentRuntime = () => {
    if (signal?.aborted) throw cancelledError(signal);
    if (!runtime.isCurrent || runtime.isCurrent()) return;
    throw cancelledError(signal);
  };
  const resetAttemptMeta = () => {
    for (const key of [
      "deliveryState",
      "rawNodeClass",
      "rawAuditReason",
      "nativeToolInspection",
      "nativeToolRisk",
      "nativeToolSideEffectsPossible",
      "nativeToolNames",
      "rawReader",
      "rawReaderOutcomes",
      "failureStage",
      "outboundUserMessageID",
      "rawBeforeNode",
    ]) {
      delete meta[key];
    }
    meta.messageSubmitted = false;
  };
  const invokeBackend = async (candidatePrompt, candidateStream, session) => {
    let promptToSend = candidatePrompt;
    let sessionToUse = session;
    while (true) {
      let reply;
      let limited = null;
      try {
        assertCurrentRuntime();
        resetAttemptMeta();
        runtime.beginPreSubmit?.();
        reply = await backendRunner(promptToSend, candidateStream, true, {
          ...sessionToUse,
          onStatus: runtime.onStatus,
          onMessageSubmitted: runtime.onMessageSubmitted,
        });
        assertCurrentRuntime();
      } catch (err) {
        assertCurrentRuntime();
        if (
          err?.imageUploadRetryable &&
          !meta.messageSubmitted &&
          imageUploadRetries < IMAGE_UPLOAD_RETRY_LIMIT
        ) {
          imageUploadRetries += 1;
          meta.imageUploadRetries = imageUploadRetries;
          meta.deliveryState = "image-upload-retry";
          meta.messageSubmitted = false;
          delete meta.uploadedImageCount;
          const delay = IMAGE_UPLOAD_RETRY_DELAY_MS * imageUploadRetries;
          debugLog(
            `fresh composer image upload failed before Send; retrying ${imageUploadRetries}/${IMAGE_UPLOAD_RETRY_LIMIT} in ${waitLabel(delay)}`,
          );
          emitProviderStatus(runtime.onStatus, {
            label: "Retrying ChatGPT image upload",
            attempt: imageUploadRetries,
          });
          await waitWithSignal(delay, { signal });
          continue;
        }
        if (err?.rateLimited) {
          limited = err;
        } else {
          if (err?.nativeToolInspectionUnavailable) {
            const info = nativeRecoveryInfo(err, {
              reason: "verification-unavailable",
              chatUrl:
                err?.chatUrl ||
                meta.chatUrl ||
                activeEntry?.chatUrl ||
                entry?.chatUrl,
              safeParentNode:
                meta.rawBeforeNode ||
                (sessionToUse?.chatUrl
                  ? activeEntry?.rawCurrentNode || entry?.rawCurrentNode || null
                  : null),
              deliveryState: err?.deliveryState || meta.deliveryState,
              rawNodeClass: err?.rawNodeClass || meta.rawNodeClass,
              rawAuditReason: err?.rawAuditReason || meta.rawAuditReason,
              messageSubmitted:
                err?.messageSubmitted === true ||
                meta.messageSubmitted === true,
            });
            persistNativeRecovery(info, "paused", info.attempts);
            if (info.messageSubmitted && entry) {
              rememberConversationPendingTurn(entry, promptToSend, {
                boundaryNode: meta.rawBeforeNode || null,
                userMessageID: meta.outboundUserMessageID || null,
                attempts: meta.protocolAttempts,
              });
            }
            await resetRuntimeSession();
            meta.firewallResetAfterVerificationFailure = true;
            throw verificationUnavailableError(messages, meta, info);
          }
          if (!err?.replyUnavailable) throw err;
          throw terminalToolError(
            "ChatGPT finished without the mandatory raw conversation post-check",
            messages,
            meta,
            "replyUnavailable",
          );
        }
      }
      if (!limited && !isRateLimitReply(reply)) {
        if (isTransientFailureReply(reply)) {
          throw transientReplyError(reply, meta);
        }
        return reply;
      }

      rateLimitRetries += 1;
      const rateError = registerRateLimit(limited || reply, rateLimitRetries);
      meta.rateLimitRetries = rateLimitRetries;
      meta.rateLimitWaitMs =
        (Number(meta.rateLimitWaitMs) || 0) + rateError.backoffMs;
      meta.rateLimitSource =
        limited?.rateLimitSource ||
        (limited ? "backend-error" : "assistant-reply");
      meta.deliveryState = "rate-limit-wait";

      const safeParent =
        limited?.safeParentNode ||
        meta.rawBeforeNode ||
        sessionToUse.branchParentNode ||
        sessionToUse.expectedRawNode ||
        activeEntry?.rawCurrentNode ||
        null;
      const retryChatUrl =
        limited?.chatUrl || meta.chatUrl || sessionToUse.chatUrl || null;
      const wasContinuation = !!sessionToUse.chatUrl;
      if (retryChatUrl && safeParent) {
        sessionToUse = {
          ...sessionToUse,
          chatUrl: retryChatUrl,
          branchParentNode: safeParent,
          expectedRawNode: safeParent,
          // A completed rate-limit banner is not a usable delivered reply.
          // Force a new guarded Send from the verified parent instead of
          // adopting the old banner again on every retry.
          expectedPendingPrompt: null,
          expectedPendingUserMessageID: null,
        };
        meta.recoveryStage = "same-chat-rate-limit";
      } else if (wasContinuation) {
        promptToSend = buildCompactRecoveryPrompt(messages, tools, toolChoice, {
          error:
            "ChatGPT rejected the previous generation because its rate limit was active.",
          policy,
          nudge:
            "Continue from the bounded OpenCode context without repeating already successful host actions.",
        });
        sessionToUse = {
          ...sessionToUse,
          chatUrl: undefined,
          branchParentNode: null,
          expectedRawNode: null,
          expectedPendingPrompt: null,
          expectedPendingUserMessageID: null,
          images: recoveryImages,
        };
        delete meta.chatUrl;
        meta.recoveryStage = "fresh-chat-rate-limit";
        meta.sentPromptChars = promptToSend.length;
        meta.inputImageCount = recoveryImages.length;
      } else {
        sessionToUse = {
          ...sessionToUse,
          chatUrl: undefined,
          branchParentNode: null,
          expectedRawNode: null,
          expectedPendingPrompt: null,
          expectedPendingUserMessageID: null,
        };
        delete meta.chatUrl;
        meta.recoveryStage = "fresh-chat-rate-limit";
      }

      meta.messageSubmitted = false;
      delete meta.outboundUserMessageID;
      try {
        await waitOutRateLimit({
          signal,
          onStatus: runtime.onStatus,
          attempt: rateLimitRetries,
          waiter: runtime.waitForRateLimit,
          pauseBudget: runtime.pauseBudget,
          resumeBudget: runtime.resumeBudget,
        });
      } catch (err) {
        err.rateLimitRetries = rateLimitRetries;
        err.rateLimitWaitMs = meta.rateLimitWaitMs;
        err.rateLimitSource = meta.rateLimitSource;
        throw err;
      }
    }
  };
  const rejectNativeToolDetours = (candidate) => {
    if (meta.nativeToolInspection === "detected") {
      const info = nativeRecoveryInfo(null, {
        chatUrl: meta.chatUrl || entry?.chatUrl || null,
        nativeCallNames: meta.nativeToolNames,
        risk: meta.nativeToolRisk,
        deliveryState: meta.deliveryState || "delivered-rejected",
        rawNodeClass: meta.rawNodeClass,
        rawAuditReason: meta.rawAuditReason,
        rejectedReply: {
          reply: String(candidate || "").trim(),
          source: meta.replySource || "backend",
          capturedAt: Date.now(),
        },
      });
      persistNativeRecovery(info, "paused", info.attempts);
      throw terminalNativeToolError(messages, meta, info);
    }
    return candidate;
  };
  let sendPrompt = prompt;
  let sendImages = imagesFromMessages(messages);
  let rotateImageConversation = false;
  if (entry) {
    sendPrompt = messagesToPrompt(messages, tools, toolChoice, entryStartIndex);
    sendImages = imagesFromMessages(messages, entryStartIndex);
    meta.sentPromptChars = sendPrompt.length;
    meta.inputImageCount = sendImages.length;
    debugLog(
      `continuing chat ${entry.chatUrl} — delta ${messages.length - entryStartIndex} msg(s), ${sendPrompt.length} chars (full replay would be ${prompt.length})`,
    );
    if (sendImages.length > 0) {
      // ChatGPT's current web composer reports "Max 0 uploads at a time"
      // after a conversation has completed its first turn. Rotate only the
      // image-bearing continuation into a fresh chat, replaying the full text
      // context while attaching only newly added images. The existing mapping
      // is replaced only after the fresh turn passes the raw safety audit.
      rotateImageConversation = true;
      activeEntry = null;
      sendPrompt = prompt;
      meta.conversationReused = false;
      meta.imageConversationRotated = true;
      meta.recoveryStage = "fresh-image-continuation";
      meta.sentPromptChars = sendPrompt.length;
      debugLog(
        `rotating image continuation from ${entry.chatUrl} — ${sendImages.length} new image(s), ${sendPrompt.length} chars`,
      );
    }
  }
  if (recoveryControl.forceFresh && !entry?.recovery) {
    activeEntry = null;
    rotateImageConversation = false;
    forceFreshRequest = true;
    sendPrompt = buildCompactRecoveryPrompt(
      recoveryMessages,
      tools,
      toolChoice,
      {
        error: "The user explicitly abandoned the previous ChatGPT branch.",
        policy,
        nudge:
          "Treat successful mutations in the execution ledger as committed and do not repeat them. Continue only incomplete work, or give the user the final answer when the requested action is already complete.",
      },
    );
    sendImages = recoveryImages;
    meta.conversationReused = false;
    meta.recoveryStage = "fresh-chat-requested";
    meta.sentPromptChars = sendPrompt.length;
    meta.inputImageCount = sendImages.length;
    noteRecovery("freshCompact");
  }

  const recoveryStartIndex = entry
    ? Math.min(
        recoveryControl.explicit
          ? messages
              .slice(0, entryStartIndex)
              .filter((message) => !isRecoveryControlMessage(message)).length
          : entryStartIndex,
        recoveryMessages.length,
      )
    : 0;
  const pendingRecoveryPrompt = messagesToPrompt(
    recoveryMessages,
    tools,
    toolChoice,
    recoveryStartIndex,
  );
  const persistNativeRecovery = (
    info,
    state,
    attempts = info.attempts || 0,
  ) => {
    if (!PERSIST_CHAT) return entry;
    entry = rememberConversationRecovery(
      entry,
      messages,
      info.chatUrl || entry?.chatUrl || null,
      {
        state,
        reason: info.reason || "native-tools",
        risk: info.risk,
        safeParentNode: info.safeParentNode,
        contaminatedNode: info.contaminatedNode,
        nativeCallNames: info.names,
        attempts,
        clearPendingTurn: false,
        key: conversationKey,
      },
      hasTools,
    );
    if (info.reason === "verification-unavailable")
      pendingRejectedReplies.delete(entry);
    if (state === "paused") {
      if (info.rejectedReply) cacheRejectedReply(entry, info);
      info.rejectedReplyAvailable =
        info.reason === "verification-unavailable"
          ? false
          : hasRejectedReply(entry);
    }
    return entry;
  };
  const recoverNativeTurn = async (
    info,
    explicit = false,
    forceFresh = false,
    { verificationAutomatic = false } = {},
  ) => {
    // Proven non-mutating states may be retried once per provider request even
    // when an older release left a high persisted attempt count. The old cap
    // permanently bricked otherwise healthy OpenCode sessions after a policy
    // or renderer bug. Side-effect-capable/unverifiable states still require
    // explicit consent and remain quarantined.
    const automatic =
      canAutomaticallyRecoverNativeTurn(info) ||
      (verificationAutomatic && info.reason === "verification-unavailable");
    if (!automatic && !explicit) {
      persistNativeRecovery(info, "paused", info.attempts);
      if (info.reason === "verification-unavailable") {
        throw verificationUnavailableError(messages, meta, info);
      }
      throw terminalNativeToolError(messages, meta, info);
    }

    const nextAttempt = info.attempts + 1;
    persistNativeRecovery(
      info,
      automatic && !explicit ? "auto-pending" : "paused",
      nextAttempt,
    );
    await resetRuntimeSession();
    meta.protocolAttempts += 1;
    meta.nativeToolRisk = info.risk;
    meta.recoveredNativeToolNames = info.names;
    meta.recoveryAttempt = nextAttempt;
    meta.recoveryParentVerified = !!info.safeParentNode;
    const finishRecovery = (value) => {
      // Attempt-local raw audit fields are cleared before each backend call;
      // restore the risk that explains why this successful recovery happened.
      meta.nativeToolRisk = info.risk;
      return value;
    };

    let candidatePrompt;
    let session;
    let attemptedSameChat = false;
    if (
      !forceFresh &&
      info.safeParentNode &&
      (info.chatUrl || entry?.chatUrl)
    ) {
      attemptedSameChat = true;
      candidatePrompt = pendingRecoveryPrompt;
      meta.recoveryStage = verificationAutomatic
        ? "same-chat-reverify"
        : "same-chat-branch";
      meta.sentPromptChars = candidatePrompt.length;
      meta.inputImageCount = sendImages.length;
      session = {
        chatUrl: info.chatUrl || entry.chatUrl,
        branchParentNode: info.safeParentNode,
        expectedPendingPrompt: candidatePrompt,
        expectedPendingUserMessageID: entry?.pendingTurn?.userMessageID || null,
        pendingTurnKnown: !!entry?.pendingTurn,
        images: sendImages,
      };
      noteRecovery("sameChat");
    } else {
      candidatePrompt = buildCompactRecoveryPrompt(
        recoveryMessages,
        tools,
        toolChoice,
        {
          error: "The previous ChatGPT branch could not be proven safe.",
          policy,
          nudge:
            "Treat successful mutations in the execution ledger as committed and do not repeat them. Continue only incomplete work, or give the user the final answer when the requested action is already complete.",
        },
      );
      meta.chatUrl = undefined;
      meta.recoveryStage =
        verificationAutomatic && !explicit
          ? "fresh-chat-verification-recovery"
          : automatic && !explicit
            ? "fresh-chat-safe-recovery"
            : "fresh-chat-consented";
      meta.sentPromptChars = candidatePrompt.length;
      meta.inputImageCount = recoveryImages.length;
      session = { images: recoveryImages };
      noteRecovery("freshCompact");
    }

    try {
      return finishRecovery(
        await invokeBackend(candidatePrompt, null, {
          ...session,
          meta,
          onThinking: thinkCb,
          model: intel.model,
          effort: intel.effort,
          signal,
          preferRawReply: true,
        }),
      );
    } catch (recoveryError) {
      assertCurrentRuntime();
      if (
        recoveryError?.verificationUnavailable &&
        verificationAutomatic &&
        attemptedSameChat
      ) {
        await resetRuntimeSession();
        const freshPrompt = buildCompactRecoveryPrompt(
          recoveryMessages,
          tools,
          toolChoice,
          {
            error: recoveryError.message,
            policy,
            nudge:
              "The exact delivered turn could not be re-verified. Treat successful mutations in the execution ledger as committed and do not repeat them. Continue only incomplete work, or give the final answer.",
          },
        );
        meta.chatUrl = undefined;
        meta.recoveryStage = explicit
          ? "fresh-chat-consented"
          : "fresh-chat-verification-recovery";
        meta.protocolAttempts += 1;
        meta.recoveryParentVerified = false;
        meta.sentPromptChars = freshPrompt.length;
        meta.inputImageCount = recoveryImages.length;
        noteRecovery("freshCompact");
        try {
          return finishRecovery(
            await invokeBackend(freshPrompt, null, {
              meta,
              onThinking: thinkCb,
              model: intel.model,
              effort: intel.effort,
              signal,
              preferRawReply: true,
              images: recoveryImages,
            }),
          );
        } catch (freshError) {
          recoveryError = freshError;
        }
      }
      if (recoveryError?.verificationUnavailable) throw recoveryError;
      if (
        explicit &&
        info.safeParentNode &&
        recoveryError?.continuationFailed
      ) {
        await resetRuntimeSession();
        const freshPrompt = buildCompactRecoveryPrompt(
          recoveryMessages,
          tools,
          toolChoice,
          {
            error: recoveryError.message,
            policy,
            nudge:
              "The verified sibling branch became unavailable. Treat successful mutations in the execution ledger as committed and do not repeat them. Continue only incomplete work, or give the final answer.",
          },
        );
        meta.chatUrl = undefined;
        meta.recoveryStage = "fresh-chat-consented";
        meta.protocolAttempts += 1;
        meta.recoveryParentVerified = false;
        meta.sentPromptChars = freshPrompt.length;
        meta.inputImageCount = recoveryImages.length;
        noteRecovery("freshCompact");
        try {
          return finishRecovery(
            await invokeBackend(freshPrompt, null, {
              meta,
              onThinking: thinkCb,
              model: intel.model,
              effort: intel.effort,
              signal,
              preferRawReply: true,
              images: recoveryImages,
            }),
          );
        } catch (freshError) {
          recoveryError = freshError;
        }
      }
      const isNativeRecoveryError =
        recoveryError?.nativeToolRecovery ||
        recoveryError?.nativeToolSuppression;
      if (!isNativeRecoveryError) {
        // A browser/session/rate-limit failure during recovery is not evidence
        // of native activity. Preserve the existing quarantine but surface the
        // transport error with its real category.
        persistNativeRecovery(info, "paused", nextAttempt);
        throw recoveryError;
      }
      const nextInfo = nativeRecoveryInfo(recoveryError, {
        ...info,
        attempts: nextAttempt,
        chatUrl: recoveryError?.chatUrl || info.chatUrl,
      });
      persistNativeRecovery(nextInfo, "paused", nextAttempt);
      throw terminalNativeToolError(messages, meta, nextInfo);
    }
  };

  let reply;
  if (continuedRejectedReply) {
    reply = continuedRejectedReply.reply;
  } else if (entry?.recovery) {
    const storedInfo = nativeRecoveryInfo(null, {
      ...entry.recovery,
      nativeCallNames: entry.recovery.nativeCallNames,
      safeParentNode:
        entry.recovery.safeParentNode || entry.rawCurrentNode || null,
      chatUrl: entry.chatUrl,
    });
    reply = await recoverNativeTurn(
      storedInfo,
      recoveryControl.explicit,
      recoveryControl.forceFresh,
      {
        verificationAutomatic: storedInfo.reason === "verification-unavailable",
      },
    );
  } else {
    try {
      reply = await invokeBackend(sendPrompt, streamCb, {
        chatUrl:
          rotateImageConversation || forceFreshRequest
            ? undefined
            : entry?.chatUrl,
        meta,
        onThinking: thinkCb,
        model: intel.model,
        effort: intel.effort,
        signal,
        preferRawReply: true,
        images: sendImages,
        expectedRawNode:
          rotateImageConversation || forceFreshRequest
            ? null
            : entry?.rawCurrentNode || null,
        expectedPendingPrompt:
          rotateImageConversation || forceFreshRequest
            ? null
            : pendingRecoveryPrompt,
        expectedPendingUserMessageID:
          rotateImageConversation || forceFreshRequest
            ? null
            : entry?.pendingTurn?.userMessageID || null,
        pendingTurnKnown:
          !rotateImageConversation &&
          !forceFreshRequest &&
          !!entry?.pendingTurn,
      });
    } catch (err) {
      assertCurrentRuntime();
      if (err?.transientReply) {
        // The authenticated audit proved this was a clean ChatGPT service
        // banner, not an assistant answer. Do not persist it as a pending turn
        // or let a future retry adopt it; the next OpenCode retry starts clean.
        if (entry) forgetConversation(entry);
        throw err;
      }
      if (err?.verificationUnavailable) throw err;
      if (meta.messageSubmitted && entry && !rotateImageConversation) {
        rememberConversationPendingTurn(entry, sendPrompt, {
          boundaryNode: meta.rawBeforeNode || entry.rawCurrentNode || null,
          userMessageID: meta.outboundUserMessageID || null,
          attempts: meta.protocolAttempts,
        });
      }
      if (err?.nativeToolSuppression && !meta.messageSubmitted) {
        // Pre-send failures cannot have changed ChatGPT conversation state.
        // Surface them directly without creating a quarantine record.
        throw err;
      }
      if (err?.nativeToolRecovery || err?.nativeToolSuppression) {
        const info = nativeRecoveryInfo(err, {
          chatUrl:
            err?.chatUrl ||
            meta.chatUrl ||
            (rotateImageConversation ? null : entry?.chatUrl),
          safeParentNode:
            (rotateImageConversation ? null : entry?.rawCurrentNode) ||
            meta.rawBeforeNode ||
            null,
        });
        reply = await recoverNativeTurn(
          info,
          recoveryControl.explicit,
          recoveryControl.forceFresh,
        );
      } else {
        if (!entry || !err?.continuationFailed) throw err;
        // A continuationFailed error means ChatGPT proved this persisted URL is
        // no longer a usable conversation (deleted, redirected to home, etc.).
        // Keeping it in the store makes every later OpenCode retry hit the same
        // dead URL before falling back again. Invalidate it immediately, then
        // let the successful fresh turn register a brand-new mapping below.
        //
        // Deliberately clear `entry` as well as removing it from the store:
        // rememberConversation(entry, ...) updates an existing object in place,
        // so passing a forgotten object would not re-add the replacement chat.
        const deadChatUrl = entry.chatUrl;
        forgetConversation(entry);
        pendingRejectedReplies.delete(entry);
        entry = null;
        activeEntry = null;
        meta.conversationReused = false;
        meta.invalidatedConversationUrl = deadChatUrl;
        debugLog(
          `chat continuation failed (${err.message}); retrying with compact recovery`,
        );
        sendPrompt = buildCompactRecoveryPrompt(messages, tools, toolChoice, {
          error: err.message,
          policy,
          nudge:
            "The previous ChatGPT conversation could not be opened. Continue from the bounded context and request only the next necessary tool.",
        });
        meta.chatUrl = undefined;
        meta.recoveryStage = "fresh-compact";
        meta.protocolAttempts += 1;
        meta.sentPromptChars = sendPrompt.length;
        meta.inputImageCount = recoveryImages.length;
        noteRecovery("freshCompact");
        reply = await invokeBackend(sendPrompt, streamCb, {
          meta,
          onThinking: thinkCb,
          model: intel.model,
          effort: intel.effort,
          signal,
          preferRawReply: true,
          images: recoveryImages,
        });
      }
    }
  }
  reply = rejectNativeToolDetours(reply);

  // A full replay is usually what caused the length problem. Recover from a
  // deterministic bounded packet and swap the mapping only after success.
  if (isConversationTooLong(reply)) {
    if (meta.protocolAttempts >= 3) {
      throw terminalToolError(
        "ChatGPT conversation remained over its length limit after compact recovery",
        messages,
        meta,
        "conversationTooLong",
      );
    }
    debugLog(
      `conversation length limit hit${entry ? ` on ${entry.chatUrl}` : ""}; retrying with compact recovery`,
    );
    sendPrompt = buildCompactRecoveryPrompt(messages, tools, toolChoice, {
      rejectedReply: reply,
      error: "ChatGPT reported that the conversation was too long.",
      policy,
      nudge:
        "Continue with only the next necessary tool request or a concise final answer.",
    });
    meta.chatUrl = undefined;
    meta.recoveryStage = "fresh-compact";
    meta.protocolAttempts += 1;
    meta.sentPromptChars = sendPrompt.length;
    meta.inputImageCount = recoveryImages.length;
    noteRecovery("freshCompact");
    reply = await invokeBackend(sendPrompt, streamCb, {
      meta,
      onThinking: thinkCb,
      model: intel.model,
      effort: intel.effort,
      signal,
      preferRawReply: true,
      images: recoveryImages,
    });
    reply = rejectNativeToolDetours(reply);
    if (isConversationTooLong(reply)) {
      throw terminalToolError(
        "ChatGPT conversation hit its length cap during compact recovery",
        messages,
        meta,
        "conversationTooLong",
      );
    }
  }

  let parsed = hasTools
    ? parseToolCallsResult(reply, tools, policy)
    : { calls: [], error: null };
  let calls = parsed.calls;
  let parseError = parsed.error;
  const wantsGdoc = userAskedForGoogleDoc(messages);
  const wantsRemote = userAskedForRemoteProbe(messages);
  const wantsBuild = userAskedToBuildLocal(messages);
  const canBash = hasBashTool(tools);
  const canWrite = hasFileWriteTool(tools);
  // Only successful write-capable tool results unlock build success claims.
  const buildProof = canClaimLocalBuildSuccess(messages);
  const fakeEnv = isFakeEnvironmentBlock(reply);
  const fakeLocal =
    !buildProof &&
    isFakeLocalFileDeliverable(reply, { userAskedBuild: wantsBuild });
  const fakeGdoc =
    isFakeGoogleDocsDeliverable(reply) ||
    (wantsGdoc && REFUSAL_RE.test(reply) && !calls.length);
  const canUseGdoc = hasGoogleDocsTool(tools);
  const visualReviewReady = tuiVisualReviewReady(messages);
  const incompleteTuiVisual = visualReviewReady === false;
  const canUseTuiVisual = tools.some(
    (tool) =>
      String(tool?.function?.name || tool?.name || "") === "tui_visual_test",
  );
  const enforceTuiVisual =
    incompleteTuiVisual &&
    canUseTuiVisual &&
    (policy.mode === "auto" ||
      policy.mode === "required" ||
      policy.expectedTool === "tui_visual_test");
  const lastUserText = contentToText(
    [...(messages || [])].reverse().find((m) => m?.role === "user")?.content,
  );
  const editingExisting = /\bdocs\.google\.com\/document\/d\//i.test(
    lastUserText,
  );
  // Plan-only asks may return text, but may not claim ChatGPT tested or
  // reached the user's environment without OpenCode execution proof.
  const planningClaim =
    calls.length === 0 &&
    userAskedToPlan(messages) &&
    !parseError &&
    fakeEnv &&
    !isHardToolRefusal(reply);

  // User asked for Google Docs work but tools vanished mid-flight (shouldn't
  // happen after the early check) — still fail loudly.
  if (calls.length === 0 && wantsGdoc && !canUseGdoc) {
    const err = new Error(
      "Google Docs MCP tools are missing from this request — restart OpenCode so google-docs can connect. Do not accept ChatGPT connected-apps advice.",
    );
    err.mcpMissing = true;
    throw err;
  }

  // Invented SSH/environment blockers with bash available — never accept as final.
  // (Nudge path below also catches this; this rejects if somehow no tools.)
  if (calls.length === 0 && fakeEnv && wantsRemote && !canBash) {
    const err = new Error(
      "Model claimed SSH/network is blocked but bash tool is missing from this request — restart OpenCode.",
    );
    err.fakeDeliverable = true;
    throw err;
  }

  const shouldNudge =
    calls.length === 0 &&
    hasTools &&
    (!!parseError ||
      mustUseTool ||
      enforceTuiVisual ||
      planningClaim ||
      (wantsGdoc && fakeGdoc && canUseGdoc) ||
      (wantsRemote && fakeEnv && canBash) ||
      (fakeLocal && canWrite));
  if (shouldNudge) {
    const useChoiceNudge =
      !!parseError && /^(?:Tool choice|Named tool choice)/.test(parseError);
    const useMalformedNudge = !!parseError && !useChoiceNudge;
    const useTuiNudge =
      !useChoiceNudge && !useMalformedNudge && enforceTuiVisual;
    const usePlanNudge =
      !useChoiceNudge && !useMalformedNudge && !useTuiNudge && planningClaim;
    const useGdocsNudge =
      !useChoiceNudge &&
      !useMalformedNudge &&
      !useTuiNudge &&
      !usePlanNudge &&
      wantsGdoc &&
      fakeGdoc &&
      canUseGdoc;
    const useBashNudge =
      !useChoiceNudge &&
      !useMalformedNudge &&
      !useGdocsNudge &&
      canBash &&
      wantsRemote &&
      fakeEnv;
    const useWriteNudge =
      !useChoiceNudge &&
      !useMalformedNudge &&
      !useGdocsNudge &&
      !useBashNudge &&
      canWrite &&
      fakeLocal;
    debugLog(
      useChoiceNudge
        ? `[server] explicit tool-choice violation (${parseError}); retrying with mode correction`
        : useMalformedNudge
          ? `[server] malformed TOOL_CALL (${parseError}); retrying with regenerate nudge`
          : useTuiNudge
            ? "[server] incomplete native TUI visual coverage; retrying with matrix nudge"
            : usePlanNudge
              ? "[server] planning reply claimed unverified environment state; retrying with text-only correction"
              : useGdocsNudge
                ? "[server] fake Google Doc / connected-apps refusal; retrying with google-docs_* nudge"
                : useBashNudge
                  ? "[server] fake SSH/environment-block refusal; retrying with bash nudge"
                  : useWriteNudge
                    ? "[server] fake ChatGPT-sandbox file/app deliverable; retrying with local write nudge"
                    : "[server] tools expected but no TOOL_CALL; retrying once with nudge",
    );
    // With a live chat, nudge as a follow-up message in that SAME chat (the
    // prompt is already there); otherwise fall back to full prompt + nudge.
    // Nudges never stream answer text (tools expected); thinking still ok.
    const nudgeText = useMalformedNudge
      ? malformedToolNudge(parseError, { hasBash: canBash })
      : useChoiceNudge
        ? toolRetryNudge(policy)
        : useTuiNudge
          ? TUI_VISUAL_NUDGE
          : usePlanNudge
            ? PLAN_ENV_NUDGE
            : useGdocsNudge
              ? editingExisting || !hasGoogleDocsCreateTool(tools)
                ? GDOCS_EDIT_NUDGE
                : GDOCS_CREATE_NUDGE
              : useBashNudge
                ? BASH_SSH_NUDGE
                : useWriteNudge
                  ? LOCAL_WRITE_NUDGE
                  : toolRetryNudge(policy);
    if (meta.protocolAttempts >= 3) {
      throw terminalToolError(
        parseError
          ? `Invalid tool request after ${meta.protocolAttempts} attempts: ${parseError}`
          : `Required OpenCode tool was not requested after ${meta.protocolAttempts} attempts`,
        messages,
        meta,
        parseError && !useChoiceNudge ? "malformedToolCall" : "toolPolicy",
      );
    }
    const nudgeChat = PERSIST_CHAT
      ? meta.chatUrl || entry?.chatUrl || null
      : null;
    meta.protocolAttempts += 1;
    if (nudgeChat) {
      meta.recoveryStage = "same-chat";
      meta.sentPromptChars = nudgeText.trim().length;
      noteRecovery("sameChat");
      reply = await invokeBackend(nudgeText.trim(), null, {
        chatUrl: nudgeChat,
        meta,
        onThinking: thinkCb,
        model: intel.model,
        effort: intel.effort,
        signal,
        preferRawReply: true,
      });
    } else {
      const recoveryPrompt = buildCompactRecoveryPrompt(
        messages,
        tools,
        toolChoice,
        {
          rejectedReply: reply,
          error:
            parseError ||
            "The model did not request the required OpenCode tool.",
          nudge: nudgeText,
          policy,
        },
      );
      meta.recoveryStage = "fresh-compact";
      meta.sentPromptChars = recoveryPrompt.length;
      meta.inputImageCount = recoveryImages.length;
      noteRecovery("freshCompact");
      reply = await invokeBackend(recoveryPrompt, null, {
        meta,
        onThinking: thinkCb,
        model: intel.model,
        effort: intel.effort,
        signal,
        preferRawReply: true,
        images: recoveryImages,
      });
    }
    reply = rejectNativeToolDetours(reply);
    if (isConversationTooLong(reply)) {
      // Nudge itself hit the length cap — escalate to fresh chat below.
      debugLog("nudge hit conversation length limit; escalating to fresh chat");
    } else {
      parsed = parseToolCallsResult(reply, tools, policy);
      calls = parsed.calls;
      parseError = parsed.error;
    }

    // Still a fake .docx / connected-apps claim after the docs nudge — escalate
    // (below) rather than throwing so ChatGPT can see a fresh transcript + nudge.
    // Malformed after in-chat nudge: same — fall through to fresh-chat escalation.

    // Under auto/none, any ordinary text is valid. Only explicit proof guards
    // and malformed/forbidden tool envelopes remain correction-worthy.
    const postNudgeSafeText =
      calls.length === 0 &&
      !useTuiNudge &&
      !policy.required &&
      !parseError &&
      !isConversationTooLong(reply) &&
      !isFakeGoogleDocsDeliverable(reply) &&
      !(wantsGdoc && REFUSAL_RE.test(reply)) &&
      !isFakeEnvironmentBlock(reply) &&
      !isFakeLocalFileDeliverable(reply, { userAskedBuild: wantsBuild }) &&
      !(userAskedToPlan(messages) && isHardToolRefusal(reply));

    // Escalation: retry once in a fresh chat with a bounded recovery packet.
    // Retain the old mapping until rememberTurn atomically updates it.
    if (
      calls.length === 0 &&
      !postNudgeSafeText &&
      (isConversationTooLong(reply) ||
        mustUseTool ||
        useChoiceNudge ||
        useBashNudge ||
        useGdocsNudge ||
        useWriteNudge ||
        usePlanNudge ||
        useMalformedNudge ||
        useTuiNudge)
    ) {
      if (meta.protocolAttempts >= 3) {
        throw terminalToolError(
          parseError
            ? `Invalid tool request after ${meta.protocolAttempts} attempts: ${parseError}`
            : `Required OpenCode tool was not requested after ${meta.protocolAttempts} attempts`,
          messages,
          meta,
          parseError && !useChoiceNudge ? "malformedToolCall" : "toolPolicy",
        );
      }
      debugLog(
        "nudge failed; retrying once in a fresh chat with compact context",
      );
      const recoveryPrompt = buildCompactRecoveryPrompt(
        messages,
        tools,
        toolChoice,
        {
          rejectedReply: reply,
          error:
            parseError ||
            "The model did not request the required OpenCode tool.",
          nudge: nudgeText,
          policy,
        },
      );
      meta.chatUrl = undefined;
      meta.recoveryStage = "fresh-compact";
      meta.protocolAttempts += 1;
      meta.sentPromptChars = recoveryPrompt.length;
      meta.inputImageCount = recoveryImages.length;
      noteRecovery("freshCompact");
      reply = await invokeBackend(recoveryPrompt, null, {
        meta,
        onThinking: thinkCb,
        model: intel.model,
        effort: intel.effort,
        signal,
        preferRawReply: true,
        images: recoveryImages,
      });
      reply = rejectNativeToolDetours(reply);
      if (isConversationTooLong(reply)) {
        throw terminalToolError(
          "ChatGPT conversation hit its length cap during compact recovery",
          messages,
          meta,
          "conversationTooLong",
        );
      } else {
        parsed = parseToolCallsResult(reply, tools, policy);
        calls = parsed.calls;
        parseError = parsed.error;
      }
      if (
        calls.length === 0 &&
        useGdocsNudge &&
        isFakeGoogleDocsDeliverable(reply)
      ) {
        const err = new Error(
          "Model refused google-docs_* after escalation — rejected. Restart OpenCode if google-docs MCP failed, then retry.",
        );
        err.fakeDeliverable = true;
        throw terminalToolError(err.message, messages, meta, "fakeDeliverable");
      }
      if (calls.length === 0 && useBashNudge && isFakeEnvironmentBlock(reply)) {
        const err = new Error(
          "Model still invented SSH/environment blockers after escalation — rejected. Retry with a shorter prompt forcing bash.",
        );
        err.fakeDeliverable = true;
        throw terminalToolError(err.message, messages, meta, "fakeDeliverable");
      }
      if (
        calls.length === 0 &&
        useWriteNudge &&
        isFakeLocalFileDeliverable(reply, { userAskedBuild: wantsBuild })
      ) {
        const err = new Error(
          "Model still invented a ChatGPT-sandbox app/file deliverable after escalation — rejected. Retry forcing bash/write TOOL_CALL.",
        );
        err.fakeDeliverable = true;
        throw terminalToolError(err.message, messages, meta, "fakeDeliverable");
      }
      if (
        calls.length === 0 &&
        (useMalformedNudge || useChoiceNudge) &&
        parseError
      ) {
        throw terminalToolError(
          `Invalid tool request after compact recovery: ${parseError}`,
          messages,
          meta,
          useMalformedNudge ? "malformedToolCall" : "toolPolicy",
        );
      }
      if (
        calls.length === 0 &&
        usePlanNudge &&
        (isFakeEnvironmentBlock(reply) || isHardToolRefusal(reply))
      ) {
        const err = new Error(
          "Planning reply still claimed unverified ChatGPT environment state after correction.",
        );
        err.toolPolicy = true;
        throw terminalToolError(err.message, messages, meta, "toolPolicy");
      }
    }
  }

  // Final safety nets BEFORE rememberTurn — never persist a rejected reply or
  // exceed the shared three-attempt recovery budget.
  if (
    (!calls || calls.length === 0) &&
    hasBashTool(tools) &&
    userAskedForRemoteProbe(messages) &&
    isFakeEnvironmentBlock(reply)
  ) {
    const err = new Error(
      "Rejected invented SSH/environment-block answer — bash on this host can reach netcup. Retry.",
    );
    err.fakeDeliverable = true;
    throw terminalToolError(err.message, messages, meta, "fakeDeliverable");
  }
  if (
    (!calls || calls.length === 0) &&
    !canClaimLocalBuildSuccess(messages) &&
    hasFileWriteTool(tools) &&
    isFakeLocalFileDeliverable(reply, { userAskedBuild: wantsBuild })
  ) {
    const err = new Error(
      "Rejected ChatGPT-sandbox file/app claim — nothing was written on your machine. Retry; model must TOOL_CALL write/bash.",
    );
    err.fakeDeliverable = true;
    throw terminalToolError(err.message, messages, meta, "fakeDeliverable");
  }
  if (
    (!calls || calls.length === 0) &&
    userAskedToPlan(messages) &&
    (isFakeEnvironmentBlock(reply) || isHardToolRefusal(reply))
  ) {
    const err = new Error(
      "Rejected planning answer that claimed unverified ChatGPT environment limits.",
    );
    err.toolPolicy = true;
    throw terminalToolError(err.message, messages, meta, "toolPolicy");
  }
  if ((!calls || calls.length === 0) && policy.required) {
    const err = new Error(
      policy.expectedTool
        ? `Named tool choice required exactly "${policy.expectedTool}", but ChatGPT returned text.`
        : "Tool choice 'required' was not satisfied because ChatGPT returned text.",
    );
    err.toolPolicy = true;
    throw terminalToolError(err.message, messages, meta, "toolPolicy");
  }
  if ((!calls || calls.length === 0) && enforceTuiVisual) {
    const err = new Error(
      "Rejected final TUI verdict because tui_visual_test coverage is incomplete",
    );
    err.toolPolicy = true;
    throw terminalToolError(err.message, messages, meta, "toolPolicy");
  }
  if ((!calls || calls.length === 0) && parseError) {
    const err = new Error(`Rejected malformed tool request: ${parseError}`);
    err.malformedToolCall = true;
    throw terminalToolError(err.message, messages, meta, "malformedToolCall");
  }
  rememberTurn(entry, messages, reply, calls, meta.chatUrl, hasTools, meta);
  if (entry) pendingRejectedReplies.delete(entry);
  if (continuedRejectedReply) {
    // The captured reply has now passed the ordinary OpenCode envelope and
    // policy checks. Dispose the browser that owns the fail-closed firewall
    // latch before returning its tool call, so the subsequent tool-result turn
    // starts with a clean browser/firewall and can finish normally.
    await resetRuntimeSession();
    meta.firewallResetAfterOverride = true;
  }
  noteCleanSend();
  return { reply, calls, meta };
}

/**
 * In-process completion entrypoint used by the native OpenCode provider.
 * It preserves the same serialized browser, persistence, validation, nudge,
 * cancellation, and adaptive-cooldown behavior as the HTTP compatibility
 * route without opening a localhost socket.
 */
export async function completeChatGPTWeb({
  messages,
  tools = [],
  toolChoice,
  model = "gpt-5.6-sol-high",
  onToken = null,
  onThinking = null,
  onStatus = null,
  signal = null,
  backendRunner = runBackend,
  resetSession = resetSharedSession,
} = {}) {
  const prompt = messagesToPrompt(messages, tools, toolChoice);
  if (LOCAL_TITLE && isTitleGenerationRequest(messages, tools)) {
    return {
      reply: localTitleFromMessages(messages),
      calls: [],
      meta: { localTitle: true },
      prompt,
    };
  }

  const started = Date.now();
  const controller = new AbortController();
  const budgetController = new AbortController();
  const preSubmitController = new AbortController();
  const budgetMessage = `ChatGPT web turn exceeded the ${Math.round(TURN_HARD_CAP_MS / 1000)}s total budget`;
  const preSubmitMessage = `ChatGPT browser setup exceeded ${Math.round(PRE_SUBMIT_TIMEOUT_MS / 1000)}s before a firewall-verified Send; no ChatGPT message was sent`;
  let turnTimer;
  let preSubmitTimer;
  let generationBudgetStarted = false;
  let messageSubmitted = false;
  let lastPhase = "queued";
  let queueWaitMs = 0;
  let cleanupState = "not-needed";
  let busyToken = null;
  const pauseBudget = () => {
    clearTimeout(turnTimer);
    turnTimer = undefined;
  };
  const resumeBudget = () => {
    if (!generationBudgetStarted || budgetController.signal.aborted) return;
    pauseBudget();
    turnTimer = setTimeout(() => {
      budgetController.abort(budgetMessage);
    }, TURN_HARD_CAP_MS);
  };
  const clearPreSubmit = () => {
    clearTimeout(preSubmitTimer);
    preSubmitTimer = undefined;
  };
  const beginPreSubmit = () => {
    if (preSubmitController.signal.aborted || preSubmitTimer) return;
    lastPhase = "pre-submit";
    preSubmitTimer = setTimeout(() => {
      preSubmitController.abort(preSubmitMessage);
    }, PRE_SUBMIT_TIMEOUT_MS);
  };
  const markMessageSubmitted = () => {
    messageSubmitted = true;
    clearPreSubmit();
    if (!generationBudgetStarted) {
      generationBudgetStarted = true;
      resumeBudget();
    }
  };
  const activeSignal = signal
    ? AbortSignal.any([
        signal,
        controller.signal,
        preSubmitController.signal,
        budgetController.signal,
      ])
    : AbortSignal.any([
        controller.signal,
        preSubmitController.signal,
        budgetController.signal,
      ]);
  const safeStatus = (value) => {
    if (value?.phase) lastPhase = String(value.phase);
    emitProviderStatus(onStatus, value);
  };
  try {
    const out = await serialized(
      async ({ queueWaitMs: waited, isCurrent }) => {
        queueWaitMs = waited;
        setActiveController(controller);
        busyToken = beginBusy(tools.length ? "tools" : "chat", prompt);
        lastPhase = "starting";
        try {
          const runtime = {
            onStatus: (value) => {
              if (!isCurrent()) return;
              safeStatus(value);
            },
            pauseBudget,
            resumeBudget,
            beginPreSubmit,
            onMessageSubmitted: markMessageSubmitted,
            isCurrent,
            resetSharedSession: resetSession,
          };
          const runCompletion = () =>
            runWithToolRetry(
              prompt,
              tools,
              messages,
              toolChoice,
              onToken,
              onThinking,
              resolveChatIntelligence(model),
              activeSignal,
              backendRunner,
              runtime,
            );
          let result;
          try {
            result = await runCompletion();
          } catch (error) {
            if (!error?.verificationUnavailable || activeSignal.aborted)
              throw error;
            safeStatus({
              label: "Re-verifying the delivered ChatGPT turn",
              phase: "reverify-delivered",
            });
            result = await runCompletion();
          }
          result.meta = {
            ...result.meta,
            queueWaitMs,
            failureStage: result.meta?.failureStage || lastPhase,
            messageSubmitted:
              result.meta?.messageSubmitted === true || messageSubmitted,
            cleanupState,
          };
          return result;
        } finally {
          clearActiveController(controller);
          endBusy(busyToken);
        }
      },
      {
        signal: activeSignal,
        abortGraceMs: TURN_ABORT_GRACE_MS,
        onQueued: ({ position }) => {
          lastPhase = "queued";
          safeStatus({
            label: "Waiting for earlier ChatGPT turn",
            phase: "queued",
            position,
          });
        },
        onAbandon: async () => {
          cleanupState = "discarding-stale-browser";
          try {
            await resetSession();
            cleanupState = "stale-browser-discarded";
          } catch {
            cleanupState = "stale-browser-discard-failed";
          }
        },
      },
    );
    if (out.meta?.streamAbandoned) {
      const err = new Error(
        "Stream abandoned: ChatGPT rewrote the reply incompatibly with already-streamed text",
      );
      err.streamAbandoned = true;
      throw err;
    }
    recordRequest({
      ok: true,
      kind: out.calls.length ? "tool_calls" : "chat",
      ms: Date.now() - started,
      charsIn: prompt.length,
      charsOut: out.reply.length,
      chatUrl: out.meta?.chatUrl || null,
      streamed: Number(out.meta?.streamedChars || 0) > 0,
      reasoning: !!out.meta?.thinking,
      recoveryStage: out.meta?.recoveryStage,
      protocolAttempts: out.meta?.protocolAttempts,
      sentPromptChars: out.meta?.sentPromptChars,
      fullPromptChars: out.meta?.fullPromptChars,
      conversationReused: out.meta?.conversationReused,
      replySource: out.meta?.replySource,
      replyRecovery: out.meta?.replyRecovery,
      nativeToolInspection: out.meta?.nativeToolInspection,
      nativeToolNames: out.meta?.nativeToolNames,
      nativeToolSuppression: out.meta?.nativeToolSuppression,
      memorySuppression: out.meta?.memorySuppression,
      disabledFeatureCount: out.meta?.disabledFeatureCount,
      disabledToolCount: out.meta?.disabledToolCount,
      appPreflight: out.meta?.appPreflight,
      nativeToolRisk: out.meta?.nativeToolRisk,
      rawNodeClass: out.meta?.rawNodeClass,
      rawAuditReason: out.meta?.rawAuditReason,
      deliveryState: out.meta?.deliveryState,
      recoveredNativeToolNames: out.meta?.recoveredNativeToolNames,
      recoveryAttempt: out.meta?.recoveryAttempt,
      recoveryParentVerified: out.meta?.recoveryParentVerified,
      inputImageCount: out.meta?.inputImageCount,
      uploadedImageCount: out.meta?.uploadedImageCount,
      rateLimitRetries: out.meta?.rateLimitRetries,
      rateLimitWaitMs: out.meta?.rateLimitWaitMs,
      rateLimitSource: out.meta?.rateLimitSource,
      unverifiedReplyAuthorized: out.meta?.unverifiedReplyAuthorized,
      firewallResetAfterOverride: out.meta?.firewallResetAfterOverride,
      firewallResetAfterVerificationFailure:
        out.meta?.firewallResetAfterVerificationFailure,
      queueWaitMs: out.meta?.queueWaitMs,
      failureStage: out.meta?.failureStage,
      messageSubmitted: out.meta?.messageSubmitted,
      rawReader: out.meta?.rawReader,
      rawReaderOutcomes: out.meta?.rawReaderOutcomes,
      cleanupState: out.meta?.cleanupState,
    });
    return { ...out, prompt };
  } catch (caught) {
    let err = caught;
    if (preSubmitController.signal.aborted) {
      err = Object.assign(
        new Error(
          `${preSubmitMessage}. Retry safely; no TUI restart is required.`,
        ),
        {
          chatgptWebErrorCode: PRE_SUBMIT_TIMEOUT_CODE,
          preSubmitTimeout: true,
          messageSubmitted: false,
          failureStage: lastPhase,
          queueWaitMs,
          cleanupState,
          recoveryActions: ["retry fresh", "retry", "dismiss"],
        },
      );
    } else if (budgetController.signal.aborted) {
      err = Object.assign(
        new Error(
          `${budgetMessage}. The attempt was cancelled and its browser lease was discarded; retry without restarting the TUI.`,
        ),
        {
          chatgptWebErrorCode: TURN_BUDGET_EXCEEDED_CODE,
          turnBudgetExceeded: true,
          messageSubmitted,
          failureStage: lastPhase,
          queueWaitMs,
          cleanupState,
          recoveryActions: ["retry", "retry fresh", "dismiss"],
        },
      );
    }
    endBusy(busyToken);
    recordRequest({
      ok: false,
      kind: "error",
      ms: Date.now() - started,
      charsIn: prompt.length,
      charsOut: 0,
      error: humanizeError(err),
      recoveryStage: err.recoveryStage,
      protocolAttempts: err.protocolAttempts,
      nativeToolSuppression: err.nativeToolSuppressionState,
      nativeToolInspection: err.nativeToolInspectionUnavailable
        ? "unavailable"
        : undefined,
      nativeToolNames: err.nativeToolNames,
      nativeToolSideEffectsPossible: err.nativeToolSideEffectsPossible,
      nativeToolRisk: err.nativeToolRisk,
      rawNodeClass: err.rawNodeClass,
      rawAuditReason: err.rawAuditReason,
      deliveryState: err.deliveryState,
      recoveryAttempt: err.recoveryAttempt,
      recoveryParentVerified: err.recoveryParentVerified,
      chatgptWebErrorCode: err.chatgptWebErrorCode,
      rejectedReplyAvailable: err.rejectedReplyAvailable,
      recoveryActions: err.recoveryActions,
      firewallResetAfterVerificationFailure:
        err.verificationUnavailable === true,
      fullPromptChars: prompt.length,
      inputImageCount: imagesFromMessages(messages).length,
      rateLimitRetries: err.rateLimitRetries,
      rateLimitWaitMs: err.rateLimitWaitMs,
      rateLimitSource: err.rateLimitSource,
      queueWaitMs: err.queueWaitMs ?? queueWaitMs,
      failureStage: err.failureStage || lastPhase,
      messageSubmitted: err.messageSubmitted === true || messageSubmitted,
      rawReader: err.rawReader,
      rawReaderOutcomes: err.rawReaderOutcomes,
      cleanupState: err.cleanupState || cleanupState,
    });
    throw err;
  } finally {
    pauseBudget();
    clearPreSubmit();
  }
}

// Dry-run reply so smoke tests never touch the account.
function dryRunReply(message) {
  return `[DRY RUN] No request was sent to ChatGPT. Would have sent:\n\n"""${message}"""\n\nSet DRY_RUN=0 to send for real.`;
}

// ---- OpenAI-shaped SSE chunk helpers ----------------------------------------
function oaiChatChunk(id, model, delta) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  };
}
function oaiReasoningChunk(id, model, delta) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { reasoning_content: delta, reasoning: delta },
        finish_reason: null,
      },
    ],
  };
}
function oaiChatChunkFinal(id, model, finishReason = "stop") {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };
}
function oaiToolCallChunk(id, model, calls) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { tool_calls: toolCallsPayload(calls) },
        finish_reason: null,
      },
    ],
  };
}

/**
 * AbortController for one HTTP request. Client disconnect OR POST /cancel
 * aborts Playwright. The controller is created immediately but only registered
 * as *active* (cancellable / busy) when activate() runs inside the serialized
 * queue — so a waiting request cannot steal /cancel from the in-flight one.
 * Returns { signal, activate, dispose }.
 */
function attachRequestAbort(req, res, reason = "client disconnected") {
  const ac = new AbortController();
  const onClose = () => {
    if (!res.writableEnded && !ac.signal.aborted) {
      try {
        ac.abort(reason);
      } catch {
        /* ignore */
      }
    }
  };
  req.on("close", onClose);
  let activated = false;
  return {
    signal: ac.signal,
    activate(kind, preview) {
      setActiveController(ac);
      beginBusy(kind, preview);
      activated = true;
    },
    dispose() {
      req.off("close", onClose);
      if (activated) {
        clearActiveController(ac);
        endBusy();
        activated = false;
      }
    },
  };
}

// ---- HTTP handler ------------------------------------------------------------
const server =
  import.meta.main && process.env.CHATGPT_WEB_NO_SERVER !== "1"
    ? createServer(async (req, res) => {
        // CORS (handy for browser-based callers; bound to localhost by default).
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          return res.end();
        }

        // Status dashboard (self-refreshing HTML)
        if (
          req.method === "GET" &&
          (req.url === "/" || req.url.startsWith("/?"))
        ) {
          const html = statusPageHtml(
            getStatus({
              backend: BACKEND,
              dryRun: DRY_RUN,
              persistChat: PERSIST_CHAT,
              localTitle: LOCAL_TITLE,
              liveStream: false,
              requestedLiveStream: LIVE_STREAM,
              answerSource: "raw-conversation",
              streamThinking: STREAM_THINKING,
              chatModel: CHAT_MODEL,
              chatEffort: CHAT_EFFORT,
              trackedChats: trackedConversations(),
              chats: listConversations(),
              storeFile: STORE_ENABLED ? STORE_FILE : null,
            }),
          );
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          });
          return res.end(html);
        }

        // Health
        if (req.method === "GET" && req.url === "/health") {
          return sendJson(
            res,
            200,
            getStatus({
              backend: BACKEND,
              dryRun: DRY_RUN,
              persistChat: PERSIST_CHAT,
              localTitle: LOCAL_TITLE,
              liveStream: false,
              requestedLiveStream: LIVE_STREAM,
              answerSource: "raw-conversation",
              streamThinking: STREAM_THINKING,
              chatModel: CHAT_MODEL,
              chatEffort: CHAT_EFFORT,
              trackedChats: trackedConversations(),
              chats: listConversations(),
              storeFile: STORE_ENABLED ? STORE_FILE : null,
              cooldownBaseMs: COOLDOWN_BASE_MS,
              cooldownMinMs: COOLDOWN_MIN_MS,
              cooldownMaxMs: COOLDOWN_MAX_MS,
            }),
          );
        }

        // Cancel the in-flight ChatGPT turn (unstick OpenCode "loading").
        if (
          req.method === "POST" &&
          (req.url === "/cancel" || req.url.startsWith("/cancel?"))
        ) {
          const cancelled = requestCancel("manual cancel");
          debugLog(
            `POST /cancel → ${cancelled ? "aborted active request" : "nothing in flight"}`,
          );
          return sendJson(res, 200, { ok: true, cancelled });
        }

        // ---- OpenAI-compatible route ----
        if (
          req.method === "GET" &&
          (req.url === "/v1/models" || req.url.startsWith("/v1/models?"))
        ) {
          const created = Math.floor(Date.now() / 1000);
          // OpenCode model ids are the path segment after the provider name.
          // Keep "gpt" as a stable alias so existing configs keep working.
          const models = [
            { id: "gpt", object: "model", created, owned_by: "chatgpt-local" },
            {
              id: "gpt-5.6-sol",
              object: "model",
              created,
              owned_by: "chatgpt-local",
            },
            {
              id: "gpt-5.6-sol-high",
              object: "model",
              created,
              owned_by: "chatgpt-local",
            },
            {
              id: "gpt-5.6-sol-medium",
              object: "model",
              created,
              owned_by: "chatgpt-local",
            },
            {
              id: "gpt-5.6-sol-instant",
              object: "model",
              created,
              owned_by: "chatgpt-local",
            },
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: models }));
          return;
        }

        if (req.method === "POST" && req.url === "/v1/conversations/forget") {
          let body;
          try {
            body = await readJson(req);
            const conversationKey = body?.conversation_key;
            if (
              typeof conversationKey !== "string" ||
              !OVERLEAF_CONVERSATION_KEY.test(conversationKey)
            ) {
              throw new Error(
                "`conversation_key` must be an Overleaf session key",
              );
            }
            const forgotten = await serialized(async () =>
              forgetConversationByKey(conversationKey),
            );
            return sendJson(res, 200, { ok: true, forgotten });
          } catch (e) {
            const status = e.status === 413 ? 413 : 400;
            return sendJson(res, status, { error: { message: e.message } });
          }
        }

        if (req.method === "POST" && req.url === "/v1/chat/completions") {
          let body;
          try {
            body = await readJson(req);
          } catch (e) {
            const status = e.status === 413 ? 413 : 400;
            return sendJson(res, status, { error: { message: e.message } });
          }

          const tools = Array.isArray(body.tools) ? body.tools : [];
          const hasTools = tools.length > 0;
          const toolChoice = body.tool_choice;

          let prompt;
          let conversationRouting;
          try {
            prompt = messagesToPrompt(body.messages, tools, toolChoice);
            conversationRouting = conversationRoutingFromBody(body);
          } catch (e) {
            return sendJson(res, 400, { error: { message: e.message } });
          }

          const model = body.model || "gpt";
          const wantStream = body.stream === true;
          const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
          const intelligence = resolveChatIntelligence(model);
          // OpenCode title agent: answer locally, never touch ChatGPT.
          if (LOCAL_TITLE && isTitleGenerationRequest(body.messages, tools)) {
            const title = localTitleFromMessages(body.messages);
            debugLog(`local title: ${JSON.stringify(title)}`);
            if (wantStream) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              res.write(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify(oaiChatChunk(id, model, title))}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify(oaiChatChunkFinal(id, model))}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              return res.end();
            }
            return sendJson(res, 200, {
              id,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: title },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
              },
            });
          }

          // Dry run short-circuits before touching ChatGPT.
          if (DRY_RUN) {
            const reply = dryRunReply(prompt);
            if (wantStream) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              res.write(
                `data: ${JSON.stringify(oaiChatChunk(id, model, reply))}\n\n`,
              );
              res.write(
                `data: ${JSON.stringify(oaiChatChunkFinal(id, model))}\n\n`,
              );
              res.write("data: [DONE]\n\n");
              return res.end();
            }
            return sendJson(res, 200, {
              id,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: reply },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0,
              },
            });
          }

          const { key: idemKey, digest: idemDigest } =
            idempotencyKeyFromRequest(req, body);
          let idemSlot = null;
          if (!DRY_RUN) {
            idemSlot = beginIdempotent(idemKey, idemDigest);
            if (idemSlot.mode === "conflict") {
              return sendJson(res, 409, {
                error: {
                  message: idemSlot.error.message,
                  type: "idempotency_conflict",
                },
              });
            }
            if (idemSlot.mode === "hit" || idemSlot.mode === "wait") {
              const cached =
                idemSlot.mode === "hit"
                  ? idemSlot.payload
                  : await idemSlot.wait;
              debugLog(`idempotency ${idemSlot.mode} ${idemKey.slice(0, 48)}…`);
              if (wantStream) {
                res.writeHead(200, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                });
                res.write(
                  `data: ${JSON.stringify({
                    id: cached.id || id,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [
                      {
                        index: 0,
                        delta: { role: "assistant" },
                        finish_reason: null,
                      },
                    ],
                  })}\n\n`,
                );
                if (cached.calls?.length) {
                  res.write(
                    `data: ${JSON.stringify(oaiToolCallChunk(cached.id || id, model, cached.calls))}\n\n`,
                  );
                  res.write(
                    `data: ${JSON.stringify(oaiChatChunkFinal(cached.id || id, model, "tool_calls"))}\n\n`,
                  );
                } else {
                  res.write(
                    `data: ${JSON.stringify(oaiChatChunk(cached.id || id, model, cached.reply || ""))}\n\n`,
                  );
                  res.write(
                    `data: ${JSON.stringify(oaiChatChunkFinal(cached.id || id, model))}\n\n`,
                  );
                }
                res.write("data: [DONE]\n\n");
                return res.end();
              }
              return sendJson(res, 200, cached.body);
            }
          }

          try {
            if (wantStream) {
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              });
              // OpenAI-compatible clients often expect an initial role chunk.
              res.write(
                `data: ${JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model,
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              );
              const stopKeepalive = startSseKeepalive(res);
              const abort = attachRequestAbort(req, res);
              let reply;
              let calls = [];
              let meta = {};
              let streamedChars = 0;
              let reasoningChars = 0;
              const t0 = Date.now();
              try {
                // Guarded live streaming: emit prefix-stable deltas as they appear.
                // Tool turns never stream (a partial TOOL_CALL would break OpenCode).
                // Busy/cancel ownership activates only when this task reaches the
                // head of the serialized queue.
                const onToken = (delta) => {
                  if (!delta) return;
                  streamedChars += delta.length;
                  try {
                    res.write(
                      `data: ${JSON.stringify(oaiChatChunk(id, model, delta))}\n\n`,
                    );
                  } catch {
                    /* client gone */
                  }
                };
                const onThinking = (delta) => {
                  if (!delta) return;
                  reasoningChars += delta.length;
                  try {
                    res.write(
                      `data: ${JSON.stringify(oaiReasoningChunk(id, model, delta))}\n\n`,
                    );
                  } catch {
                    /* client gone */
                  }
                };
                const out = await serialized(async () => {
                  abort.activate(hasTools ? "tools" : "chat", prompt);
                  try {
                    return await runWithToolRetry(
                      prompt,
                      tools,
                      body.messages,
                      toolChoice,
                      onToken,
                      onThinking,
                      intelligence,
                      abort.signal,
                      undefined,
                      conversationRouting,
                    );
                  } finally {
                    // Keep controller until dispose() after response framing; clear busy now.
                    endBusy();
                  }
                });
                reply = out.reply;
                calls = out.calls;
                meta = out.meta || {};
              } catch (err) {
                idemSlot?.fail?.(err);
                throw err;
              } finally {
                abort.dispose();
                stopKeepalive();
              }

              if (calls.length > 0) {
                // Tool calls: nothing was live-streamed; emit the tool_calls chunk.
                const purpose = toolCallPurpose(calls);
                if (purpose) {
                  res.write(
                    `data: ${JSON.stringify(oaiChatChunk(id, model, purpose))}\n\n`,
                  );
                }
                res.write(
                  `data: ${JSON.stringify(oaiToolCallChunk(id, model, calls))}\n\n`,
                );
                res.write(
                  `data: ${JSON.stringify(oaiChatChunkFinal(id, model, "tool_calls"))}\n\n`,
                );
              } else if (meta.streamAbandoned) {
                // Partial/obsolete live deltas already went out — do NOT claim stop success.
                const msg =
                  "Stream abandoned: ChatGPT rewrote the reply incompatibly with already-streamed text";
                res.write(
                  `data: ${JSON.stringify({
                    error: { message: msg, type: "stream_abandoned" },
                  })}\n\n`,
                );
                res.write("data: [DONE]\n\n");
                recordRequest({
                  ok: false,
                  kind: "error",
                  ms: Date.now() - t0,
                  charsIn: prompt.length,
                  charsOut: (reply || "").length,
                  chatUrl: meta.chatUrl || null,
                  streamed: streamedChars > 0,
                  error: msg,
                });
                return res.end();
              } else if (streamedChars === 0) {
                // No live answer deltas — if we only streamed reasoning, still emit
                // the final answer once; otherwise emit the whole reply.
                if (meta.thinking && reasoningChars === 0) {
                  res.write(
                    `data: ${JSON.stringify(oaiReasoningChunk(id, model, meta.thinking))}\n\n`,
                  );
                }
                res.write(
                  `data: ${JSON.stringify(oaiChatChunk(id, model, reply))}\n\n`,
                );
                res.write(
                  `data: ${JSON.stringify(oaiChatChunkFinal(id, model))}\n\n`,
                );
              } else {
                // Live deltas already went out; guard.finish() emitted any safe
                // remainder via onToken.
                res.write(
                  `data: ${JSON.stringify(oaiChatChunkFinal(id, model))}\n\n`,
                );
              }
              res.write("data: [DONE]\n\n");
              const streamBody =
                calls.length > 0
                  ? {
                      id,
                      object: "chat.completion",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [
                        {
                          index: 0,
                          message: {
                            role: "assistant",
                            content: toolCallPurpose(calls),
                            tool_calls: toolCallsPayload(calls),
                          },
                          finish_reason: "tool_calls",
                        },
                      ],
                      usage: {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                      },
                    }
                  : {
                      id,
                      object: "chat.completion",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [
                        {
                          index: 0,
                          message: { role: "assistant", content: reply },
                          finish_reason: "stop",
                        },
                      ],
                      usage: {
                        prompt_tokens: 0,
                        completion_tokens: 0,
                        total_tokens: 0,
                      },
                    };
              if (!meta.streamAbandoned) {
                const cachedPayload = {
                  id,
                  reply,
                  calls,
                  body: streamBody,
                };
                idemSlot?.finish?.(cachedPayload);
              } else {
                idemSlot?.fail?.(
                  new Error(
                    "stream abandoned — not caching idempotent response",
                  ),
                );
              }
              recordRequest({
                ok: true,
                kind: calls.length ? "tool_calls" : "chat",
                ms: Date.now() - t0,
                charsIn: prompt.length,
                charsOut: (reply || "").length,
                chatUrl: meta.chatUrl || null,
                streamed: streamedChars > 0,
                reasoning: reasoningChars > 0,
                recoveryStage: meta.recoveryStage,
                protocolAttempts: meta.protocolAttempts,
                replySource: meta.replySource,
                replyRecovery: meta.replyRecovery,
                nativeToolInspection: meta.nativeToolInspection,
                nativeToolNames: meta.nativeToolNames,
                nativeToolSuppression: meta.nativeToolSuppression,
                memorySuppression: meta.memorySuppression,
                disabledFeatureCount: meta.disabledFeatureCount,
                disabledToolCount: meta.disabledToolCount,
                appPreflight: meta.appPreflight,
                nativeToolRisk: meta.nativeToolRisk,
                recoveredNativeToolNames: meta.recoveredNativeToolNames,
                recoveryAttempt: meta.recoveryAttempt,
                recoveryParentVerified: meta.recoveryParentVerified,
              });
              return res.end();
            }

            const t0 = Date.now();
            const abort = attachRequestAbort(req, res);
            let out;
            try {
              out = await serialized(async () => {
                abort.activate(hasTools ? "tools" : "chat", prompt);
                try {
                  return await runWithToolRetry(
                    prompt,
                    tools,
                    body.messages,
                    toolChoice,
                    null,
                    null,
                    intelligence,
                    abort.signal,
                    undefined,
                    conversationRouting,
                  );
                } finally {
                  endBusy();
                }
              });
            } catch (err) {
              idemSlot?.fail?.(err);
              throw err;
            } finally {
              abort.dispose();
            }
            const { reply, calls, meta } = out;
            if (meta?.streamAbandoned) {
              const err = new Error(
                "Stream abandoned: ChatGPT rewrote the reply incompatibly with already-streamed text",
              );
              err.streamAbandoned = true;
              throw err;
            }
            const reasoningFields = meta?.thinking
              ? { reasoning_content: meta.thinking, reasoning: meta.thinking }
              : {};
            let responseBody;
            if (calls.length > 0) {
              responseBody = {
                id,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: toolCallPurpose(calls),
                      tool_calls: toolCallsPayload(calls),
                      ...reasoningFields,
                    },
                    finish_reason: "tool_calls",
                  },
                ],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                },
              };
            } else {
              responseBody = {
                id,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [
                  {
                    index: 0,
                    message: {
                      role: "assistant",
                      content: reply,
                      ...reasoningFields,
                    },
                    finish_reason: "stop",
                  },
                ],
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0,
                },
              };
            }
            idemSlot?.finish?.({ id, reply, calls, body: responseBody });
            recordRequest({
              ok: true,
              kind: calls.length ? "tool_calls" : "chat",
              ms: Date.now() - t0,
              charsIn: prompt.length,
              charsOut: (reply || "").length,
              chatUrl: meta?.chatUrl || null,
              streamed: false,
              recoveryStage: meta?.recoveryStage,
              protocolAttempts: meta?.protocolAttempts,
              replySource: meta?.replySource,
              replyRecovery: meta?.replyRecovery,
              nativeToolInspection: meta?.nativeToolInspection,
              nativeToolNames: meta?.nativeToolNames,
              nativeToolSuppression: meta?.nativeToolSuppression,
              memorySuppression: meta?.memorySuppression,
              disabledFeatureCount: meta?.disabledFeatureCount,
              disabledToolCount: meta?.disabledToolCount,
              appPreflight: meta?.appPreflight,
              nativeToolRisk: meta?.nativeToolRisk,
              recoveredNativeToolNames: meta?.recoveredNativeToolNames,
              recoveryAttempt: meta?.recoveryAttempt,
              recoveryParentVerified: meta?.recoveryParentVerified,
            });
            return sendJson(res, 200, responseBody);
          } catch (err) {
            idemSlot?.fail?.(err);
            endBusy();
            const msg = humanizeError(err);
            recordRequest({
              ok: false,
              kind: "error",
              ms: 0,
              charsIn: prompt?.length || 0,
              charsOut: 0,
              error: msg,
            });
            if (res.headersSent) {
              try {
                res.write(
                  `data: ${JSON.stringify({ error: { message: msg } })}\n\n`,
                );
                res.end();
              } catch {
                /* ignore */
              }
              return;
            }
            return sendJson(res, 502, { error: { message: msg } });
          }
        }

        // ---- Simple route ----
        if (req.method === "POST" && req.url === "/chat") {
          let body;
          try {
            body = await readJson(req);
          } catch (e) {
            const status = e.status === 413 ? 413 : 400;
            return sendJson(res, status, { error: { message: e.message } });
          }

          const message = typeof body.message === "string" ? body.message : "";
          if (!message.trim()) {
            return sendJson(res, 400, {
              error: { message: "`message` is required" },
            });
          }

          if (DRY_RUN) {
            return sendJson(res, 200, { reply: dryRunReply(message) });
          }

          try {
            const t0 = Date.now();
            let reply;
            try {
              reply = await serialized(async () => {
                beginBusy("chat", message);
                try {
                  return await runBackend(message, null, true, {
                    model: CHAT_MODEL,
                    effort: CHAT_EFFORT,
                  });
                } finally {
                  endBusy();
                }
              });
            } finally {
              /* busy cleared inside serialized */
            }
            noteCleanSend();
            recordRequest({
              ok: true,
              kind: "chat",
              ms: Date.now() - t0,
              charsIn: message.length,
              charsOut: (reply || "").length,
            });
            return sendJson(res, 200, { reply });
          } catch (err) {
            endBusy();
            const msg = humanizeError(err);
            recordRequest({
              ok: false,
              kind: "error",
              error: msg,
              charsIn: message.length,
            });
            return sendJson(res, 502, { error: { message: msg } });
          }
        }

        // Unknown
        sendJson(res, 404, {
          error: {
            message:
              "Not found. Use GET /, GET /health, POST /cancel, POST /chat, or POST /v1/chat/completions.",
          },
        });
      })
    : null;

if (server)
  server.listen(PORT, HOST, () => {
    console.log("─".repeat(60));
    console.log("  Overleaf ChatGPT-Web Sidecar");
    console.log("─".repeat(60));
    console.log(`  Listening : http://${HOST}:${PORT}`);
    console.log(`  Backend   : ${BACKEND}`);
    console.log(
      `  Dry run   : ${DRY_RUN ? "ON (no requests sent)" : "OFF (live)"}`,
    );
    console.log(
      `  Persist   : ${PERSIST_CHAT ? "ON (reuse one chat per conversation)" : "OFF (fresh chat per request)"}`,
    );
    console.log(
      `  Loc.title : ${LOCAL_TITLE ? "ON (metadata titles answered locally)" : "OFF"}`,
    );
    console.log(
      "  Stream    : raw-buffered answers (thinking events remain live)",
    );
    console.log(
      `  Thinking  : ${STREAM_THINKING ? "ON (reasoning_content status)" : "OFF"}`,
    );
    console.log(
      `  Model     : ${CHAT_MODEL || "(account default)"} / effort ${CHAT_EFFORT || "(account default)"}`,
    );
    console.log(
      `  Cooldown  : ${currentCooldownMs}ms (min ${COOLDOWN_MIN_MS}, max ${COOLDOWN_MAX_MS})`,
    );
    console.log(`  Store     : ${STORE_ENABLED ? STORE_FILE : "memory-only"}`);
    console.log("");
    console.log("  Endpoints:");
    console.log("    GET  /                       status dashboard");
    console.log(
      "    POST /cancel                 abort in-flight ChatGPT turn",
    );
    console.log('    POST /chat                   { "message": "hi" }');
    console.log(
      "    POST /v1/chat/completions    OpenAI-compatible (stream=true ok)",
    );
    console.log("    GET  /health");
    console.log("─".repeat(60));
  });

async function shutdown(signal) {
  console.warn(`[server] ${signal}; closing shared browser…`);
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  await closeSharedSession();
  process.exit(0);
}
if (import.meta.main) {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
