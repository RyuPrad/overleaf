// tool-call-parse.js
// Strict TOOL_CALL / SHELL_CALL parsing: whole-reply only, allowlist, Ajv.
// Never repair mangled argument semantics.

import { randomUUID } from "node:crypto";
import Ajv from "ajv";

const ajv = new Ajv({
  allErrors: true,
  strict: false, // OpenAI tool schemas often omit `additionalProperties`
  validateSchema: false,
});

/** Bounded cap for raw shell envelopes, including any renderer-added newlines. */
export const BASH_COMMAND_MAX = Number(process.env.BASH_COMMAND_MAX || 4096);

const BASH_TOOL_NAMES = new Set(["bash", "shell", "run_terminal_cmd"]);

function toolName(t) {
  return String(t?.function?.name || t?.name || "");
}

function toolParameters(t) {
  return t?.function?.parameters || t?.parameters || null;
}

function callResult(name, argsObj, purpose, tools) {
  const allowed = (tools || []).map(toolName).filter(Boolean);
  const tool = (tools || []).find((t) => toolName(t) === name);
  if (allowed.length > 0 && !tool) {
    return {
      calls: [],
      error: `Unknown tool "${name}" — not in the request tool list`,
    };
  }

  const schema = tool ? toolParameters(tool) : null;
  if (schema && typeof schema === "object") {
    let validate;
    try {
      validate = ajv.compile(schema);
    } catch (e) {
      return {
        calls: [],
        error: `Tool schema compile failed for "${name}": ${e.message}`,
      };
    }
    if (!validate(argsObj)) {
      return {
        calls: [],
        error: `arguments failed schema for "${name}": ${ajv.errorsText(validate.errors)}`,
      };
    }
  }

  if (typeof purpose !== "string" || !purpose.trim()) {
    return {
      calls: [],
      error: "TOOL_CALL missing user-facing purpose",
    };
  }

  const bashErr = bashCommandPolicyError(name, argsObj);
  if (bashErr) return { calls: [], error: bashErr };

  return {
    calls: [
      {
        id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name,
        arguments: JSON.stringify(argsObj),
        purpose: purpose.replace(/\s+/g, " ").trim().slice(0, 240),
      },
    ],
    error: null,
  };
}

function parseShellCall(text, tools) {
  const trimmed = text.trim();
  if (!/^SHELL_CALL\s*:/i.test(trimmed)) {
    if (/\bSHELL_CALL\b/i.test(trimmed)) {
      return {
        calls: [],
        error: "SHELL_CALL must be the entire reply with no surrounding prose or code fences",
      };
    }
    return null;
  }

  if (/```/.test(trimmed)) {
    return {
      calls: [],
      error: "SHELL_CALL must not use code fences",
    };
  }

  const lines = trimmed.split(/\r?\n/);
  const first = lines.shift()?.match(/^SHELL_CALL\s*:\s*([A-Za-z0-9_.:-]+)\s*$/i);
  if (!first) {
    return {
      calls: [],
      error: "SHELL_CALL first line must be `SHELL_CALL: <shell-tool-name>`",
    };
  }
  const name = first[1];
  if (!BASH_TOOL_NAMES.has(name.toLowerCase())) {
    return {
      calls: [],
      error: `SHELL_CALL only supports bash/shell tools, not "${name}"`,
    };
  }

  const fields = new Map();
  let command = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const field = line.match(/^(PURPOSE|WORKDIR|TIMEOUT_MS|COMMAND)\s*:\s*(.*)$/i);
    if (!field) {
      return {
        calls: [],
        error: "SHELL_CALL contains an unknown field before COMMAND",
      };
    }
    const key = field[1].toUpperCase();
    if (fields.has(key)) {
      return { calls: [], error: `SHELL_CALL contains duplicate ${key}` };
    }
    if (key === "COMMAND") {
      const tail = lines.slice(i + 1);
      if (tail.some((item) => /^\s*SHELL_CALL\s*:/i.test(item))) {
        return { calls: [], error: "SHELL_CALL contains more than one call envelope" };
      }
      command = [field[2], ...tail].join("\n").trim();
      fields.set(key, command);
      break;
    }
    fields.set(key, field[2]);
  }

  const purpose = fields.get("PURPOSE")?.trim();
  command = command?.trim();
  if (!purpose) return { calls: [], error: "SHELL_CALL missing user-facing PURPOSE" };
  if (!command) return { calls: [], error: "SHELL_CALL missing COMMAND" };

  const allowedFields = new Set(["PURPOSE", "WORKDIR", "TIMEOUT_MS", "COMMAND"]);
  for (const key of fields.keys()) {
    if (!allowedFields.has(key)) {
      return { calls: [], error: `SHELL_CALL contains unexpected field ${key}` };
    }
  }

  const argsObj = { command };
  const workdir = fields.get("WORKDIR")?.trim();
  if (fields.has("WORKDIR") && !workdir) {
    return { calls: [], error: "SHELL_CALL WORKDIR cannot be empty" };
  }
  if (workdir) argsObj.workdir = workdir;

  if (fields.has("TIMEOUT_MS")) {
    const rawTimeout = fields.get("TIMEOUT_MS")?.trim() || "";
    if (!/^\d+$/.test(rawTimeout) || Number(rawTimeout) <= 0) {
      return { calls: [], error: "SHELL_CALL TIMEOUT_MS must be a positive integer" };
    }
    argsObj.timeout = Number(rawTimeout);
  }

  return callResult(name, argsObj, purpose, tools);
}

/**
 * Reject oversized bash/shell commands before they reach the execution layer.
 * @returns {string|null} error message or null when ok
 */
export function bashCommandPolicyError(name, argsObj) {
  if (!BASH_TOOL_NAMES.has(String(name || "").toLowerCase())) return null;
  const cmd = argsObj?.command;
  if (typeof cmd !== "string") return null;
  if (cmd.length > BASH_COMMAND_MAX) {
    return (
      `bash command too long (${cmd.length}>${BASH_COMMAND_MAX} chars); ` +
      "split into short multi-turn probes — no mega remote audits in one tool request"
    );
  }
  return null;
}

/**
 * Parse a model reply into at most one tool call.
 * @returns {{ calls: Array<{id,name,arguments,purpose:string}>, error: string|null }}
 *   error set when a TOOL_CALL was attempted but invalid (regenerate).
 *   calls empty + error null when the reply is plain text (no tool call).
 */
export function parseToolCallsStrict(reply, tools = []) {
  const text = String(reply ?? "");
  const shell = parseShellCall(text, tools);
  if (shell) return shell;
  const anchored = text.match(/^\s*TOOL_CALL:\s*(\{[\s\S]*\})\s*$/);

  if (!anchored) {
    if (/TOOL_CALL\b/i.test(text)) {
      return {
        calls: [],
        error:
          "TOOL_CALL must be the entire reply with no surrounding prose or code fences",
      };
    }
    return { calls: [], error: null };
  }

  let obj;
  try {
    obj = JSON.parse(anchored[1]);
  } catch (e) {
    let msg = `Invalid TOOL_CALL JSON (will not repair): ${e.message}`;
    if (/[\r\n]/.test(anchored[1])) {
      msg +=
        " — TOOL_CALL JSON must be a single physical line (raw newlines inside the object commonly cause Unterminated string)";
    }
    return {
      calls: [],
      error: msg,
    };
  }

  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return { calls: [], error: "TOOL_CALL body must be a JSON object" };
  }
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    return { calls: [], error: "TOOL_CALL missing string name" };
  }
  if (obj.purpose !== undefined && typeof obj.purpose !== "string") {
    return { calls: [], error: "TOOL_CALL purpose must be a string" };
  }

  const name = obj.name.trim();

  let argsObj = obj.arguments ?? {};
  if (typeof argsObj === "string") {
    try {
      argsObj = JSON.parse(argsObj);
    } catch (e) {
      return {
        calls: [],
        error: `TOOL_CALL arguments string is not valid JSON: ${e.message}`,
      };
    }
  }
  if (
    typeof argsObj !== "object" ||
    argsObj === null ||
    Array.isArray(argsObj)
  ) {
    return { calls: [], error: "TOOL_CALL arguments must be a JSON object" };
  }

  // Reject unexpected top-level keys that often appear when scrapes merge fields
  const extraTop = Object.keys(obj).filter(
    (k) => k !== "name" && k !== "arguments" && k !== "purpose"
  );
  if (extraTop.length) {
    return {
      calls: [],
      error: `TOOL_CALL has unexpected keys: ${extraTop.join(", ")}`,
    };
  }

  return callResult(name, argsObj, obj.purpose, tools);
}

/** Convenience: calls only (empty on any failure / plain text). */
export function parseToolCalls(reply, tools = []) {
  return parseToolCallsStrict(reply, tools).calls;
}

export const MALFORMED_BASH_EXAMPLE =
  "SHELL_CALL: bash\n" +
  "PURPOSE: Short remote probe through the user's OpenCode host.\n" +
  "COMMAND:\n" +
  "ssh -o BatchMode=yes -o ConnectTimeout=10 root@152.53.241.85 'hostname; ls /opt/netcup-analytics'";

export function formatToolCallForPrompt(name, args, purpose = "Request the OpenCode tool needed for this step.") {
  let parsed = args;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  const safePurpose = String(purpose || "Request the OpenCode tool needed for this step.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  if (
    BASH_TOOL_NAMES.has(String(name || "").toLowerCase()) &&
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    typeof parsed.command === "string" &&
    parsed.command.trim()
  ) {
    return [
      `SHELL_CALL: ${name}`,
      `PURPOSE: ${safePurpose}`,
      ...(typeof parsed.workdir === "string" && parsed.workdir.trim()
        ? [`WORKDIR: ${parsed.workdir.trim()}`]
        : []),
      ...(Number.isInteger(parsed.timeout) && parsed.timeout > 0
        ? [`TIMEOUT_MS: ${parsed.timeout}`]
        : []),
      "COMMAND:",
      parsed.command.trim(),
    ].join("\n");
  }
  return `TOOL_CALL: ${JSON.stringify({
    name: String(name || ""),
    arguments: parsed && typeof parsed === "object" ? parsed : args,
    purpose: safePurpose,
  })}`;
}

/**
 * Build the regenerate nudge after a malformed TOOL_CALL.
 * Prefer a copy-paste bash example when bash is available — models keep
 * inventing mega one-liners that break JSON (Unterminated string / % token).
 */
export function malformedToolNudge(parseError, { hasBash = false } = {}) {
  const err = String(parseError || "");
  const hints = [];
  if (/Unterminated string/i.test(err)) {
    hints.push(
      "Unterminated string usually means shell text was placed inside TOOL_CALL JSON. Use SHELL_CALL and put raw text after COMMAND instead."
    );
  }
  if (/Unrecognized token\s+'?%'?/i.test(err) || /Expected '\}'/i.test(err)) {
    hints.push(
      'Do not use find -printf "%p", echo "...", or printf "..." inside the JSON command — use find -print / echo ===HOST=== / shell single quotes.'
    );
  }
  hints.push("On retry: use the SHELL_CALL envelope. COMMAND must be the final field and may span multiple physical lines.");
  const example = hasBash
    ? `Copy this shape exactly (raw shell quotes are allowed after COMMAND):\n${MALFORMED_BASH_EXAMPLE}`
    : 'Reply with EXACTLY one line:\nTOOL_CALL: {"name":"<tool_name>","arguments":{ ... },"purpose":"<brief user-facing explanation>"}';
  return (
    "\n\n[system]: Your previous tool request was rejected (it must be the ENTIRE reply, use a known tool name, " +
    "and match the tool schema — no prose, no code fences, no repaired/mangled arguments). " +
    hints.join(" ") +
    " " +
    example +
    (err ? `\n[parse error]: ${err}` : "")
  );
}

/**
 * Message posted into the ChatGPT chat so the model sees a harness rejection
 * and can retry with that error in context (instead of only the OpenCode TUI).
 */
export function harnessErrorRetryMessage(errorMessage, recoveryHint = "") {
  const err = String(errorMessage || "unknown harness error").replace(/\s+/g, " ").trim().slice(0, 800);
  const hint = String(recoveryHint || "")
    .replace(/^\s*\[system\]:\s*/i, "")
    .trim();
  return (
    `[harness error]: ${err}\n\n` +
    "The OpenCode harness rejected your previous reply. Read the error, correct course, and respond again. " +
    "If a shell tool is required, reply with one valid SHELL_CALL envelope; for other tools use one valid TOOL_CALL line.\n" +
    (hint ? `\n${hint}` : "")
  );
}
