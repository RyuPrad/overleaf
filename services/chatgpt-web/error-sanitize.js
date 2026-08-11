// Final redaction boundary for browser/provider errors. Playwright can append
// request/response call logs to an exception, including authenticated headers.
// Never forward those values to OpenCode, routine diagnostics, or status logs.

const DEFAULT_MAX_CHARS = 4_000;
const HEADER_NAME =
  "(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)";
const TOKEN_NAME =
  "(?:access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|auth[_-]?token)";

export function sanitizeDiagnosticText(value, maxChars = DEFAULT_MAX_CHARS) {
  let text = String(value ?? "");

  text = text
    .replace(new RegExp(`(^|\\n)(\\s*(?:[-*>]\\s*)?${HEADER_NAME}\\s*:\\s*)[^\\r\\n]*`, "gim"), "$1$2[REDACTED]")
    .replace(new RegExp(`(["']?${HEADER_NAME}["']?\\s*[:=]\\s*["'])[^"'\\r\\n]*(["'])`, "gi"), "$1[REDACTED]$2")
    .replace(new RegExp(`(["']?${TOKEN_NAME}["']?\\s*[:=]\\s*["'])[^"'\\r\\n]*(["'])`, "gi"), "$1[REDACTED]$2")
    .replace(new RegExp(`(\\b${TOKEN_NAME}\\s*[=:]\\s*)[^\\s&;,]+`, "gi"), "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/\b(?:__Secure-|__Host-)?[A-Za-z0-9_.-]*(?:session|auth|token)[A-Za-z0-9_.-]*=[^;\s]+/gi, "[REDACTED_COOKIE]");

  const limit = Math.max(256, Number(maxChars) || DEFAULT_MAX_CHARS);
  if (text.length > limit) {
    text = `${text.slice(0, limit)}\n[diagnostic truncated]`;
  }
  return text;
}

const SAFE_ERROR_PROPERTIES = Object.freeze([
  "cancelled",
  "chatUrl",
  "chatgptWebErrorCode",
  "continuationFailed",
  "conversationTooLong",
  "deliveryState",
  "fakeDeliverable",
  "failureStage",
  "imageUploadRetryable",
  "malformedToolCall",
  "mcpMissing",
  "messageNotSubmitted",
  "messageSubmitted",
  "modelSelectionFailed",
  "nativeAssistantCallNames",
  "nativeToolInspectionUnavailable",
  "nativeToolNames",
  "nativeToolPolicy",
  "nativeToolRisk",
  "nativeToolSideEffectsPossible",
  "nativeToolSuppressionState",
  "protocolAttempts",
  "preSubmitTimeout",
  "queueWaitMs",
  "rateLimitBackoffMs",
  "rateLimitRetries",
  "rateLimitSource",
  "rateLimitWaitMs",
  "rateLimited",
  "rawAuditReason",
  "rawReader",
  "rawReaderOutcomes",
  "rawNodeClass",
  "recoveryActions",
  "recoveryAttempt",
  "recoveryParentVerified",
  "recoveryStage",
  "rejectedReplyAvailable",
  "sessionExpired",
  "stalled",
  "streamAbandoned",
  "toolMissing",
  "toolPolicy",
  "transientReply",
  "transientReplyChars",
  "turnBudgetExceeded",
  "cleanupState",
  "verificationUnavailable",
]);

function safeProperty(value) {
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return sanitizeDiagnosticText(value, 1_000);
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string")
      .slice(0, 32)
      .map((item) => sanitizeDiagnosticText(item, 160));
  }
  return undefined;
}

export function sanitizeProviderError(error) {
  const source = error && typeof error === "object" ? error : null;
  const message = sanitizeDiagnosticText(source?.message ?? error ?? "Unknown provider error");
  const safe = new Error(message);
  if (typeof source?.name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(source.name)) {
    safe.name = source.name;
  }
  for (const key of SAFE_ERROR_PROPERTIES) {
    const value = key === "rawReaderOutcomes" && Array.isArray(source?.[key])
      ? source[key].slice(-12).map((item) => ({
          reader: sanitizeDiagnosticText(item?.reader || "unknown", 80),
          outcome: sanitizeDiagnosticText(item?.outcome || "unknown", 120),
          status: Number(item?.status) || null,
        }))
      : safeProperty(source?.[key]);
    if (value !== undefined) safe[key] = value;
  }
  return safe;
}
