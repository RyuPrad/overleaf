// raw-conversation.js
// Read the exact assistant source for tool envelopes. ChatGPT's rendered DOM
// can turn LaTeX inside a shell command into visual math, corrupting the text
// before the strict tool parser sees it.

const BASE = "https://chatgpt.com";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const RAW_POSTCHECK_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.RAW_POSTCHECK_TIMEOUT_MS || 30_000) || 30_000
);

export function shouldReadRawReply(text, enabled = true) {
  return enabled && /\b(?:SHELL_CALL|TOOL_CALL)\s*:/i.test(String(text || ""));
}

export function conversationID(chatUrl) {
  try {
    const match = new URL(chatUrl).pathname.match(/^\/c\/([^/]+)\/?$/);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

export function extractRawAssistantReply(conversation, messageID) {
  if (!messageID) return null;
  const message = conversation?.mapping?.[messageID]?.message;
  if (!message || message.id !== messageID || message.author?.role !== "assistant") return null;
  if (message.content?.content_type !== "text" || !Array.isArray(message.content.parts)) return null;
  if (!message.content.parts.every((part) => typeof part === "string")) return null;
  const text = message.content.parts.join("").trim();
  return text || null;
}

function messageText(message) {
  if (!message || !Array.isArray(message.content?.parts)) return "";
  if (!message.content.parts.every((part) => typeof part === "string")) return "";
  return message.content.parts.join("").trim();
}

function userMessageText(message) {
  if (!message || !Array.isArray(message.content?.parts)) return "";
  return message.content.parts.filter((part) => typeof part === "string").join("").trim();
}

function normalizedText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function assistantMessageFinished(message) {
  const status = String(message?.status || message?.metadata?.status || "").toLowerCase();
  if (/^(?:in_progress|streaming|pending|running)$/.test(status)) return false;
  if (message?.end_turn === false) return false;
  // Older raw fixtures and some text-only web replies omit completion fields.
  // Absence is accepted only once non-empty assistant text exists; explicit
  // unfinished signals always win.
  return true;
}

function nativeAssistantCallName(message) {
  if (!message) return null;
  const role = String(message.author?.role || "").toLowerCase();
  if (role !== "assistant") return null;
  const recipient = String(message.recipient || message.metadata?.recipient || "").trim();
  if (!recipient || /^all$/i.test(recipient)) return null;
  return recipient;
}

function nativeToolResultName(message) {
  if (String(message?.author?.role || "").toLowerCase() !== "tool") return null;
  return String(message.author?.name || message.recipient || "chatgpt-tool").trim() || "chatgpt-tool";
}

const EXECUTION_MARKER_KEYS = Object.freeze([
  "call_id",
  "tool_call_id",
  "result",
  "output",
  "execution",
  "execution_id",
]);

const DISCOVERY_ONLY_RECIPIENTS = new Set([
  "api_tool.list_resources",
  "api_tool.search_tools",
]);

function hasOwn(object, key) {
  return !!object && Object.prototype.hasOwnProperty.call(object, key);
}

function hasExecutionMarker(message) {
  const metadata = message?.metadata;
  return EXECUTION_MARKER_KEYS.some(
    (key) => hasOwn(message, key) || hasOwn(metadata, key) || hasOwn(message?.content, key)
  );
}

function nativeStepFinished(message) {
  const status = String(message?.status || message?.metadata?.status || "").toLowerCase();
  return !/^(?:in_progress|streaming|pending|running)$/.test(status);
}

/**
 * ChatGPT may ignore disabled-tool transport fields and perform its own tool
 * catalogue lookup before producing a normal answer. The lookup is safe to
 * adopt only when the authenticated graph proves the exact read-only shape:
 * one completed api_tool result for every exact list/search call, no other
 * native recipient, and no execution/result identifiers on either side.
 * Generic api_tool.call_tool and every near-match remain fail-closed.
 */
function isDiscoveryOnlyActivity(callMessages, resultMessages) {
  if (!callMessages.length || resultMessages.length !== callMessages.length) return false;
  if (!callMessages.every((message) => {
    const recipient = sanitizeNativeToolName(nativeAssistantCallName(message));
    return (
      DISCOVERY_ONLY_RECIPIENTS.has(recipient) &&
      message?.content?.content_type === "code" &&
      nativeStepFinished(message) &&
      !hasExecutionMarker(message)
    );
  })) {
    return false;
  }
  return resultMessages.every((message) => (
    sanitizeNativeToolName(nativeToolResultName(message)) === "api_tool" &&
    String(message?.recipient || "all").toLowerCase() === "all" &&
    message?.content?.content_type === "text" &&
    Array.isArray(message?.content?.parts) &&
    message.content.parts.every((part) => typeof part === "string") &&
    nativeStepFinished(message) &&
    !hasExecutionMarker(message)
  ));
}

/**
 * ChatGPT injects connector context as a visually hidden `api_tool`-authored
 * prompt node. It is model input, not a tool result. Accept the family by
 * graph structure rather than one brittle subtype string, while requiring the
 * node to be a direct child of the UUID-bound user turn with no execution
 * markers. A real/unknown tool node still fails closed.
 */
function isConnectorContextPrompt(item, userMessageID, hasAssistantCall) {
  const message = item?.message || item;
  const metadata = message?.metadata;
  const parts = message?.content?.parts;
  if (hasAssistantCall || !userMessageID || item?.entry?.parent !== userMessageID) return false;
  if (String(message?.author?.role || "").toLowerCase() !== "tool") return false;
  if (String(message?.author?.name || "") !== "api_tool") return false;
  if (String(message?.recipient || "all").toLowerCase() !== "all") return false;
  if (metadata?.command !== "prompt" || metadata?.is_visually_hidden_from_conversation !== true) {
    return false;
  }
  if (!/^connector_link_[a-z0-9_-]+_prompt$/i.test(String(metadata?.contextual_answers_message_type || ""))) {
    return false;
  }
  if (message?.content?.content_type !== "text" || !Array.isArray(parts)) return false;
  if (!parts.every((part) => typeof part === "string")) return false;
  return !hasExecutionMarker(message);
}

function sanitizeNativeToolName(value) {
  const name = String(value || "").trim();
  return /^[a-z0-9._:/-]{1,120}$/i.test(name) ? name : "chatgpt-tool";
}

function collectNativeToolActivity(items, { userMessageID = null } = {}) {
  const assistantCalls = new Set();
  const toolResults = new Set();
  const callMessages = [];
  const resultMessages = [];
  const contextMessages = [];
  const normalizedItems = (items || []).map((item) => ({
    item,
    message: item?.message || item,
  }));
  const hasAssistantCall = normalizedItems.some(({ message }) => !!nativeAssistantCallName(message));
  for (const { item, message } of normalizedItems) {
    const call = nativeAssistantCallName(message);
    const contextPrompt = isConnectorContextPrompt(item, userMessageID, hasAssistantCall);
    const result = contextPrompt ? null : nativeToolResultName(message);
    if (call) {
      assistantCalls.add(sanitizeNativeToolName(call));
      callMessages.push(message);
    }
    if (contextPrompt) contextMessages.push(message);
    if (result) {
      toolResults.add(sanitizeNativeToolName(result));
      resultMessages.push(message);
    }
  }
  const assistantCallNames = [...assistantCalls].sort();
  const toolResultNames = [...toolResults].sort();
  const nativeToolNames = [...new Set([...assistantCallNames, ...toolResultNames])].sort();
  const memoryDisabled =
    callMessages.length > 0 &&
    callMessages.length === resultMessages.length &&
    callMessages.every((message) => sanitizeNativeToolName(nativeAssistantCallName(message)) === "bio") &&
    resultMessages.every(
      (message) =>
        sanitizeNativeToolName(nativeToolResultName(message)) === "bio" &&
        message?.metadata?.memory_write_failure_reason === "memory_disabled"
    );
  const discoveryOnly = isDiscoveryOnlyActivity(callMessages, resultMessages);
  return {
    assistantCallNames,
    toolResultNames,
    nativeToolNames,
    rawNodeClass: memoryDisabled
      ? "confirmed-no-side-effect"
      : discoveryOnly
        ? "discovery-only"
        : nativeToolNames.length
          ? "native-activity"
          : contextMessages.length
            ? "context-only"
            : "clean",
    rawAuditReason: memoryDisabled
      ? "memory-disabled"
      : discoveryOnly
        ? "api-tool-discovery-only"
        : assistantCallNames.length
          ? "assistant-native-recipient"
          : toolResultNames.length
            ? "tool-result"
            : contextMessages.length
              ? "connector-context-prompt"
              : "none",
    nativeToolRisk: memoryDisabled
      ? "confirmed-no-side-effect"
      : discoveryOnly
        ? "discovery-only"
        : nativeToolNames.length
          ? "native-activity"
          : "clean",
    nativeToolSideEffectsPossible:
      nativeToolNames.length > 0 && !memoryDisabled && !discoveryOnly,
  };
}

export function isDiscoveryOnlyNativeActivity(activity) {
  return (
    activity?.nativeToolRisk === "discovery-only" &&
    activity?.rawNodeClass === "discovery-only" &&
    activity?.nativeToolSideEffectsPossible === false
  );
}

function extractNativeToolActivity(conversation, messageID) {
  const mapping = conversation?.mapping;
  if (!mapping || !messageID || !mapping[messageID]) return collectNativeToolActivity([]);
  if (mapping[messageID]?.message?.author?.role !== "assistant") {
    return collectNativeToolActivity([]);
  }
  const items = [];
  const seen = new Set();
  let userMessageID = null;
  let node = messageID;
  while (node && !seen.has(node)) {
    seen.add(node);
    const entry = mapping[node];
    if (!entry) break;
    const message = entry.message;
    if (node !== messageID && message?.author?.role === "user") {
      userMessageID = node;
      break;
    }
    items.push({ id: node, entry, message });
    node = entry.parent;
  }
  return collectNativeToolActivity(items, { userMessageID });
}

/**
 * Return sanitized ChatGPT-native tool names used while producing messageID.
 * Walk only to the latest user node so tools from older turns cannot taint the
 * current completion. Commands and tool outputs are intentionally discarded.
 */
export function extractNativeToolNames(conversation, messageID) {
  return extractNativeToolActivity(conversation, messageID).nativeToolNames;
}

export function extractRawAssistantTurn(conversation, messageID) {
  const reply = extractRawAssistantReply(conversation, messageID);
  if (!reply) return null;
  return {
    reply,
    ...extractNativeToolActivity(conversation, messageID),
  };
}

/**
 * Inspect the authenticated raw head without accepting any reply. With an
 * afterNodeID, the current path must reach that previously committed cursor;
 * otherwise the latest user node is treated as the current-turn boundary.
 * Commands and tool outputs are never returned.
 */
export function extractRawConversationAudit(
  conversation,
  { afterNodeID = null } = {}
) {
  const mapping = conversation?.mapping;
  const currentNode = conversation?.current_node;
  if (!mapping || !currentNode || !mapping[currentNode]) return null;

  const path = [];
  const seen = new Set();
  let node = currentNode;
  let reachedBoundary = !afterNodeID;
  while (node && !seen.has(node)) {
    if (afterNodeID && node === afterNodeID) {
      reachedBoundary = true;
      break;
    }
    seen.add(node);
    const entry = mapping[node];
    if (!entry) break;
    path.push({ id: node, entry, message: entry.message });
    node = entry.parent;
  }
  if (!reachedBoundary) return null;

  if (afterNodeID) {
    return {
      currentNode,
      boundaryNode: afterNodeID,
      safeParentNode: afterNodeID,
      drifted: currentNode !== afterNodeID,
      userMessageID: null,
      userText: null,
      ...collectNativeToolActivity(path),
    };
  }

  const userIndex = path.findIndex((item) => item.message?.author?.role === "user");
  if (userIndex < 0) return null;
  const user = path[userIndex];
  return {
    currentNode,
    boundaryNode: null,
    safeParentNode: user.entry?.parent || null,
    drifted: false,
    userMessageID: user.id,
    userText: userMessageText(user.message),
    ...collectNativeToolActivity(path.slice(0, userIndex), { userMessageID: user.id }),
  };
}

/**
 * Resolve the newest usable assistant text in the current raw turn. ChatGPT
 * sometimes appends an empty terminal assistant node after a real SHELL_CALL;
 * walking backward to the latest user node recovers that source without
 * trusting rendered DOM shape.
 *
 * afterNodeID is the conversation current_node captured before Send. When it
 * is supplied, the new path must reach that exact boundary. The user-message
 * id captured from the actual outgoing ChatGPT request is the strongest turn
 * guard; expectedUserText remains a fallback for older callers/tests.
 */
export function extractLatestRawAssistantTurn(
  conversation,
  { afterNodeID = null, expectedUserMessageID = null, expectedUserText = null } = {}
) {
  const mapping = conversation?.mapping;
  const currentNode = conversation?.current_node;
  if (!mapping || !currentNode || !mapping[currentNode]) return null;
  if (!afterNodeID && !expectedUserMessageID && expectedUserText === null) return null;

  const path = [];
  const seen = new Set();
  let node = currentNode;
  let reachedBoundary = !afterNodeID;
  while (node && !seen.has(node)) {
    if (afterNodeID && node === afterNodeID) {
      reachedBoundary = true;
      break;
    }
    seen.add(node);
    const entry = mapping[node];
    if (!entry) break;
    path.push({ id: node, entry, message: entry.message });
    node = entry.parent;
  }
  if (!reachedBoundary) return null;

  const userIndex = path.findIndex((item) => item.message?.author?.role === "user");
  if (userIndex < 0) return null;
  const user = path[userIndex];
  if (expectedUserMessageID && user.id !== expectedUserMessageID) return null;
  if (
    !expectedUserMessageID &&
    expectedUserText !== null &&
    normalizedText(userMessageText(user.message)) !== normalizedText(expectedUserText)
  ) {
    return null;
  }

  const currentTurn = path.slice(0, userIndex);
  const replyItem = currentTurn.find((item) => {
    const message = item.message;
    return (
      message?.author?.role === "assistant" &&
      !!messageText(message) &&
      assistantMessageFinished(message)
    );
  });
  if (!replyItem) return null;

  const activity = collectNativeToolActivity(currentTurn, { userMessageID: user.id });

  return {
    reply: messageText(replyItem.message),
    ...activity,
    messageID: replyItem.id,
    currentNode,
    userMessageID: user.id,
    safeParentNode: user.entry?.parent || null,
  };
}

async function readAccessToken(page, timeoutMs = REQUEST_TIMEOUT_MS) {
  return page.evaluate(async ({ base, timeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${base}/api/auth/session`, {
        credentials: "include",
        signal: controller.signal,
      });
      if (!response.ok) {
        return { token: null, status: response.status, outcome: `auth-http-${response.status}` };
      }
      const token = (await response.json())?.accessToken || null;
      return {
        token,
        status: response.status,
        outcome: token ? "auth-ok" : "auth-token-missing",
      };
    } catch (error) {
      return {
        token: null,
        status: null,
        outcome: error?.name === "AbortError" ? "auth-timeout" : "auth-error",
      };
    } finally {
      clearTimeout(timer);
    }
  }, { base: BASE, timeout: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeoutMs)) });
}

async function fetchRawConversation(page, id, accessToken, timeoutMs = REQUEST_TIMEOUT_MS) {
  return page.evaluate(async ({ base, id, token, maxBytes, timeout }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(`${base}/backend-api/conversation/${encodeURIComponent(id)}`, {
        credentials: "include",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        return { conversation: null, status: response.status, outcome: `raw-http-${response.status}` };
      }
      const length = Number(response.headers.get("content-length") || 0);
      if (length > maxBytes) {
        return { conversation: null, status: response.status, outcome: "raw-oversize" };
      }
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) {
        return { conversation: null, status: response.status, outcome: "raw-oversize" };
      }
      try {
        return {
          conversation: JSON.parse(text),
          status: response.status,
          outcome: "raw-ok",
        };
      } catch {
        return { conversation: null, status: response.status, outcome: "raw-parse-error" };
      }
    } catch (error) {
      return {
        conversation: null,
        status: null,
        outcome: error?.name === "AbortError" ? "raw-timeout" : "raw-error",
      };
    } finally {
      clearTimeout(timer);
    }
  }, {
    base: BASE,
    id,
    token: accessToken,
    maxBytes: MAX_RESPONSE_BYTES,
    timeout: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeoutMs)),
  });
}

async function readRawConversation(
  page,
  chatUrl,
  extract,
  {
    maxAttempts = 3,
    initialDelayMs = 300,
    maxDelayMs = 1_000,
    deadlineAt = null,
    readerName = "primary-page",
    onReaderOutcome = null,
    isCancelled = null,
  } = {}
) {
  const id = conversationID(chatUrl);
  if (!id) return null;
  const report = (outcome) => onReaderOutcome?.({ reader: readerName, outcome });
  const terminal = (outcome) =>
    /(?:http-(?:401|403|404)|oversize|parse-error)$/.test(String(outcome || ""));
  try {
    // Use the authenticated page's network stack. Playwright's separate
    // APIRequestContext can receive a Cloudflare 403 while this page works.
    const remaining = () => deadlineAt ? Math.max(0, deadlineAt - Date.now()) : REQUEST_TIMEOUT_MS;
    if (deadlineAt && remaining() <= 0) return null;
    let accessToken = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isCancelled?.()) return null;
      if (deadlineAt && remaining() <= 0) return null;
      if (!accessToken) {
        const authResult = await readAccessToken(page, remaining()).catch(() => ({
          token: null,
          outcome: "auth-error",
        }));
        // Keep the low-level reader compatible with narrow test/embedding
        // doubles that predate structured reader diagnostics.
        const auth = typeof authResult === "string"
          ? { token: authResult, outcome: "auth-ok" }
          : authResult;
        accessToken = auth?.token || null;
        if (!accessToken) {
          report(auth?.outcome || "auth-unavailable");
          if (terminal(auth?.outcome)) return null;
        }
      }
      const rawResult = accessToken
        ? await fetchRawConversation(page, id, accessToken, remaining()).catch(
            () => ({ conversation: null, outcome: "raw-error" })
          )
        : null;
      const raw = rawResult &&
        typeof rawResult === "object" &&
        (Object.prototype.hasOwnProperty.call(rawResult, "conversation") || rawResult.outcome)
        ? rawResult
        : rawResult
          ? { conversation: rawResult, outcome: "raw-ok" }
          : null;
      const conversation = raw?.conversation || null;
      if (!conversation) {
        accessToken = null;
        if (raw?.outcome) report(raw.outcome);
        if (terminal(raw?.outcome)) return null;
      }
      const value = conversation ? extract(conversation) : null;
      if (value) {
        report("ok");
        return value;
      }
      if (conversation) report("anchor-pending");
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(maxDelayMs, initialDelayMs * (attempt + 1));
        if (deadlineAt && remaining() <= 0) return null;
        if (isCancelled?.()) return null;
        await page.waitForTimeout(deadlineAt ? Math.min(delay, remaining()) : delay).catch(() => {});
      }
    }
    report("unavailable");
    return null;
  } catch {
    report("renderer-unavailable");
    return null;
  }
}

async function readRawConversationViaContext(
  context,
  chatUrl,
  extract,
  {
    maxAttempts = 3,
    initialDelayMs = 300,
    maxDelayMs = 1_000,
    deadlineAt = null,
    readerName = "request-context",
    onReaderOutcome = null,
    isCancelled = null,
  } = {}
) {
  const id = conversationID(chatUrl);
  const request = context?.request;
  if (!id || !request) return null;
  const report = (outcome) => onReaderOutcome?.({ reader: readerName, outcome });
  try {
    const remaining = () => deadlineAt ? Math.max(0, deadlineAt - Date.now()) : REQUEST_TIMEOUT_MS;
    if (deadlineAt && remaining() <= 0) return null;
    let accessToken = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (isCancelled?.()) return null;
      if (deadlineAt && remaining() <= 0) return null;
      if (!accessToken) {
        try {
          const sessionResponse = await request.get(`${BASE}/api/auth/session`, {
            timeout: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining())),
          });
          if (sessionResponse.ok()) {
            accessToken = (await sessionResponse.json())?.accessToken || null;
          } else {
            report(`auth-http-${sessionResponse.status()}`);
            if (sessionResponse.status() === 401 || sessionResponse.status() === 403) return null;
          }
        } catch {
          accessToken = null;
          report("auth-error");
        }
      }
      let response = null;
      if (accessToken) {
        try {
          response = await request.get(
            `${BASE}/backend-api/conversation/${encodeURIComponent(id)}`,
            {
              headers: { Authorization: `Bearer ${accessToken}` },
              timeout: Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remaining())),
            }
          );
        } catch {
          accessToken = null;
        }
      }
      if (response?.ok()) {
        const length = Number(response.headers()["content-length"] || 0);
        if (!length || length <= MAX_RESPONSE_BYTES) {
          const body = await response.body();
          if (body.byteLength <= MAX_RESPONSE_BYTES) {
            const conversation = JSON.parse(body.toString("utf8"));
            const value = extract(conversation);
            if (value) {
              report("ok");
              return value;
            }
            report("anchor-pending");
          }
        } else {
          report("raw-oversize");
          return null;
        }
      } else if (response) {
        report(`raw-http-${response.status()}`);
        if (response.status() === 401 || response.status() === 403) {
          return null;
        }
      }
      if (attempt < maxAttempts - 1) {
        if (deadlineAt && remaining() <= 0) return null;
        if (isCancelled?.()) return null;
        const delay = Math.min(maxDelayMs, initialDelayMs * (attempt + 1));
        await new Promise((resolve) =>
          setTimeout(resolve, deadlineAt ? Math.min(delay, remaining()) : delay)
        );
      }
    }
    report("unavailable");
    return null;
  } catch {
    report("request-unavailable");
    return null;
  }
}

/** Capture the raw conversation boundary before submitting a continuation. */
export async function readRawConversationCursor(page, chatUrl) {
  return readRawConversation(page, chatUrl, (conversation) => conversation?.current_node || null);
}

export async function readRawConversationAudit(page, chatUrl, options = {}) {
  const {
    maxAttempts = 3,
    initialDelayMs = 200,
    maxDelayMs = 500,
    deadlineAt = null,
    readerName = "primary-page",
    onReaderOutcome = null,
    isCancelled = null,
    ...extractOptions
  } = options;
  return readRawConversation(
    page,
    chatUrl,
    (conversation) => extractRawConversationAudit(conversation, extractOptions),
    {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      deadlineAt,
      readerName,
      onReaderOutcome,
      isCancelled,
    }
  );
}

export async function readRawConversationAuditViaContext(
  context,
  chatUrl,
  options = {}
) {
  const {
    maxAttempts = 3,
    initialDelayMs = 200,
    maxDelayMs = 500,
    deadlineAt = null,
    readerName = "request-context",
    onReaderOutcome = null,
    isCancelled = null,
    ...extractOptions
  } = options;
  return readRawConversationViaContext(
    context,
    chatUrl,
    (conversation) => extractRawConversationAudit(conversation, extractOptions),
    {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      deadlineAt,
      readerName,
      onReaderOutcome,
      isCancelled,
    }
  );
}

async function readRawViaVerifierPage(
  context,
  chatUrl,
  extract,
  options
) {
  if (!context?.newPage || options.isCancelled?.()) return null;
  let verifier = null;
  const remaining = () => Math.max(0, (options.deadlineAt || Date.now()) - Date.now());
  try {
    verifier = await context.newPage();
    if (options.isCancelled?.() || remaining() <= 0) return null;
    await verifier.goto(BASE, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1, Math.min(30_000, remaining())),
    });
    await verifier.waitForSelector("#prompt-textarea", {
      timeout: Math.max(1, Math.min(20_000, remaining())),
    }).catch(() => {});
    if (options.isCancelled?.() || remaining() <= 0) return null;
    return await readRawConversation(verifier, chatUrl, extract, {
      ...options,
      readerName: "verifier-page",
    });
  } catch {
    options.onReaderOutcome?.({
      reader: "verifier-page",
      outcome: "startup-unavailable",
    });
    return null;
  } finally {
    if (verifier) {
      await Promise.race([
        verifier.close({ runBeforeUnload: false }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
}

function delayedVerifier(read, delayMs, state) {
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      if (state.cancelled) {
        resolve(null);
        return;
      }
      resolve(await read());
    }, Math.max(0, delayMs));
    state.cancelTimers.push(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function raceRawReaders(reads, timeoutMs, state) {
  return new Promise((resolve) => {
    let pending = reads.length;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      if (value) {
        settled = true;
        state.cancelled = true;
        for (const cancel of state.cancelTimers.splice(0)) cancel();
        clearTimeout(timer);
        resolve(value);
        return;
      }
      pending -= 1;
      if (pending === 0) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.cancelled = true;
      for (const cancel of state.cancelTimers.splice(0)) cancel();
      resolve(null);
    }, timeoutMs);
    for (const read of reads) {
      Promise.resolve(read).then(finish, () => finish(null));
    }
  });
}

/**
 * Verify the persisted raw head through both authenticated transports. The
 * rendered page can stay on a blank hydration spinner even while the
 * BrowserContext request path can read the complete clean graph.
 */
export async function readRawConversationAuditRaced(
  page,
  context,
  chatUrl,
  options = {}
) {
  const {
    timeoutMs = RAW_POSTCHECK_TIMEOUT_MS,
    verifierHedgeMs = 2_000,
    onReaderOutcome = null,
    isCancelled: externalCancelled = null,
    ...readOptions
  } = options;
  const boundedTimeout = Math.max(1, Number(timeoutMs) || RAW_POSTCHECK_TIMEOUT_MS);
  const deadlineAt = Date.now() + boundedTimeout;
  const state = { cancelled: false, cancelTimers: [] };
  const isCancelled = () => state.cancelled || !!externalCancelled?.();
  const boundedOptions = {
    maxAttempts: Math.max(12, Math.ceil(boundedTimeout / 1_000) + 2),
    initialDelayMs: 250,
    maxDelayMs: 1_000,
    ...readOptions,
    deadlineAt,
    onReaderOutcome,
    isCancelled,
  };
  const reads = [
    readRawConversationAudit(page, chatUrl, {
      ...boundedOptions,
      readerName: "primary-page",
    }),
  ];
  if (context?.request) {
    reads.push(
      readRawConversationAuditViaContext(context, chatUrl, {
        ...boundedOptions,
        readerName: "request-context",
      })
    );
  }
  if (context?.newPage) {
    reads.push(
      delayedVerifier(
        () =>
          readRawViaVerifierPage(
            context,
            chatUrl,
            (conversation) => extractRawConversationAudit(conversation, readOptions),
            boundedOptions
          ),
        Math.min(verifierHedgeMs, Math.max(0, boundedTimeout - 1)),
        state
      )
    );
  }
  const result = await raceRawReaders(reads, boundedTimeout, state);
  if (!result) onReaderOutcome?.({ reader: "all", outcome: "unavailable" });
  return result;
}

export async function readRawAssistantTurn(page, chatUrl, messageID) {
  if (!messageID) return null;
  return readRawConversation(page, chatUrl, (conversation) =>
    extractRawAssistantTurn(conversation, messageID)
  );
}

export async function readRawLatestAssistantTurn(page, chatUrl, options = {}) {
  const {
    maxAttempts = 12,
    initialDelayMs = 250,
    maxDelayMs = 1_000,
    deadlineAt = null,
    readerName = "primary-page",
    onReaderOutcome = null,
    isCancelled = null,
    ...extractOptions
  } = options;
  return readRawConversation(
    page,
    chatUrl,
    (conversation) => extractLatestRawAssistantTurn(conversation, extractOptions),
    {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      deadlineAt,
      readerName,
      onReaderOutcome,
      isCancelled,
    }
  );
}

/**
 * Renderer-independent fallback for a submitted turn. BrowserContext.request
 * shares the authenticated context cookies but does not queue behind a stuck
 * page.evaluate(), so a completed raw reply can still be verified fail-closed.
 */
export async function readRawLatestAssistantTurnViaContext(context, chatUrl, options = {}) {
  const {
    maxAttempts = 12,
    initialDelayMs = 250,
    maxDelayMs = 1_000,
    deadlineAt = null,
    readerName = "request-context",
    onReaderOutcome = null,
    isCancelled = null,
    ...extractOptions
  } = options;
  return readRawConversationViaContext(
    context,
    chatUrl,
    (conversation) => extractLatestRawAssistantTurn(conversation, extractOptions),
    {
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      deadlineAt,
      readerName,
      onReaderOutcome,
      isCancelled,
    }
  );
}

/**
 * Race both authenticated raw-read paths under one post-delivery deadline.
 * A null/failed fast path does not hide a later successful path. The caller
 * can therefore finish a delivered turn even when either the page renderer or
 * BrowserContext request stack is wedged.
 */
export async function readRawLatestAssistantTurnRaced(
  page,
  context,
  chatUrl,
  options = {}
) {
  const {
    timeoutMs = RAW_POSTCHECK_TIMEOUT_MS,
    verifierHedgeMs = 2_000,
    onReaderOutcome = null,
    isCancelled: externalCancelled = null,
    ...readOptions
  } = options;
  const boundedTimeout = Math.max(1, Number(timeoutMs) || RAW_POSTCHECK_TIMEOUT_MS);
  const deadlineAt = Date.now() + boundedTimeout;
  const state = { cancelled: false, cancelTimers: [] };
  const isCancelled = () => state.cancelled || !!externalCancelled?.();
  // Keep each independent reader alive for the whole shared deadline. The old
  // fixed 12-attempt loop could exhaust in a few seconds and resolve null even
  // though the caller had granted a much larger post-delivery budget.
  const boundedOptions = {
    maxAttempts: Math.max(12, Math.ceil(boundedTimeout / 1_000) + 2),
    initialDelayMs: 250,
    maxDelayMs: 1_000,
    ...readOptions,
    deadlineAt,
    onReaderOutcome,
    isCancelled,
  };
  const reads = [
    readRawLatestAssistantTurn(page, chatUrl, {
      ...boundedOptions,
      readerName: "primary-page",
    }),
  ];
  if (context?.request) {
    reads.push(
      readRawLatestAssistantTurnViaContext(context, chatUrl, {
        ...boundedOptions,
        readerName: "request-context",
      })
    );
  }
  if (context?.newPage) {
    reads.push(
      delayedVerifier(
        () =>
          readRawViaVerifierPage(
            context,
            chatUrl,
            (conversation) => extractLatestRawAssistantTurn(conversation, readOptions),
            boundedOptions
          ),
        Math.min(verifierHedgeMs, Math.max(0, boundedTimeout - 1)),
        state
      )
    );
  }
  const result = await raceRawReaders(reads, boundedTimeout, state);
  if (!result) onReaderOutcome?.({ reader: "all", outcome: "unavailable" });
  return result;
}

export async function readRawAssistantReply(page, chatUrl, messageID) {
  const turn = await readRawAssistantTurn(page, chatUrl, messageID);
  return turn?.reply || null;
}

export { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, RAW_POSTCHECK_TIMEOUT_MS };
