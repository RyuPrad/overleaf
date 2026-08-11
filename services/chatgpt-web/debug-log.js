// debug-log.js
// Routine diagnostics for the native ChatGPT-web provider.
// Must NOT use console.log — that paints over OpenCode's TUI input bar when
// the provider runs in-process. Mirror playwright-backend dbg(): DEBUG=1 only,
// write to stderr.

import { sanitizeDiagnosticText } from "./error-sanitize.js";

const DEBUG = String(process.env.DEBUG ?? "").trim() === "1";

/** True when DEBUG=1. Exported for tests. */
export function debugEnabled() {
  return DEBUG;
}

/**
 * Emit a debug line when DEBUG=1. Prefix defaults to "[server]".
 * @param {string} message
 * @param {string} [prefix]
 */
export function debugLog(message, prefix = "[server]") {
  if (!DEBUG) return;
  const body = sanitizeDiagnosticText(message);
  const line = body.startsWith("[") ? body : `${prefix} ${body}`;
  process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
}
