// idempotency.js
// Replay identical chat-completion requests instead of regenerating tool calls.
// Concurrent duplicates wait on the in-flight promise; explicit key + different
// digest → HTTP 409 conflict.

import { createHash } from "node:crypto";

const TTL_MS = Math.max(
  10_000,
  Number(process.env.IDEMPOTENCY_TTL_MS || 600_000)
);
const MAX_ENTRIES = Math.max(16, Number(process.env.IDEMPOTENCY_MAX || 256));

/**
 * @typedef {{
 *   digest: string,
 *   expires: number,
 *   payload?: object,
 *   promise?: Promise<object>,
 *   resolve?: (v: object) => void,
 *   reject?: (e: Error) => void,
 * }} IdemEntry
 */

/** @type {Map<string, IdemEntry>} */
const cache = new Map();

function prune() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (v.expires <= now && v.payload) cache.delete(k);
  }
  while (cache.size > MAX_ENTRIES) {
    // Prefer dropping completed entries first.
    let dropped = false;
    for (const [k, v] of cache) {
      if (v.payload && !v.promise) {
        cache.delete(k);
        dropped = true;
        break;
      }
    }
    if (!dropped) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    .join(",")}}`;
}

/** Full request digest (messages + full tool defs + tool_choice + model). */
export function requestDigest(body) {
  const fp = stableStringify({
    messages: body?.messages ?? [],
    tools: body?.tools ?? [],
    tool_choice: body?.tool_choice ?? null,
    model: body?.model ?? "gpt",
  });
  return createHash("sha256").update(fp).digest("hex");
}

/**
 * Prefer explicit Idempotency-Key; else use digest-derived key.
 * @returns {{ key: string, digest: string, explicit: boolean }}
 */
export function idempotencyKeyFromRequest(req, body) {
  const digest = requestDigest(body);
  const hdr =
    req?.headers?.["idempotency-key"] ||
    req?.headers?.["x-idempotency-key"] ||
    body?.idempotency_key;
  if (hdr && String(hdr).trim()) {
    return { key: `hdr:${String(hdr).trim()}`, digest, explicit: true };
  }
  return { key: `fp:${digest.slice(0, 40)}`, digest, explicit: false };
}

/**
 * Begin an idempotent operation.
 * @returns {{
 *   mode: 'miss'|'hit'|'wait'|'conflict',
 *   payload?: object,
 *   wait?: Promise<object>,
 *   finish?: (payload: object) => void,
 *   fail?: (err: Error) => void,
 * }}
 */
export function beginIdempotent(key, digest) {
  if (!key) return { mode: "miss", finish() {}, fail() {} };
  prune();
  const existing = cache.get(key);
  if (existing) {
    if (existing.digest !== digest) {
      const err = new Error(
        "Idempotency-Key reused with a different request body"
      );
      err.status = 409;
      err.idempotencyConflict = true;
      return { mode: "conflict", error: err };
    }
    if (existing.payload) {
      return { mode: "hit", payload: existing.payload };
    }
    if (existing.promise) {
      return { mode: "wait", wait: existing.promise };
    }
  }

  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Prevent unhandled rejection if nobody awaits wait.
  promise.catch(() => {});

  const entry = {
    digest,
    expires: Date.now() + TTL_MS,
    promise,
    resolve,
    reject,
  };
  cache.set(key, entry);

  return {
    mode: "miss",
    finish(payload) {
      entry.payload = payload;
      entry.expires = Date.now() + TTL_MS;
      entry.promise = undefined;
      entry.resolve = undefined;
      entry.reject = undefined;
      resolve(payload);
      prune();
    },
    fail(err) {
      cache.delete(key);
      reject(err);
    },
  };
}

/** @deprecated use beginIdempotent — kept for simple completed lookups in tests */
export function getIdempotentResponse(key) {
  if (!key) return null;
  prune();
  const hit = cache.get(key);
  if (!hit?.payload) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.payload;
}

/** @deprecated use beginIdempotent().finish */
export function setIdempotentResponse(key, payload) {
  if (!key || !payload) return;
  prune();
  const digest = cache.get(key)?.digest || "manual";
  cache.set(key, {
    digest,
    expires: Date.now() + TTL_MS,
    payload,
  });
}

export function clearIdempotencyCache() {
  cache.clear();
}

export function idempotencyStats() {
  prune();
  return { size: cache.size, ttlMs: TTL_MS, max: MAX_ENTRIES };
}
