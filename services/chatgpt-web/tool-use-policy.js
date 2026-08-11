function toolName(tool) {
  return String(tool?.function?.name || tool?.name || "");
}

function namedChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return null;
  return String(toolChoice?.function?.name || toolChoice?.toolName || "").trim() || null;
}

/**
 * Resolve only the caller's explicit tool-choice contract. Tool availability
 * never implies requirement, and prompt wording never changes the mode.
 */
export function resolveToolUsePolicy(_messages, tools = [], toolChoice) {
  const names = new Set((tools || []).map(toolName).filter(Boolean));
  if (toolChoice === "none") {
    return {
      mode: "none",
      required: false,
      inferred: false,
      reason: "none",
      preferredTool: null,
      expectedTool: null,
      missing: false,
      satisfied: false,
    };
  }

  const expectedTool = namedChoice(toolChoice);
  if (expectedTool) {
    return {
      mode: "named",
      required: true,
      inferred: false,
      reason: "named",
      preferredTool: expectedTool,
      expectedTool,
      missing: !names.has(expectedTool),
      satisfied: false,
    };
  }

  if (toolChoice === "required") {
    return {
      mode: "required",
      required: true,
      inferred: false,
      reason: "required",
      preferredTool: null,
      expectedTool: null,
      missing: names.size === 0,
      satisfied: false,
    };
  }

  return {
    mode: "auto",
    required: false,
    inferred: false,
    reason: null,
    preferredTool: null,
    expectedTool: null,
    missing: false,
    satisfied: false,
  };
}

/** Reject calls that conflict with none or a named choice. */
export function toolCallPolicyError(call, policy) {
  if (!call || !policy) return null;
  if (policy.mode === "none") {
    return `Tool choice "none" rejects tool call "${call.name}"`;
  }
  if (policy.mode === "named" && call.name !== policy.expectedTool) {
    return `Named tool choice requires exactly "${policy.expectedTool}", not "${call.name}"`;
  }
  return null;
}

/** Return whether this explicit contract requires a tool call. */
export function expectsToolUse(tools, toolChoice) {
  if (!tools?.length) return false;
  if (toolChoice === "required") return true;
  return Boolean(namedChoice(toolChoice));
}
