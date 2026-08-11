import { sanitizeProviderError } from "./error-sanitize.js";

const CHARS_PER_TOKEN = 4;

function estimateTokens(value) {
  return Math.max(0, Math.round(String(value ?? "").length / CHARS_PER_TOKEN));
}

function resultText(result) {
  if (!result || typeof result !== "object") return "";
  if (!Array.isArray(result.calls) || result.calls.length === 0) {
    return String(result.reply ?? "");
  }
  return result.calls
    .map((call) =>
      [
        call?.purpose,
        call?.name,
        typeof call?.arguments === "string" ? call.arguments : JSON.stringify(call?.arguments ?? {}),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n");
}

function usage(result) {
  const input = estimateTokens(result?.prompt);
  const text = estimateTokens(resultText(result));
  const reasoning = estimateTokens(result?.meta?.thinking);
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: text + reasoning,
      text,
      reasoning,
    },
  };
}

const runtimeOptionNames = {
  dataDir: "CHATGPT_WEB_DATA_DIR",
  envFile: "CHATGPT_WEB_ENV_FILE",
  sessionFile: "CHATGPT_WEB_SESSION_FILE",
  conversationFile: "CHATGPT_WEB_CONVERSATION_FILE",
  backend: "BACKEND",
  headed: "HEADED",
  debug: "DEBUG",
  persistChat: "PERSIST_CHAT",
  persistMaxChats: "PERSIST_MAX_CHATS",
  persistStore: "PERSIST_STORE",
  localTitle: "LOCAL_TITLE",
  liveStream: "LIVE_STREAM",
  streamThinking: "STREAM_THINKING",
  strictModelSelection: "STRICT_MODEL_SELECTION",
  refreshSession: "REFRESH_SESSION",
  chatModel: "CHAT_MODEL",
  chatEffort: "CHAT_EFFORT",
  cooldownMs: "COOLDOWN_MS",
  cooldownMinMs: "COOLDOWN_MIN_MS",
  cooldownMaxMs: "COOLDOWN_MAX_MS",
  rateLimitBackoffMs: "RATE_LIMIT_BACKOFF_MS",
  rateLimitMinBackoffMs: "RATE_LIMIT_MIN_BACKOFF_MS",
  rateLimitMaxBackoffMs: "RATE_LIMIT_MAX_BACKOFF_MS",
  replyTimeoutMs: "REPLY_TIMEOUT_MS",
  replyHardCapMs: "REPLY_HARD_CAP_MS",
  replyIdleGraceMs: "REPLY_IDLE_GRACE_MS",
  replyStallMs: "REPLY_STALL_MS",
  turnHardCapMs: "TURN_HARD_CAP_MS",
  preSubmitTimeoutMs: "PRE_SUBMIT_TIMEOUT_MS",
  turnAbortGraceMs: "TURN_ABORT_GRACE_MS",
  rawPostcheckTimeoutMs: "RAW_POSTCHECK_TIMEOUT_MS",
  toolDescMax: "TOOL_DESC_MAX",
  toolPreambleMax: "TOOL_PREAMBLE_MAX",
  bashCommandMax: "BASH_COMMAND_MAX",
};

function environmentValue(value) {
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

export function runtimeEnvironment(options = {}) {
  const runtime = options.runtime && typeof options.runtime === "object" ? options.runtime : options;
  return Object.fromEntries(
    Object.entries(runtimeOptionNames)
      .filter(([name]) => runtime[name] !== undefined && runtime[name] !== null)
      .map(([name, environmentName]) => [environmentName, environmentValue(runtime[name])]),
  );
}

function configureRuntime(options) {
  for (const [name, value] of Object.entries(runtimeEnvironment(options))) {
    process.env[name] = value;
  }
}

function outputText(output) {
  if (!output || typeof output !== "object") return String(output ?? "");
  if (output.type === "text" || output.type === "error-text") return output.value;
  if (output.type === "json" || output.type === "error-json") {
    return JSON.stringify(output.value);
  }
  if (output.type === "execution-denied") {
    return output.reason ? `Tool execution denied: ${output.reason}` : "Tool execution denied";
  }
  if (output.type === "content") {
    return (output.value || [])
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "file-url") return `[file: ${part.url}]`;
        if (part.type === "file-id") return `[file id: ${JSON.stringify(part.fileId)}]`;
        if (part.type === "file-data" || part.type === "image-data") {
          return `[${part.type}: ${part.mediaType || "application/octet-stream"}]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(output);
}

const imageExtensions = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function normalizedImage(part) {
  if (part?.type !== "file") return null;
  let mediaType = String(part.mediaType || "").toLowerCase();
  if (mediaType === "image/jpg") mediaType = "image/jpeg";
  if (!mediaType.startsWith("image/")) return null;
  if (!imageExtensions[mediaType]) {
    throw new Error(`chatgpt-web: unsupported image type ${mediaType || "unknown"}`);
  }

  let data = part.data;
  if (data instanceof URL) {
    if (data.protocol !== "data:") {
      throw new Error("chatgpt-web: remote image URLs must be downloaded by the AI SDK before provider execution");
    }
    const match = data.href.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/s);
    if (!match) throw new Error("chatgpt-web: image data URL must contain base64 data");
    mediaType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
    data = match[2];
  } else if (data instanceof Uint8Array) {
    data = Buffer.from(data).toString("base64");
  } else if (typeof data === "string" && data.startsWith("data:")) {
    const match = data.match(/^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/s);
    if (!match) throw new Error("chatgpt-web: image data URL must contain base64 data");
    mediaType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
    data = match[2];
  }

  if (!imageExtensions[mediaType]) {
    throw new Error(`chatgpt-web: unsupported image type ${mediaType || "unknown"}`);
  }
  if (typeof data !== "string" || !data.trim() || Buffer.from(data, "base64").length === 0) {
    throw new Error("chatgpt-web: image file is empty or corrupted");
  }

  const fallback = `image${imageExtensions[mediaType]}`;
  const original = String(part.filename || "clipboard").split(/[\\/]/).pop() || fallback;
  const filename = /\.[a-z0-9]{1,8}$/i.test(original) ? original : original + imageExtensions[mediaType];
  return { data: data.trim(), mediaType, filename };
}

function partText(part) {
  if (!part || typeof part !== "object") return "";
  if (part.type === "text") return part.text || "";
  if (part.type === "file") {
    const name = part.filename || (part.data instanceof URL ? part.data.href : "attachment");
    return `[file: ${name}; ${part.mediaType || "application/octet-stream"}]`;
  }
  return "";
}

function messages(prompt) {
  const out = [];
  for (const message of prompt || []) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content || "" });
      continue;
    }

    if (message.role === "user") {
      const text = [];
      const images = [];
      for (const part of message.content || []) {
        const image = normalizedImage(part);
        if (image) {
          images.push(image);
          text.push(`[image: ${image.filename}; ${image.mediaType}]`);
          continue;
        }
        const value = partText(part);
        if (value) text.push(value);
      }
      out.push({
        role: "user",
        content: text.join("\n"),
        ...(images.length ? { images } : {}),
      });
      continue;
    }

    if (message.role === "assistant") {
      const text = (message.content || []).map(partText).filter(Boolean).join("\n");
      const calls = (message.content || [])
        .filter((part) => part?.type === "tool-call")
        .map((part) => ({
          id: part.toolCallId,
          type: "function",
          function: {
            name: part.toolName,
            arguments:
              typeof part.input === "string" ? part.input : JSON.stringify(part.input ?? {}),
          },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      for (const part of message.content || []) {
        if (part?.type !== "tool-result") continue;
        out.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          name: part.toolName,
          content: outputText(part.output),
        });
      }
      continue;
    }

    if (message.role === "tool") {
      for (const part of message.content || []) {
        if (part?.type !== "tool-result") continue;
        out.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          name: part.toolName,
          content: outputText(part.output),
        });
      }
    }
  }
  return out;
}

function tools(input) {
  return (input || [])
    .filter((tool) => tool?.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || "",
        parameters: tool.inputSchema || { type: "object", properties: {} },
      },
    }));
}

function toolChoice(input) {
  if (!input || input.type === "auto") return "auto";
  if (input.type === "none") return "none";
  if (input.type === "required") return "required";
  if (input.type === "tool") {
    return { type: "function", function: { name: input.toolName } };
  }
  return "auto";
}

function metadata(meta) {
  const values = Object.fromEntries(
    Object.entries({
      chatUrl: meta?.chatUrl,
      model: meta?.model,
      effort: meta?.effort,
      usageSource: meta?.usageSource ?? "estimated-chars",
      requestedModel: meta?.requestedModel,
      requestedEffort: meta?.requestedEffort,
      selectionVerified: meta?.selection_verified,
      localTitle: meta?.localTitle,
      messageSubmitted: meta?.messageSubmitted,
      conversationReused: meta?.conversationReused,
      recoveryStage: meta?.recoveryStage,
      protocolAttempts: meta?.protocolAttempts,
      sentPromptChars: meta?.sentPromptChars,
      fullPromptChars: meta?.fullPromptChars,
      replySource: meta?.replySource,
      replyRecovery: meta?.replyRecovery,
      nativeToolInspection: meta?.nativeToolInspection,
      nativeToolNames: meta?.nativeToolNames,
      nativeToolSuppression: meta?.nativeToolSuppression,
      memorySuppression: meta?.memorySuppression,
      disabledFeatureCount: meta?.disabledFeatureCount,
      disabledToolCount: meta?.disabledToolCount,
      appPreflight: meta?.appPreflight,
      nativeToolSideEffectsPossible: meta?.nativeToolSideEffectsPossible,
      nativeToolRisk: meta?.nativeToolRisk,
      rawNodeClass: meta?.rawNodeClass,
      rawAuditReason: meta?.rawAuditReason,
      deliveryState: meta?.deliveryState,
      promptTransport: meta?.promptTransport,
      domState: meta?.domState,
      deliveredReplyAdopted: meta?.deliveredReplyAdopted,
      unverifiedReplyAuthorized: meta?.unverifiedReplyAuthorized,
      firewallResetAfterOverride: meta?.firewallResetAfterOverride,
      recoveredNativeToolNames: meta?.recoveredNativeToolNames,
      recoveryAttempt: meta?.recoveryAttempt,
      recoveryParentVerified: meta?.recoveryParentVerified,
      inputImageCount: meta?.inputImageCount,
      uploadedImageCount: meta?.uploadedImageCount,
      rateLimitRetries: meta?.rateLimitRetries,
      rateLimitWaitMs: meta?.rateLimitWaitMs,
      rateLimitSource: meta?.rateLimitSource,
      queueWaitMs: meta?.queueWaitMs,
      failureStage: meta?.failureStage,
      rawReader: meta?.rawReader,
      rawReaderOutcomes: meta?.rawReaderOutcomes,
      cleanupState: meta?.cleanupState,
    }).filter((entry) => entry[1] !== undefined && entry[1] !== null)
  );
  return Object.keys(values).length ? { chatgptWeb: values } : undefined;
}

function content(result) {
  if (result.calls.length) {
    return result.calls.flatMap((call) => [
      ...(call.purpose
        ? [
            {
              type: "text",
              text: call.purpose,
              providerMetadata: metadata(result.meta),
            },
          ]
        : []),
      {
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: call.arguments,
        providerMetadata: metadata(result.meta),
      },
    ]);
  }
  const parts = [];
  if (result.meta?.thinking) {
    parts.push({
      type: "reasoning",
      text: result.meta.thinking,
      providerMetadata: metadata(result.meta),
    });
  }
  parts.push({
    type: "text",
    text: result.reply,
    providerMetadata: metadata(result.meta),
  });
  return parts;
}

function finishReason(result) {
  return {
    unified: result.calls.length ? "tool-calls" : "stop",
    raw: result.calls.length ? "tool_calls" : "stop",
  };
}

class ChatGPTWebLanguageModel {
  specificationVersion = "v3";
  supportedUrls = {};

  constructor(provider, modelId, complete) {
    this.provider = provider;
    this.modelId = modelId;
    this.complete = complete;
  }

  async doGenerate(options) {
    let result;
    try {
      result = await this.complete({
        messages: messages(options.prompt),
        tools: tools(options.tools),
        toolChoice: toolChoice(options.toolChoice),
        model: this.modelId,
        signal: options.abortSignal,
      });
    } catch (error) {
      throw sanitizeProviderError(error);
    }
    return {
      content: content(result),
      finishReason: finishReason(result),
      usage: usage(result),
      providerMetadata: metadata(result.meta),
      warnings: [],
      request: {
        body: { provider: this.provider, model: this.modelId, promptChars: result.prompt.length },
      },
    };
  }

  async doStream(options) {
    const controller = new AbortController();
    const signal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, controller.signal])
      : controller.signal;

    return {
      stream: new ReadableStream({
        start: (stream) => {
          let textOpen = false;
          let reasoningOpen = false;
          let textChars = 0;
          let reasoningChars = 0;
          let closed = false;

          const emit = (part) => {
            if (closed) return;
            try {
              stream.enqueue(part);
            } catch {
              closed = true;
            }
          };
          const startText = () => {
            if (textOpen) return;
            textOpen = true;
            emit({ type: "text-start", id: "text-0" });
          };
          const startReasoning = () => {
            if (reasoningOpen) return;
            reasoningOpen = true;
            emit({ type: "reasoning-start", id: "reasoning-0" });
          };

          emit({ type: "stream-start", warnings: [] });
          this.complete({
            messages: messages(options.prompt),
            tools: tools(options.tools),
            toolChoice: toolChoice(options.toolChoice),
            model: this.modelId,
            signal,
            onToken: (delta) => {
              if (!delta) return;
              startText();
              textChars += delta.length;
              emit({ type: "text-delta", id: "text-0", delta });
            },
            onThinking: (delta) => {
              if (!delta) return;
              startReasoning();
              reasoningChars += delta.length;
              emit({ type: "reasoning-delta", id: "reasoning-0", delta });
            },
            onStatus: (status) => {
              const label =
                typeof status?.label === "string" ? status.label.trim() : "";
              if (!label) return;
              emit({
                type: "raw",
                rawValue: {
                  opencode: {
                    type: "provider-status",
                    label,
                    ...(Number.isFinite(status.next) && status.next > 0
                      ? { next: Math.floor(status.next) }
                      : {}),
                    ...(Number.isFinite(status.attempt) && status.attempt > 0
                      ? { attempt: Math.floor(status.attempt) }
                      : {}),
                  },
                },
              });
            },
          }).then(
            (result) => {
              const providerMetadata = metadata(result.meta);
              if (result.meta?.thinking && reasoningChars === 0) {
                startReasoning();
                emit({
                  type: "reasoning-delta",
                  id: "reasoning-0",
                  delta: result.meta.thinking,
                  providerMetadata,
                });
              }
              if (reasoningOpen) {
                emit({ type: "reasoning-end", id: "reasoning-0", providerMetadata });
                reasoningOpen = false;
              }

              if (result.calls.length) {
                const purpose = result.calls
                  .map((call) => String(call.purpose || "").trim())
                  .filter(Boolean)
                  .join("\n");
                if (purpose && textChars === 0) {
                  startText();
                  textChars += purpose.length;
                  emit({
                    type: "text-delta",
                    id: "text-0",
                    delta: purpose,
                    providerMetadata,
                  });
                }
                if (textOpen) {
                  emit({ type: "text-end", id: "text-0", providerMetadata });
                  textOpen = false;
                }
                for (const call of result.calls) {
                  emit({
                    type: "tool-call",
                    toolCallId: call.id,
                    toolName: call.name,
                    input: call.arguments,
                    providerMetadata,
                  });
                }
              } else {
                if (textChars === 0) {
                  startText();
                  emit({
                    type: "text-delta",
                    id: "text-0",
                    delta: result.reply,
                    providerMetadata,
                  });
                }
                if (textOpen) {
                  emit({ type: "text-end", id: "text-0", providerMetadata });
                  textOpen = false;
                }
              }

              emit({
                type: "finish",
                usage: usage(result),
                finishReason: finishReason(result),
                providerMetadata,
              });
              if (!closed) {
                closed = true;
                stream.close();
              }
            },
            (error) => {
              if (reasoningOpen) emit({ type: "reasoning-end", id: "reasoning-0" });
              if (textOpen) emit({ type: "text-end", id: "text-0" });
              emit({ type: "error", error: sanitizeProviderError(error) });
              if (!closed) {
                closed = true;
                stream.close();
              }
            }
          );
        },
        cancel: (reason) => controller.abort(reason),
      }),
      request: { body: { provider: this.provider, model: this.modelId } },
    };
  }
}

export function createChatGPTWeb(options = {}) {
  configureRuntime(options);
  const provider = String(options.name || "chatgpt-web");
  const complete =
    typeof options.complete === "function"
      ? options.complete
      : async (input) => {
          const { completeChatGPTWeb } = await import("./server.js");
          return completeChatGPTWeb(input);
        };
  return {
    languageModel(modelId) {
      return new ChatGPTWebLanguageModel(provider, modelId, complete);
    },
  };
}

export async function chatGPTWebStatus() {
  const [{ listConversations, trackedConversations }, { getStatus }] = await Promise.all([
    import("./conversation-store.js"),
    import("./status.js"),
  ]);
  return getStatus({
    provider: "chatgpt-web",
    trackedChats: trackedConversations(),
    chats: listConversations(),
  });
}

export async function cancelChatGPTWeb(reason = "OpenCode cancel") {
  const { requestCancel } = await import("./status.js");
  return requestCancel(reason);
}

export async function closeChatGPTWeb() {
  const { closeSharedSession } = await import("./session.js");
  await closeSharedSession();
}
