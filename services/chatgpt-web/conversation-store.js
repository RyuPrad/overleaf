// conversation-store.js
// Registry that maps OpenAI-style message histories to live ChatGPT web
// conversations, so one OpenCode session keeps extending ONE chat instead of
// opening a fresh chat (and re-sending the whole transcript) per request.
//
// Matching model: each tracked conversation stores one signature per OpenAI
// message already conveyed into that chat, INCLUDING the assistant reply the
// chat produced. An incoming request reuses a conversation when its messages
// start with that exact signature list; everything after the prefix is the
// delta that still needs to be sent.
//
// Persistence: when PERSIST_STORE_FILE is set (default auth/conversations.json),
// the map is written to disk after every change and reloaded on startup so
// `opencode run --continue` after a service restart can resume deltas.

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_CONVERSATION_FILE } from "./paths.js";
import { debugLog } from "./debug-log.js";

const flag = (v) => String(v ?? "").trim();
const MAX_CONVERSATIONS = Number(process.env.PERSIST_MAX_CHATS || 32);
const STORE_FILE = flag(DEFAULT_CONVERSATION_FILE);
const STORE_ENABLED =
  flag(process.env.PERSIST_STORE || "1") !== "0" && !!STORE_FILE;

/** @type {Array<{key?: string|null, sig: string[], chatUrl: string|null, lastUsed: number, hadTools: boolean, rawCurrentNode?: string|null, recovery?: object|null, pendingTurn?: object|null}>} */
const entries = [];

function enforceUnkeyedLimit() {
  while (entries.filter((entry) => !entry.key).length > MAX_CONVERSATIONS) {
    let oldestIndex = -1;
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].key) continue;
      if (
        oldestIndex === -1 ||
        entries[i].lastUsed < entries[oldestIndex].lastUsed
      ) {
        oldestIndex = i;
      }
    }
    if (oldestIndex === -1) break;
    entries.splice(oldestIndex, 1);
  }
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : (p?.text ?? "")))
      .join("");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

const hash = (s) =>
  createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

/** Stable form of a tool_call arguments payload (clients may re-serialize). */
function stableArgs(args) {
  if (typeof args !== "string") return JSON.stringify(args ?? {});
  try {
    return JSON.stringify(JSON.parse(args));
  } catch {
    return args;
  }
}

/**
 * Signature of one message for prefix comparison. Strict on system/user/tool
 * content (that's what identifies a conversation), tolerant on assistant
 * messages with tool_calls (compare tool name + arguments, not the wrapper —
 * OpenCode echoes our own reply back and may normalize `content: null`).
 * Content is trimmed before hashing so trailing-whitespace normalization by
 * the client doesn't break the match.
 */
export function sigOf(m) {
  const role = m?.role || "user";
  if (role === "assistant") {
    const tc = (m.tool_calls || [])
      .map(
        (c) =>
          `${c?.function?.name || ""}:${hash(stableArgs(c?.function?.arguments))}`,
      )
      .join(",");
    return tc ? `a|tc:${tc}` : `a|${hash(contentToText(m.content).trim())}`;
  }
  if (role === "tool") return `t|${hash(contentToText(m.content).trim())}`;
  const base = `${role}|${hash(contentToText(m.content).trim())}`;
  const images = (Array.isArray(m?.images) ? m.images : [])
    .map(
      (image) => `${String(image?.mediaType || "")}:${hash(image?.data || "")}`,
    )
    .join(",");
  return images ? `${base}|img:${images}` : base;
}

export function sigsOf(messages) {
  return (Array.isArray(messages) ? messages : []).map(sigOf);
}

function saveStore() {
  if (!STORE_ENABLED) return;
  try {
    const dir = dirname(STORE_FILE);
    if (dir && dir !== "." && !existsSync(dir))
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    const payload = {
      version: 4,
      savedAt: Date.now(),
      entries: entries.map((e) => ({
        ...(e.key ? { key: e.key } : {}),
        sig: e.sig,
        chatUrl: e.chatUrl,
        lastUsed: e.lastUsed,
        hadTools: !!e.hadTools,
        ...(e.rawCurrentNode ? { rawCurrentNode: e.rawCurrentNode } : {}),
        ...(e.recovery ? { recovery: e.recovery } : {}),
        ...(e.pendingTurn ? { pendingTurn: e.pendingTurn } : {}),
      })),
    };
    const tmp = `${STORE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    renameSync(tmp, STORE_FILE);
    chmodSync(STORE_FILE, 0o600);
  } catch (err) {
    debugLog(`save failed: ${err.message}`, "[conversation-store]");
  }
}

function loadStore() {
  if (!STORE_ENABLED || !existsSync(STORE_FILE)) return;
  try {
    chmodSync(STORE_FILE, 0o600);
    const raw = JSON.parse(readFileSync(STORE_FILE, "utf8"));
    const list = Array.isArray(raw?.entries) ? raw.entries : [];
    entries.length = 0;
    for (const e of list) {
      if (!e || !Array.isArray(e.sig)) continue;
      if (!e.sig.every((s) => typeof s === "string")) continue;
      const recovery =
        e.recovery && typeof e.recovery === "object"
          ? {
              state:
                e.recovery.state === "auto-pending" ? "auto-pending" : "paused",
              reason: String(e.recovery.reason || "unverifiable").slice(0, 80),
              risk: String(e.recovery.risk || "unverifiable").slice(0, 80),
              safeParentNode:
                typeof e.recovery.safeParentNode === "string"
                  ? e.recovery.safeParentNode
                  : null,
              contaminatedNode:
                typeof e.recovery.contaminatedNode === "string"
                  ? e.recovery.contaminatedNode
                  : null,
              nativeCallNames: Array.isArray(e.recovery.nativeCallNames)
                ? e.recovery.nativeCallNames
                    .filter((name) => typeof name === "string")
                    .slice(0, 8)
                : [],
              attempts: Math.max(0, Number(e.recovery.attempts) || 0),
              detectedAt: Number(e.recovery.detectedAt) || Date.now(),
              pendingSig:
                Array.isArray(e.recovery.pendingSig) &&
                e.recovery.pendingSig.every((sig) => typeof sig === "string")
                  ? e.recovery.pendingSig.slice()
                  : [],
            }
          : null;
      const pendingTurn =
        e.pendingTurn && typeof e.pendingTurn === "object"
          ? {
              state: "submitted-unverified",
              boundaryNode:
                typeof e.pendingTurn.boundaryNode === "string"
                  ? e.pendingTurn.boundaryNode
                  : null,
              userMessageID:
                typeof e.pendingTurn.userMessageID === "string"
                  ? e.pendingTurn.userMessageID
                  : null,
              promptDigest:
                typeof e.pendingTurn.promptDigest === "string"
                  ? e.pendingTurn.promptDigest.slice(0, 64)
                  : null,
              attempts: Math.max(1, Number(e.pendingTurn.attempts) || 1),
              detectedAt: Number(e.pendingTurn.detectedAt) || Date.now(),
            }
          : null;
      if (!e.chatUrl && !recovery?.pendingSig?.length) continue;
      entries.push({
        key: typeof e.key === "string" ? e.key : null,
        sig: e.sig.slice(),
        chatUrl: e.chatUrl ? String(e.chatUrl) : null,
        lastUsed: Number(e.lastUsed) || Date.now(),
        hadTools: !!e.hadTools,
        rawCurrentNode:
          typeof e.rawCurrentNode === "string" ? e.rawCurrentNode : null,
        recovery,
        pendingTurn,
      });
    }
    // Keyed sessions are user-managed and retained until explicitly deleted.
    // The LRU cap remains for legacy/signature-matched clients only.
    enforceUnkeyedLimit();
    if (entries.length) {
      debugLog(
        `loaded ${entries.length} chat(s) from ${STORE_FILE}`,
        "[conversation-store]",
      );
    }
  } catch (err) {
    debugLog(`load failed: ${err.message}`, "[conversation-store]");
  }
}

loadStore();

/**
 * Find the tracked conversation whose history is a strict prefix of the
 * incoming messages. Returns the entry (longest match wins) or null.
 * `entry.sig.length` is the index where the unsent delta starts.
 * When `needTools` is set, only chats that saw the tool-protocol preamble in
 * their opening prompt qualify (a chat that never learned the TOOL_CALL
 * protocol can't serve a tools request).
 */
export function findConversation(messages, needTools = false) {
  const sigs = sigsOf(messages);
  let best = null;
  for (const e of entries) {
    if (e.key) continue;
    if (e.sig.length >= sigs.length) continue;
    if (needTools && !e.hadTools) continue;
    let ok = true;
    for (let i = 0; i < e.sig.length; i++) {
      if (e.sig[i] !== sigs[i]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const pendingSig = Array.isArray(e.recovery?.pendingSig)
      ? e.recovery.pendingSig
      : [];
    if (pendingSig.length) {
      if (pendingSig.length > sigs.length) continue;
      let pendingMatches = true;
      for (let i = 0; i < pendingSig.length; i++) {
        if (pendingSig[i] !== sigs[i]) {
          pendingMatches = false;
          break;
        }
      }
      if (!pendingMatches) continue;
    }
    if (!e.chatUrl && !e.recovery) continue;
    if (!best || e.sig.length > best.sig.length) best = e;
  }
  if (best) {
    best.lastUsed = Date.now();
    saveStore();
  }
  return best;
}

/** Resolve an application-owned conversation without comparing transcripts. */
export function findConversationByKey(key, needTools = false) {
  if (!key) return null;
  const entry = entries.find((candidate) => candidate.key === key) || null;
  if (!entry || (needTools && !entry.hadTools)) return null;
  if (!entry.chatUrl && !entry.recovery) return null;
  entry.lastUsed = Date.now();
  saveStore();
  return entry;
}

/**
 * Explicit-retry fallback for a legacy mapping whose regenerated OpenCode
 * system/MCP preamble changed across process restarts. Normal routing remains
 * strict. This matcher ignores only role:system signatures, requires the full
 * committed non-system history as a prefix, and refuses ambiguous ties.
 */
export function findRecoveryConversation(messages, needTools = false) {
  const sigs = sigsOf(messages);
  const incoming = sigs
    .map((sig, index) => ({ sig, index }))
    .filter((item) => !item.sig.startsWith("system|"));
  let best = null;
  let ambiguous = false;
  for (const entry of entries) {
    if (entry.key) continue;
    if (!entry.chatUrl || entry.recovery) continue;
    if (needTools && !entry.hadTools) continue;
    const committed = entry.sig.filter((sig) => !sig.startsWith("system|"));
    if (committed.length < 3 || committed.length >= incoming.length) continue;
    let matches = true;
    for (let i = 0; i < committed.length; i++) {
      if (committed[i] !== incoming[i].sig) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const candidate = {
      entry,
      startIndex: incoming[committed.length - 1].index + 1,
      matchedMessages: committed.length,
    };
    if (!best || candidate.matchedMessages > best.matchedMessages) {
      best = candidate;
      ambiguous = false;
    } else if (candidate.matchedMessages === best.matchedMessages) {
      ambiguous = true;
    }
  }
  if (!best || ambiguous) return null;
  best.entry.lastUsed = Date.now();
  saveStore();
  return best;
}

/**
 * Rediscover a quarantined mapping after one or more failed recovery-control
 * turns and a regenerated system/MCP preamble. Only persisted hashed
 * signatures are compared; raw prompts are never stored. The full pending
 * non-system history must be one unique prefix of the incoming transcript.
 */
export function findQuarantinedRecoveryConversation(
  messages,
  needTools = false,
) {
  const sigs = sigsOf(messages);
  const stableRecoveryAnchor = (sig) =>
    !sig.startsWith("system|") &&
    !(/^a\|/.test(sig) && !sig.startsWith("a|tc:"));
  const incoming = sigs
    .map((sig, index) => ({ sig, index }))
    .filter((item) => stableRecoveryAnchor(item.sig));
  let best = null;
  let ambiguous = false;
  for (const entry of entries) {
    if (entry.key) continue;
    const pending = Array.isArray(entry.recovery?.pendingSig)
      ? entry.recovery.pendingSig.filter(stableRecoveryAnchor)
      : [];
    if (!entry.recovery || !pending.length || pending.length >= incoming.length)
      continue;
    if (needTools && !entry.hadTools) continue;
    if (!pending.every((sig, index) => sig === incoming[index]?.sig)) continue;
    const candidate = {
      entry,
      startIndex: incoming[pending.length - 1].index + 1,
      matchedMessages: pending.length,
    };
    if (!best || candidate.matchedMessages > best.matchedMessages) {
      best = candidate;
      ambiguous = false;
    } else if (candidate.matchedMessages === best.matchedMessages) {
      ambiguous = true;
    }
  }
  if (!best || ambiguous) return null;
  best.entry.lastUsed = Date.now();
  saveStore();
  return best;
}

/**
 * Record a successful turn: the chat identified by `chatUrl` now contains
 * `messages` plus the assistant reply we returned to the client. Updates the
 * matched entry in place, or registers a new one (LRU-evicting the oldest).
 * Returns the entry, or null when there's no chat URL to reuse later.
 */
export function rememberConversation(
  entry,
  messages,
  assistantMsg,
  chatUrl,
  hadTools = false,
  { rawCurrentNode = null, key = null } = {},
) {
  const sig = sigsOf(messages);
  sig.push(sigOf(assistantMsg));
  if (entry) {
    if (key) entry.key = key;
    entry.sig = sig;
    if (chatUrl) entry.chatUrl = chatUrl;
    entry.hadTools = entry.hadTools || hadTools;
    entry.rawCurrentNode = rawCurrentNode || null;
    entry.recovery = null;
    entry.pendingTurn = null;
    entry.lastUsed = Date.now();
    saveStore();
    return entry;
  }
  if (!chatUrl) return null;
  const fresh = {
    key: key || null,
    sig,
    chatUrl,
    lastUsed: Date.now(),
    hadTools,
    rawCurrentNode: rawCurrentNode || null,
    recovery: null,
    pendingTurn: null,
  };
  entries.push(fresh);
  enforceUnkeyedLimit();
  saveStore();
  return fresh;
}

/** Record a submitted transport whose assistant reply was not yet verified. */
export function rememberConversationPendingTurn(
  entry,
  prompt,
  { boundaryNode = null, userMessageID = null, attempts = 1 } = {},
) {
  // A fresh uncommitted chat has no stable session prefix and could match an
  // unrelated request. Pending adoption is therefore limited to an existing
  // mapped conversation.
  if (!entry) return null;
  entry.pendingTurn = {
    state: "submitted-unverified",
    boundaryNode: typeof boundaryNode === "string" ? boundaryNode : null,
    userMessageID: typeof userMessageID === "string" ? userMessageID : null,
    promptDigest: createHash("sha256").update(String(prompt)).digest("hex"),
    attempts: Math.max(1, Number(attempts) || 1),
    detectedAt: Date.now(),
  };
  entry.lastUsed = Date.now();
  saveStore();
  return entry;
}

/** Persist a rejected/uncommitted turn without advancing the safe signature. */
export function rememberConversationRecovery(
  entry,
  messages,
  chatUrl,
  {
    state = "paused",
    reason = "native-tools",
    risk = "unverifiable",
    safeParentNode = null,
    contaminatedNode = null,
    nativeCallNames = [],
    attempts = 0,
    clearPendingTurn = false,
    key = null,
  } = {},
  hadTools = false,
) {
  const recovery = {
    state: state === "auto-pending" ? "auto-pending" : "paused",
    reason: String(reason).slice(0, 80),
    risk: String(risk).slice(0, 80),
    safeParentNode: typeof safeParentNode === "string" ? safeParentNode : null,
    contaminatedNode:
      typeof contaminatedNode === "string" ? contaminatedNode : null,
    nativeCallNames: [...new Set(nativeCallNames)]
      .filter((name) => typeof name === "string")
      .slice(0, 8),
    attempts: Math.max(0, Number(attempts) || 0),
    detectedAt: Date.now(),
    pendingSig: sigsOf(messages),
  };
  if (entry) {
    if (key) entry.key = key;
    if (chatUrl) entry.chatUrl = chatUrl;
    entry.hadTools = entry.hadTools || hadTools;
    entry.recovery = recovery;
    if (clearPendingTurn) entry.pendingTurn = null;
    entry.lastUsed = Date.now();
    saveStore();
    return entry;
  }
  const fresh = {
    key: key || null,
    sig: [],
    chatUrl: chatUrl || null,
    lastUsed: Date.now(),
    hadTools,
    rawCurrentNode: null,
    recovery,
    pendingTurn: null,
  };
  entries.push(fresh);
  enforceUnkeyedLimit();
  saveStore();
  return fresh;
}

/** Stop routing follow-ups into a chat (deleted, wedged, or errored). */
export function forgetConversation(entry) {
  const i = entries.indexOf(entry);
  if (i >= 0) {
    entries.splice(i, 1);
    saveStore();
  }
}

/** Forget a local application mapping without deleting the ChatGPT chat. */
export function forgetConversationByKey(key) {
  const entry = entries.find((candidate) => candidate.key === key);
  if (!entry) return false;
  forgetConversation(entry);
  return true;
}

export function trackedConversations() {
  return entries.length;
}

/** Snapshot for the status page (no mutation). */
export function listConversations() {
  return entries
    .slice()
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .map((e) => ({
      key: e.key || null,
      chatUrl: e.chatUrl,
      turns: e.sig.length,
      hadTools: !!e.hadTools,
      lastUsed: e.lastUsed,
      recoveryState: e.recovery?.state || null,
      rawCursor: !!e.rawCurrentNode,
      pendingTurnState: e.pendingTurn?.state || null,
    }));
}

export { STORE_FILE, STORE_ENABLED };
