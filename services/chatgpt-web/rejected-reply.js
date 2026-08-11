// Keep a rejected assistant reply available for an explicit, one-time user
// disclosure without making it enumerable on the transport error. This avoids
// leaking reply text through generic Error serialization or debug logging.

const REJECTED_REPLY = Symbol("chatgpt-web.rejected-reply");
const MAX_CAPTURED_REPLY_CHARS = 8 * 1024 * 1024;

export function attachRejectedReply(error, reply, {
  source = "unverified",
} = {}) {
  if (!error || typeof reply !== "string") return error;
  const text = reply.trim();
  if (!text || text.length > MAX_CAPTURED_REPLY_CHARS) return error;
  Object.defineProperty(error, REJECTED_REPLY, {
    configurable: false,
    enumerable: false,
    writable: false,
    value: {
      reply: text,
      source: String(source || "unverified").slice(0, 80),
      capturedAt: Date.now(),
    },
  });
  return error;
}

export function rejectedReplyFromError(error) {
  const candidate = error?.[REJECTED_REPLY];
  if (!candidate || typeof candidate.reply !== "string" || !candidate.reply.trim()) {
    return null;
  }
  return candidate;
}

export { MAX_CAPTURED_REPLY_CHARS };
