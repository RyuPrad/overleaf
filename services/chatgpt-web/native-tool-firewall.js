// Fail-closed transport guard for ChatGPT web conversation requests.
//
// ChatGPT decides whether native tools are available from server-side model
// features and account connector links. Prompt text cannot reliably override
// that higher-priority routing. This guard therefore injects the web client's
// own force-disable fields into every conversation submission before it leaves
// Chromium, then requires the raw conversation graph as a postcondition.

import { randomUUID } from "node:crypto";

const MAX_PREFLIGHT_BYTES = 2 * 1024 * 1024;
const PREFLIGHT_TIMEOUT_MS = 30_000;
const NO_NATIVE_TOOLS_INSTRUCTION =
  "All ChatGPT-native tools are disabled for this conversation. Never call native Python/container, web/search, files, Canvas, image generation, computer, apps/connectors, plugins, or any other ChatGPT tool. For actions, return only a compatible OpenCode SHELL_CALL or TOOL_CALL text envelope; otherwise answer in text.";

export const BASELINE_DISABLED_FEATURES = Object.freeze([
  "app_pairing",
  "browser",
  "canvas",
  "container",
  "dalle_3",
  "image_gen_tool_enabled",
  "memory",
  "paragen",
  "python",
  "search",
  "tools",
  "tools2",
  "web",
  "web.run",
]);

// Namespaces observed in ChatGPT's current client bundle. Dynamic model
// features and connector ids are added at runtime, so a new model-advertised
// family is covered even before this baseline is refreshed.
export const BASELINE_DISABLED_TOOL_IDS = Object.freeze([
  "api_tool",
  "api_tool.call_tool",
  "api_tool.list_resources",
  "api_tool.search_tools",
  "app_gen",
  "bio",
  "browser",
  "browsing_team",
  "canmore",
  "computer",
  "container",
  "dalle",
  "file_search",
  "gcal",
  "gcontacts",
  "gmail",
  "gdrive_browser",
  "genui.run",
  "genui.search",
  "gizmo_editor",
  "image_gen",
  "imagegen.make_image",
  "jit_plugin",
  "mtbrowser",
  "myfiles_browser",
  "personal_context",
  "plugins_prototype",
  "python",
  "research_kickoff_tool.clarify_with_text",
  "research_kickoff_tool.start_research_task",
  "safety_settings",
  "user_settings",
  "web",
  "web.run",
  "wiki_browser",
]);

// Only this short, non-sensitive marker is ever placed in ChatGPT's rendered
// composer. The real OpenCode prompt is injected into the intercepted JSON
// request immediately before it leaves Chromium.
export const COMPOSER_SENTINEL = "OpenCode request";

// disable_tool_ids rejects feature names, connector-link ids, and generic
// aliases. Restrict the hidden server-side opt-out message to concrete native
// recipients verified in the current ChatGPT client namespace.
export const SYSTEM_DISABLED_TOOL_IDS = Object.freeze(
  BASELINE_DISABLED_TOOL_IDS.filter(
    (id) => id !== "api_tool" && id !== "computer" && id !== "plugins_prototype"
  )
);

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort();
}

function requireStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`native-tool firewall: ${field} must be a string array`);
  }
  return value;
}

export function collectModelToolFeatures(modelsPayload) {
  const models = Array.isArray(modelsPayload?.models)
    ? modelsPayload.models
    : Array.isArray(modelsPayload)
      ? modelsPayload
      : null;
  if (!models?.length) {
    throw new Error("native-tool firewall: ChatGPT model inventory was empty or malformed");
  }
  const features = uniqueStrings(models.flatMap((model) => {
    if (model?.enabled_tools === undefined) return [];
    if (!Array.isArray(model.enabled_tools) || model.enabled_tools.some((item) => typeof item !== "string")) {
      throw new Error("native-tool firewall: model enabled_tools changed shape");
    }
    return model.enabled_tools;
  }));
  if (!features.length) {
    throw new Error("native-tool firewall: no model tool features were discoverable");
  }
  return features;
}

export function analyzeAccessibleLinks(linksPayload) {
  const links = Array.isArray(linksPayload?.links)
    ? linksPayload.links
    : Array.isArray(linksPayload)
      ? linksPayload
      : null;
  if (!links) {
    throw new Error("native-tool firewall: accessible app-link inventory changed shape");
  }

  const toolIDs = [];
  const external = [];
  for (const link of links) {
    if (!link || typeof link !== "object") {
      throw new Error("native-tool firewall: accessible app link was malformed");
    }
    const id = typeof link.id === "string" ? link.id : "";
    const connectorID = typeof link.connector_id === "string" ? link.connector_id : "";
    if (id) toolIDs.push(id);
    if (connectorID) toolIDs.push(connectorID);

    const implicitFirstParty =
      id.startsWith("implicit_link::connector_openai_") &&
      connectorID.startsWith("connector_openai_") &&
      String(link.auth_type || "").toUpperCase() === "NONE" &&
      String(link.connector_type || "").toUpperCase() === "FIRST_PARTY_ECOSYSTEM";
    if (!implicitFirstParty) {
      external.push(connectorID || id || "unknown-app-link");
    }
  }
  return {
    linkCount: links.length,
    toolIDs: uniqueStrings(toolIDs),
    external: uniqueStrings(external),
  };
}

export function classifyConversationRequest(url, method = "GET") {
  if (String(method).toUpperCase() !== "POST") return "other";
  let pathname;
  try {
    pathname = new URL(url, "https://chatgpt.com").pathname.replace(/\/+$/, "");
  } catch {
    return "other";
  }
  if (!/(?:^|\/)conversation(?:\/|$)/.test(pathname)) return "other";

  const recognized = new Set([
    "/backend-api/f/conversation",
    "/backend-alt/f/conversation",
    "/backend-api/conversation",
    "/backend-alt/conversation",
    "/conversation",
  ]);
  const prepare = new Set([...recognized].map((value) => `${value}/prepare`));
  const resume = new Set([...recognized].map((value) => `${value}/resume`));
  if (recognized.has(pathname)) return "send";
  if (prepare.has(pathname)) return "prepare";
  if (resume.has(pathname)) return "resume";

  // Mutation endpoints for an existing /conversation/<uuid> are not model
  // submissions. Any other POST ending in conversation/prepare/resume is an
  // unknown completion transport and must fail closed.
  if (/\/conversation\/(?:prepare|resume)$/.test(pathname) || /\/conversation$/.test(pathname)) {
    return "unknown-completion";
  }
  return "other";
}

export function validatePreparePayload(payload, expectedComposerText = COMPOSER_SENTINEL) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("native-tool firewall: conversation prepare body was not an object");
  }
  if (typeof payload.action !== "string" || !payload.action.trim()) {
    throw new Error("native-tool firewall: conversation prepare action was missing");
  }
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    throw new Error("native-tool firewall: conversation prepare model was missing");
  }
  if (payload.messages !== undefined) {
    throw new Error("native-tool firewall: conversation prepare messages changed shape");
  }
  const query = payload.partial_query;
  if (query !== undefined && query !== "") {
    const text = typeof query === "string"
      ? query
      : query && typeof query === "object" && !Array.isArray(query) &&
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(query.id) &&
          query.author?.role === "user" &&
          query.content?.content_type === "text" &&
          Array.isArray(query.content.parts) &&
          query.content.parts.length === 1 &&
          typeof query.content.parts[0] === "string"
        ? query.content.parts[0]
        : null;
    if (text === null) {
      throw new Error("native-tool firewall: conversation prepare query changed shape");
    }
    if (text !== expectedComposerText) {
      throw new Error("native-tool firewall: conversation prepare query did not match the composer marker");
    }
  }
  return payload;
}

export function validateIdlePreparePayload(payload) {
  validatePreparePayload(payload);
  if (payload.partial_query !== undefined && payload.partial_query !== "") {
    throw new Error("native-tool firewall: idle conversation prepare unexpectedly contained a query");
  }
  return payload;
}

function clearToolSelections(message) {
  if (!message || typeof message !== "object") return message;
  const copy = { ...message };
  if (copy.metadata && typeof copy.metadata === "object" && !Array.isArray(copy.metadata)) {
    copy.metadata = {
      ...copy.metadata,
      selected_sources: [],
      selected_apps: [],
      selected_connectors: [],
      selected_connector_ids: [],
      selected_github_repos: [],
    };
  }
  return copy;
}

function suppressionSystemMessage(toolIDs) {
  return {
    id: randomUUID(),
    author: { role: "system" },
    content: {
      content_type: "text",
      parts: [NO_NATIVE_TOOLS_INSTRUCTION],
    },
    metadata: {
      disable_tool_ids: toolIDs,
      exclude_after_next_user_message: true,
      is_visually_hidden_from_conversation: true,
    },
  };
}

function suppressionDeveloperMessage() {
  return {
    id: randomUUID(),
    author: { role: "developer" },
    content: { content_type: "text", parts: [NO_NATIVE_TOOLS_INSTRUCTION] },
    metadata: {
      exclude_after_next_user_message: true,
      is_visually_hidden_from_conversation: true,
    },
  };
}

export function patchConversationPayload(
  payload,
  inventory,
  {
    allowNoMessages = false,
    branchParentNode = null,
    expectedComposerText = null,
    replacementUserText = null,
  } = {}
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("native-tool firewall: conversation body was not an object");
  }
  if (typeof payload.action !== "string" || !payload.action.trim()) {
    throw new Error("native-tool firewall: conversation action was missing");
  }
  if ((!Array.isArray(payload.messages) || !payload.messages.length) && !allowNoMessages) {
    throw new Error("native-tool firewall: conversation messages were missing");
  }
  if (payload.messages !== undefined && !Array.isArray(payload.messages)) {
    throw new Error("native-tool firewall: conversation messages changed shape");
  }
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    throw new Error("native-tool firewall: conversation model was missing");
  }
  if (!inventory || !Array.isArray(inventory.features) || !Array.isArray(inventory.toolIDs)) {
    throw new Error("native-tool firewall: suppression inventory was not armed");
  }

  const forceDisableFeatures = uniqueStrings([
    ...requireStringArray(payload.force_disable_features, "force_disable_features"),
    ...BASELINE_DISABLED_FEATURES,
    ...inventory.features,
  ]);
  const forceDisableToolIDs = uniqueStrings([
    ...requireStringArray(payload.force_disable_tool_ids, "force_disable_tool_ids"),
    ...BASELINE_DISABLED_TOOL_IDS,
    ...inventory.toolIDs,
    ...inventory.features,
  ]);

  // This hidden-message field accepts only the verified concrete recipient
  // namespace. Copying dynamic model features or connector ids into it makes
  // ChatGPT reject an otherwise valid conversation request with HTTP 500;
  // those dynamic values remain covered by the top-level force-disable lists.
  const hiddenDisabledToolIDs = SYSTEM_DISABLED_TOOL_IDS;
  const userIndex = Array.isArray(payload.messages)
    ? payload.messages.findLastIndex((message) => message?.author?.role === "user")
    : -1;
  const userMessageID = userIndex >= 0 ? payload.messages[userIndex]?.id || null : null;
  const replacePrompt = replacementUserText !== null;
  if (replacePrompt) {
    if (typeof replacementUserText !== "string" || !replacementUserText) {
      throw new Error("native-tool firewall: replacement user prompt was empty");
    }
    if (typeof expectedComposerText !== "string" || !expectedComposerText) {
      throw new Error("native-tool firewall: expected composer marker was empty");
    }
    const content = payload.messages?.[userIndex]?.content;
    if (!content || !Array.isArray(content.parts)) {
      throw new Error("native-tool firewall: submitted user content changed shape");
    }
    const textParts = content.parts.filter((part) => typeof part === "string");
    if (textParts.length !== 1 || textParts[0] !== expectedComposerText) {
      throw new Error("native-tool firewall: submitted composer marker did not match");
    }
  }
  const messages = Array.isArray(payload.messages)
    ? [
        ...payload.messages.map((message, index) => {
          const cleared = clearToolSelections(message);
          if (!replacePrompt || index !== userIndex) return cleared;
          const parts = cleared.content.parts;
          return {
            ...cleared,
            content: {
              ...cleared.content,
              // Preserve every non-text part (notably uploaded image assets)
              // in its original order and replace only the sentinel string.
              parts: parts.map((part) =>
                typeof part === "string" ? replacementUserText : part
              ),
            },
          };
        }),
        suppressionDeveloperMessage(),
        suppressionSystemMessage(hiddenDisabledToolIDs),
      ]
    : undefined;

  const patched = {
    ...payload,
    ...(messages ? { messages } : {}),
    force_disable_features: forceDisableFeatures,
    force_disable_tool_ids: forceDisableToolIDs,
    force_use_search: false,
    consumer_lockdown_mode_disabled: false,
    local_function_names: [],
    selected_sources: [],
    context_scopes: [],
    plugin_ids: [],
  };
  if (branchParentNode) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(branchParentNode)) {
      throw new Error("native-tool firewall: recovery parent was not a UUID");
    }
    if (typeof payload.conversation_id !== "string" || !payload.conversation_id.trim()) {
      throw new Error("native-tool firewall: same-chat recovery had no conversation id");
    }
    patched.parent_message_id = branchParentNode;
  }

  // Verify the exact serialized representation that Playwright will forward.
  const serialized = JSON.stringify(patched);
  const verified = JSON.parse(serialized);
  for (const feature of forceDisableFeatures) {
    if (!verified.force_disable_features.includes(feature)) {
      throw new Error(`native-tool firewall: failed to serialize disabled feature ${feature}`);
    }
  }
  for (const toolID of forceDisableToolIDs) {
    if (!verified.force_disable_tool_ids.includes(toolID)) {
      throw new Error(`native-tool firewall: failed to serialize disabled tool ${toolID}`);
    }
  }
  if (
    verified.force_use_search !== false ||
    !Array.isArray(verified.local_function_names) ||
    verified.local_function_names.length !== 0 ||
    !Array.isArray(verified.selected_sources) ||
    verified.selected_sources.length !== 0 ||
    !Array.isArray(verified.context_scopes) ||
    verified.context_scopes.length !== 0 ||
    !Array.isArray(verified.plugin_ids) ||
    verified.plugin_ids.length !== 0
  ) {
    throw new Error("native-tool firewall: serialized suppression fields failed verification");
  }
  if (
    !verified.force_disable_features.includes("memory") ||
    !verified.force_disable_tool_ids.includes("bio")
  ) {
    throw new Error("native-tool firewall: serialized memory suppression failed verification");
  }
  if (branchParentNode && verified.parent_message_id !== branchParentNode) {
    throw new Error("native-tool firewall: failed to serialize recovery parent");
  }
  if (messages) {
    if (replacePrompt) {
      const user = verified.messages[userIndex];
      const textParts = user?.content?.parts?.filter((part) => typeof part === "string") || [];
      if (textParts.length !== 1 || textParts[0] !== replacementUserText) {
        throw new Error("native-tool firewall: serialized user prompt failed verification");
      }
      if (textParts.includes(expectedComposerText)) {
        throw new Error("native-tool firewall: composer marker escaped prompt replacement");
      }
    }
    const developer = verified.messages.at(-2);
    const hidden = verified.messages.at(-1);
    if (
      developer?.author?.role !== "developer" ||
      !developer?.content?.parts?.includes(NO_NATIVE_TOOLS_INSTRUCTION) ||
      hidden?.author?.role !== "system" ||
      hidden?.metadata?.is_visually_hidden_from_conversation !== true ||
      hidden?.metadata?.exclude_after_next_user_message !== true ||
      !hiddenDisabledToolIDs.every((toolID) => hidden.metadata.disable_tool_ids.includes(toolID))
    ) {
      throw new Error("native-tool firewall: hidden disable-tool system message failed verification");
    }
    if (!hidden.metadata.disable_tool_ids.includes("bio")) {
      throw new Error("native-tool firewall: hidden memory-tool suppression failed verification");
    }
    const selectionFields = [
      "selected_sources",
      "selected_apps",
      "selected_connectors",
      "selected_connector_ids",
      "selected_github_repos",
    ];
    for (const message of verified.messages) {
      for (const field of selectionFields) {
        const value = message?.metadata?.[field];
        if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) {
          throw new Error(
            `native-tool firewall: serialized message selection ${field} remained enabled`
          );
        }
      }
    }
  }

  return {
    serialized,
    featureCount: forceDisableFeatures.length,
    toolCount: forceDisableToolIDs.length,
    memorySuppression: "applied",
    userMessageID,
  };
}

async function readPreflight(page) {
  return page.evaluate(async ({ base, maxBytes, timeoutMs }) => {
    const fetchBoundedJson = async (path, init = {}) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(new URL(path, base).toString(), {
          credentials: "include",
          ...init,
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`${path} returned ${response.status}`);
        const length = Number(response.headers.get("content-length") || 0);
        if (length > maxBytes) throw new Error(`${path} exceeded response limit`);
        const text = await response.text();
        if (new TextEncoder().encode(text).byteLength > maxBytes) {
          throw new Error(`${path} exceeded response limit`);
        }
        return JSON.parse(text);
      } catch (error) {
        throw new Error(
          `${path} failed: ${error?.name || "Error"}: ${error?.message || error}`
        );
      } finally {
        clearTimeout(timer);
      }
    };

    const session = await fetchBoundedJson("/api/auth/session");
    if (!session?.accessToken) throw new Error("authenticated access token was unavailable");
    const authorization = { Authorization: `Bearer ${session.accessToken}` };
    const [models, links] = await Promise.all([
      fetchBoundedJson("/backend-api/models", { headers: authorization }),
      fetchBoundedJson("/backend-api/aip/connectors/links/list_accessible", {
        method: "POST",
        headers: { ...authorization, "Content-Type": "application/json" },
        body: JSON.stringify({ principals: [], link_refresh_strategy: "BLOCKING" }),
      }),
    ]);
    return { models, links };
  }, {
    base: "https://chatgpt.com",
    maxBytes: MAX_PREFLIGHT_BYTES,
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A route may reject before chatUI starts awaiting the promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

export function createNativeToolFirewall() {
  let inventory = null;
  let currentTurn = null;
  let fatal = null;
  let installed = false;

  const lock = (message, detail = {}) => {
    if (!fatal) {
      const error = message instanceof Error ? message : new Error(String(message));
      error.nativeToolSuppression = true;
      Object.assign(error, detail);
      fatal = error;
    }
    if (currentTurn && !currentTurn.settled) {
      currentTurn.settled = true;
      currentTurn.deferred.reject(fatal);
    }
    return fatal;
  };

  const handleRoute = async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const kind = classifyConversationRequest(request.url(), request.method());
    if (kind === "other") return route.continue();

    if (kind === "unknown-completion") {
      lock(`native-tool firewall blocked an unknown ChatGPT conversation endpoint (${pathname})`, {
        nativeToolSuppressionState: "blocked-drift",
      });
      return route.abort("blockedbyclient");
    }
    if (fatal) return route.abort("blockedbyclient");
    if (kind === "resume") {
      if (!currentTurn || currentTurn.actualCount !== 1) {
        lock("native-tool firewall blocked an uncorrelated ChatGPT resume request", {
          nativeToolSuppressionState: "blocked-drift",
        });
        return route.abort("blockedbyclient");
      }
      return route.continue();
    }
    if (kind === "prepare" && (!currentTurn || !inventory)) {
      try {
        const raw = request.postData();
        if (!raw) throw new Error("native-tool firewall: idle conversation prepare had no JSON body");
        validateIdlePreparePayload(JSON.parse(raw));
        // ChatGPT now issues promptless /prepare preflights while the empty
        // composer loads, before a model turn exists to arm. They carry no
        // user text and are not generation submissions. Pass only this exact
        // validated idle shape through byte-for-byte; every Send still needs
        // the armed turn ledger, suppression patch, UUID binding, and raw audit.
        await route.fallback();
        return;
      } catch (error) {
        lock(error, { nativeToolSuppressionState: "blocked-drift" });
        return route.abort("blockedbyclient");
      }
    }
    if (!currentTurn || !inventory) {
      lock(`native-tool firewall blocked an unarmed conversation request (${pathname})`, {
        nativeToolSuppressionState: "blocked-drift",
      });
      return route.abort("blockedbyclient");
    }
    if (kind === "send" && currentTurn.actualCount > 0) {
      lock("native-tool firewall blocked a duplicate ChatGPT generation request", {
        nativeToolSuppressionState: "blocked-drift",
      });
      return route.abort("blockedbyclient");
    }

    try {
      const raw = request.postData();
      if (!raw) throw new Error("native-tool firewall: conversation request had no JSON body");
      const payload = JSON.parse(raw);
      if (kind === "prepare") {
        // Prepare is a correlated, promptless composer preflight rather than a
        // model submission. ChatGPT binds uploaded image state to its exact
        // response; adding force-disable fields here makes the client discard
        // otherwise valid attachments. Validate the fixed sentinel and pass
        // the body through byte-for-byte. The subsequent Send is still fully
        // patched, UUID-anchored, and raw-audited before any reply is accepted.
        validatePreparePayload(payload, currentTurn.composerText);
        currentTurn.prepareCount += 1;
        currentTurn.meta.nativeToolPrepare = "correlated-pass-through";
        await route.fallback();
        return;
      }
      const patched = patchConversationPayload(payload, inventory, {
        allowNoMessages: false,
        branchParentNode: kind === "send" ? currentTurn.branchParentNode : null,
        expectedComposerText: kind === "send" ? currentTurn.composerText : null,
        replacementUserText: kind === "send" ? currentTurn.userText : null,
      });
      if (kind === "send") {
        if (typeof patched.userMessageID !== "string" || !patched.userMessageID.trim()) {
          throw new Error("native-tool firewall: submitted user message id was unavailable");
        }
        currentTurn.actualCount += 1;
        currentTurn.userMessageID = patched.userMessageID;
        currentTurn.meta.nativeToolSuppression = "applied";
        currentTurn.meta.disabledFeatureCount = patched.featureCount;
        currentTurn.meta.disabledToolCount = patched.toolCount;
        currentTurn.meta.memorySuppression = patched.memorySuppression;
        if (currentTurn.branchParentNode) {
          currentTurn.meta.recoveryParentVerified = true;
        }
        await route.continue({ postData: patched.serialized });
        if (!currentTurn.settled) {
          currentTurn.settled = true;
          currentTurn.deferred.resolve({
            status: "sent",
            userMessageID: currentTurn.userMessageID,
          });
        }
        return;
      }
      await route.continue({ postData: patched.serialized });
      return;
    } catch (error) {
      lock(error, { nativeToolSuppressionState: "blocked-drift" });
      return route.abort("blockedbyclient");
    }
  };

  return {
    async install(context) {
      if (installed) return;
      await context.route("**/*", handleRoute);
      installed = true;
    },

    async preflight(page, meta = {}) {
      if (fatal) throw fatal;
      let raw;
      try {
        raw = await readPreflight(page);
      } catch (error) {
        throw lock(`native-tool firewall preflight failed: ${error.message}`, {
          nativeToolSuppressionState: "blocked-preflight",
        });
      }
      const features = collectModelToolFeatures(raw.models);
      const links = analyzeAccessibleLinks(raw.links);
      if (links.external.length) {
        throw lock(`native-tool firewall blocked active external ChatGPT app links (${links.external.join(", ")})`, {
          nativeToolSuppressionState: "blocked-app-links",
        });
      }
      inventory = {
        features: uniqueStrings([...BASELINE_DISABLED_FEATURES, ...features]),
        toolIDs: uniqueStrings([...BASELINE_DISABLED_TOOL_IDS, ...links.toolIDs]),
      };
      meta.nativeToolSuppression = "armed";
      meta.disabledFeatureCount = inventory.features.length;
      meta.disabledToolCount = inventory.toolIDs.length;
      meta.appPreflight = `implicit-first-party-only:${links.linkCount}`;
      return { ...inventory, linkCount: links.linkCount };
    },

    beginTurn(
      meta = {},
      { branchParentNode = null, composerText = COMPOSER_SENTINEL, userText = null } = {}
    ) {
      if (fatal) throw fatal;
      if (!installed || !inventory) {
        throw lock("native-tool firewall was not installed and preflighted", {
          nativeToolSuppressionState: "blocked-preflight",
        });
      }
      if (currentTurn) {
        throw lock("native-tool firewall detected overlapping ChatGPT turns", {
          nativeToolSuppressionState: "blocked-drift",
        });
      }
      if (typeof userText !== "string" || !userText) {
        throw lock("native-tool firewall was armed without an outbound user prompt", {
          nativeToolSuppressionState: "blocked-drift",
        });
      }
      currentTurn = {
        deferred: deferred(),
        settled: false,
        actualCount: 0,
        prepareCount: 0,
        userMessageID: null,
        branchParentNode,
        composerText,
        userText,
        meta,
      };
      return currentTurn;
    },

    async waitForSend(turn, timeoutMs = 10_000) {
      if (fatal) throw fatal;
      if (!turn || turn !== currentTurn) {
        throw new Error("native-tool firewall: invalid turn acknowledgement");
      }
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
      });
      try {
        return await Promise.race([turn.deferred.promise, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },

    finishTurn(turn) {
      if (turn && turn === currentTurn) currentTurn = null;
    },

    lockViolation(names = [], chatUrl = null, reason = "native tool activity was detected") {
      return lock(`native-tool firewall locked after ${reason}${names.length ? ` (${names.join(", ")})` : ""}`, {
        nativeToolSuppressionState: "postcheck-violation",
        nativeToolNames: names,
        chatUrl,
        nativeToolSideEffectsPossible: true,
      });
    },

    getFatalError() {
      return fatal;
    },
  };
}

export { MAX_PREFLIGHT_BYTES, PREFLIGHT_TIMEOUT_MS };
