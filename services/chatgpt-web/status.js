// status.js
// In-process status for the GET / dashboard and /health enrichment.
// Updated by the request queue; no I/O of its own.

const recent = [];
const RECENT_MAX = 20;

let busy = null; // { startedAt, preview, kind }
let cooldownMs = 0;
let rateLimitedUntil = 0;
let lastError = null;
const recovery = {
  sameChat: 0,
  freshCompact: 0,
  terminal: 0,
};
/** @type {AbortController | null} */
let activeController = null;

export function setCooldownMs(ms) {
  cooldownMs = Math.max(0, Number(ms) || 0);
}

export function setRateLimitedUntil(ts) {
  rateLimitedUntil = Number(ts) || 0;
}

export function beginBusy(kind, preview) {
  const token = Symbol("chatgpt-web-busy");
  busy = {
    token,
    startedAt: Date.now(),
    kind: kind || "chat",
    preview: String(preview || "").replace(/\s+/g, " ").trim().slice(0, 120),
  };
  return token;
}

export function endBusy(token = null) {
  if (token && busy?.token !== token) return;
  busy = null;
}

/**
 * Register the AbortController for the in-flight ChatGPT turn so POST /cancel
 * (and client disconnect) can stop Playwright instead of leaving OpenCode
 * spinning until the hard timeout.
 */
export function setActiveController(controller) {
  activeController = controller || null;
}

export function clearActiveController(controller) {
  if (!controller || activeController === controller) {
    activeController = null;
  }
}

/** @returns {boolean} true if a request was aborted */
export function requestCancel(reason = "manual cancel") {
  if (!activeController) return false;
  try {
    activeController.abort(reason);
  } catch {
    /* already aborted */
  }
  return true;
}

export function hasActiveRequest() {
  return !!activeController && !activeController.signal.aborted;
}

export function noteRecovery(stage) {
  if (stage in recovery) recovery[stage] += 1;
}

export function recordRequest(entry) {
  recent.unshift({
    ts: Date.now(),
    ok: !!entry.ok,
    kind: entry.kind || "chat",
    ms: entry.ms || 0,
    charsIn: entry.charsIn || 0,
    charsOut: entry.charsOut || 0,
    error: entry.error ? String(entry.error).slice(0, 200) : null,
    chatUrl: entry.chatUrl || null,
    streamed: !!entry.streamed,
    recoveryStage: entry.recoveryStage || "none",
    protocolAttempts: Number(entry.protocolAttempts) || 1,
    sentPromptChars: Number(entry.sentPromptChars) || entry.charsIn || 0,
    fullPromptChars: Number(entry.fullPromptChars) || entry.charsIn || 0,
    conversationReused: !!entry.conversationReused,
    replySource: entry.replySource || "rendered-dom",
    replyRecovery: entry.replyRecovery || "none",
    nativeToolInspection: entry.nativeToolInspection || "unavailable",
    nativeToolNames: Array.isArray(entry.nativeToolNames)
      ? entry.nativeToolNames.slice(0, 8).map((name) => String(name).slice(0, 120))
      : [],
    nativeToolSuppression: entry.nativeToolSuppression || "unavailable",
    memorySuppression: entry.memorySuppression || "unavailable",
    disabledFeatureCount: Number(entry.disabledFeatureCount) || 0,
    disabledToolCount: Number(entry.disabledToolCount) || 0,
    appPreflight: entry.appPreflight || "unavailable",
    nativeToolSideEffectsPossible: !!entry.nativeToolSideEffectsPossible,
    nativeToolRisk: entry.nativeToolRisk || "none",
    rawNodeClass: entry.rawNodeClass || "unavailable",
    rawAuditReason: entry.rawAuditReason || "unavailable",
    deliveryState: entry.deliveryState || "unknown",
    recoveredNativeToolNames: Array.isArray(entry.recoveredNativeToolNames)
      ? entry.recoveredNativeToolNames.slice(0, 8).map((name) => String(name).slice(0, 120))
      : [],
    recoveryAttempt: Number(entry.recoveryAttempt) || 0,
    recoveryParentVerified: !!entry.recoveryParentVerified,
    inputImageCount: Number(entry.inputImageCount) || 0,
    uploadedImageCount: Number(entry.uploadedImageCount) || 0,
    rateLimitRetries: Number(entry.rateLimitRetries) || 0,
    rateLimitWaitMs: Number(entry.rateLimitWaitMs) || 0,
    rateLimitSource: entry.rateLimitSource || "none",
    queueWaitMs: Number(entry.queueWaitMs) || 0,
    failureStage: entry.failureStage || "none",
    messageSubmitted: !!entry.messageSubmitted,
    rawReader: entry.rawReader || "none",
    rawReaderOutcomes: Array.isArray(entry.rawReaderOutcomes)
      ? entry.rawReaderOutcomes.slice(-12).map((outcome) => ({
          reader: String(outcome?.reader || "unknown").slice(0, 80),
          outcome: String(outcome?.outcome || "unknown").slice(0, 120),
          status: Number(outcome?.status) || null,
        }))
      : [],
    cleanupState: entry.cleanupState || "not-needed",
    unverifiedReplyAuthorized: !!entry.unverifiedReplyAuthorized,
  });
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
  if (!entry.ok && entry.error) {
    lastError = { ts: Date.now(), message: String(entry.error).slice(0, 300) };
  }
}

export function getStatus(extra = {}) {
  const now = Date.now();
  return {
    ok: true,
    ts: now,
    busy: busy
      ? {
          kind: busy.kind,
          preview: busy.preview,
          sinceMs: now - busy.startedAt,
          startedAt: busy.startedAt,
        }
      : null,
    cancellable: hasActiveRequest(),
    cooldownMs,
    rateLimitedForMs: Math.max(0, rateLimitedUntil - now),
    rateLimitedUntil: rateLimitedUntil || null,
    lastError,
    recovery: { ...recovery },
    recent: recent.slice(0, RECENT_MAX),
    ...extra,
  };
}
