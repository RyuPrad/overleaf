// stream-guard.js
// Cautious live-streaming helper for Playwright DOM scrapes.
//
// ChatGPT's rendered reply can rewrite mid-generation (the old STREAM_OK
// corruption). Strategy:
//   - While new text still starts with everything we already emitted, emit
//     the new tail immediately (true live streaming into OpenCode's TUI).
//   - If a rewrite touches already-emitted characters, abandon further live
//     emits for this turn. The caller still gets the final authoritative
//     reply; finish() only appends when the final text still prefix-matches.
//
// Optional tipHoldback keeps the last N characters uncommitted so a flickering
// tip doesn't spam tiny rewrites; committed prefix is still protected.

const PLACEHOLDER = /^(thinking|reasoning)(\.{0,3}|…)$/i;

/**
 * @param {(delta: string) => void} onToken
 * @param {{tipHoldback?: number}} [opts]
 */
export function createGuardedEmitter(onToken, opts = {}) {
  const TIP = Math.max(0, opts.tipHoldback ?? 24);
  let emitted = "";
  let abandoned = false;
  const emit = typeof onToken === "function" ? onToken : null;

  function push(delta) {
    if (!delta || !emit) return;
    emitted += delta;
    try {
      emit(delta);
    } catch {
      /* client gone */
    }
  }

  function observe(raw) {
    if (!emit || abandoned) return;
    const text = String(raw || "").trim();
    if (!text || PLACEHOLDER.test(text)) return;

    // Committed prefix was rewritten — stop live emits for this turn.
    if (emitted && !text.startsWith(emitted)) {
      abandoned = true;
      return;
    }

    // Hold back the tip so a flickering last few chars aren't committed yet.
    const commitUpTo = text.length <= TIP ? 0 : text.length - TIP;
    if (commitUpTo <= emitted.length) return;
    if (!text.startsWith(emitted)) {
      abandoned = true;
      return;
    }
    push(text.slice(emitted.length, commitUpTo));
  }

  /** Flush any remainder that still prefix-matches. Returns bytes newly emitted. */
  function finish(finalRaw) {
    if (!emit) return 0;
    const finalText = String(finalRaw || "").trim();
    if (!finalText) return 0;
    if (abandoned && emitted && !finalText.startsWith(emitted)) {
      return 0;
    }
    if (!finalText.startsWith(emitted)) {
      if (!emitted) {
        push(finalText);
        return finalText.length;
      }
      return 0;
    }
    const delta = finalText.slice(emitted.length);
    if (!delta) return 0;
    push(delta);
    return delta.length;
  }

  return {
    observe,
    finish,
    getEmitted: () => emitted,
    wasAbandoned: () => abandoned,
  };
}
