// backends/playwright-backend.js
// The ROBUST backend: drives the ChatGPT web UI like a human — type a message
// into the compose box, press Enter, then wait for the response to fully
// finish. Slower (~10-20s) but resilient to ChatGPT backend changes, because it
// runs the REAL client JS (which legitimately produces the anti-bot sentinel
// tokens the direct-API backend can't).
//
// Uses the same selectors proven in this session (#prompt-textarea ProseMirror
// box + [data-message-author-role="assistant"] scraping).
//
// Conversation reuse: pass opts.chatUrl (a https://chatgpt.com/c/<id> URL) to
// send the message INTO that existing conversation instead of opening a fresh
// chat. When the shared page is already on that conversation, no navigation
// happens at all. The final conversation URL is reported via opts.meta.chatUrl
// so the server can route follow-up turns back into the same chat.

import {
  withSharedSessionScope,
  detectAuthExpired,
  throwSessionExpired,
  refreshSessionFile,
} from "../session.js";
import { createGuardedEmitter } from "../stream-guard.js";
import {
  isRateLimitReply,
  isConversationTooLong,
  parseRateLimitBackoffMs,
  rateLimitResponseInfo,
} from "../request-helpers.js";
import {
  isDiscoveryOnlyNativeActivity,
  readRawConversationAuditRaced,
  readRawConversationCursor,
  readRawLatestAssistantTurnRaced,
} from "../raw-conversation.js";
import {
  COMPOSER_SENTINEL,
  classifyConversationRequest,
} from "../native-tool-firewall.js";
import { attachRejectedReply } from "../rejected-reply.js";

function envFlag(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const STRICT_MODEL_SELECTION = envFlag(process.env.STRICT_MODEL_SELECTION);

// Soft deadline for a reply. GPT-5.6 Sol + High thinking routinely exceeds the
// old 150s cap on large OpenCode prompts; we keep waiting while ChatGPT is
// still generating/thinking, up to REPLY_HARD_CAP_MS.
const REPLY_TIMEOUT_MS = Number(process.env.REPLY_TIMEOUT_MS || 600_000); // 10 min soft
const REPLY_HARD_CAP_MS = Number(process.env.REPLY_HARD_CAP_MS || 900_000); // 15 min absolute
// If generation has stopped but no usable text appears, fail instead of sitting
// until the hard cap (this is what made OpenCode look "stuck on loading").
const REPLY_IDLE_GRACE_MS = Number(process.env.REPLY_IDLE_GRACE_MS || 30_000);
// While stop-button/thinking-shimmer is live, require SOME progress (text growth,
// thinking-label change, or generating flip) within this window or abort.
const REPLY_STALL_MS = Number(process.env.REPLY_STALL_MS || 480_000); // 8 min
const DOM_READ_TIMEOUT_MS = Number(process.env.DOM_READ_TIMEOUT_MS || 8_000);
const IMAGE_UPLOAD_TIMEOUT_MS = Number(process.env.IMAGE_UPLOAD_TIMEOUT_MS || 60_000);
const RESPONSE_ERROR_MAX_BYTES = Number(
  process.env.RESPONSE_ERROR_MAX_BYTES || 64 * 1024
);
const POLL_MS = 400;
const STABLE_DONE_MS = 1200; // reply counts as done once generation ends AND text is stable
const TURN_LOAD_TIMEOUT_MS = 15_000; // wait for persisted-chat turns to hydrate
// Don't live-stream rate-limit / length-cap banners (the server rejects those
// after the fact; streaming them first would flash the banner into OpenCode).
const DEBUG = String(process.env.DEBUG ?? "").trim() === "1";
const dbg = (...a) => DEBUG && process.stderr.write("[pw-dbg] " + a.join(" ") + "\n");

// ChatGPT composer "Intelligence" picker (effort + model family).
// Defaults: GPT-5.6 Sol with thinking effort High. Empty CHAT_MODEL skips
// model selection; empty CHAT_EFFORT skips effort selection.
const CHAT_MODEL = String(process.env.CHAT_MODEL ?? "GPT-5.6 Sol").trim();
const CHAT_EFFORT = String(process.env.CHAT_EFFORT ?? "High").trim();
const EFFORT_LABELS = /^(High|Medium|Instant(?:\s*5\.5)?|Low|Extra\s*high)$/i;

// Placeholder texts the UI shows BEFORE the real answer exists. These should
// never be returned as a reply. Matches "Thinking", "Thinking…", "Reasoning", etc.
const PLACEHOLDER = /^(thinking|reasoning)(\.{0,3}|…)$/i;

/**
 * Wait until a persisted conversation has hydrated at least one turn into the
 * DOM. ChatGPT often paints the composer first and fills messages a beat later;
 * reading prev.count=0 too early makes new-turn detection treat old replies as
 * "new" (or miss them entirely).
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<number>} turn count observed (0 if still empty)
 */
async function waitForConversationTurns(page, timeoutMs = TURN_LOAD_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const n = await page
      .locator('[data-message-author-role], [data-testid^="conversation-turn"]')
      .count()
      .catch(() => 0);
    if (n > 0) return n;
    await page.waitForTimeout(400);
  }
  return 0;
}

async function waitForConversationUrl(page, fallback = null, timeoutMs = 30_000, signal = null) {
  const fallbackUrl = /\/c\//.test(String(fallback || ""))
    ? String(fallback).split(/[?#]/)[0]
    : null;
  if (fallbackUrl) return fallbackUrl;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    checkAbort(signal);
    const current = page.url().split(/[?#]/)[0];
    if (/\/c\//.test(current)) return current;
    await page.waitForTimeout(200).catch(() => {});
  }
  return null;
}

/**
 * True only while ChatGPT is still working. "Thought for …" is a finished
 * recap — it must NOT keep the soft deadline open (that bug made OpenCode sit
 * on a spinner until REPLY_HARD_CAP_MS after thinking completed with no text).
 */
export function isActivelyBusy(s, text) {
  if (s?.isGenerating) return true;
  const label = String(s?.thinking || "").trim();
  if (PLACEHOLDER.test(label)) return true;
  if (PLACEHOLDER.test(String(text || s?.text || "").trim())) return true;
  return false;
}

/**
 * Soft deadline: keep waiting past REPLY_TIMEOUT_MS while ChatGPT is still
 * generating or showing a thinking placeholder. Absolute stop at HARD_CAP.
 */
export function pastDeadline(start, s, text, now = Date.now()) {
  const elapsed = now - start;
  if (elapsed < REPLY_TIMEOUT_MS) return false;
  if (elapsed >= REPLY_HARD_CAP_MS) return true;
  return !isActivelyBusy(s, text);
}

export async function boundedDomRead(
  operation,
  label = "ChatGPT DOM read",
  timeoutMs = DOM_READ_TIMEOUT_MS
) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`${label} timed out after ${timeoutMs}ms`);
          err.domReadTimeout = true;
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function verifiedBranchParentForUnavailableAudit({
  branchParentNode = null,
  expectedRawNode = null,
  pendingTurnKnown = false,
} = {}) {
  if (branchParentNode) return branchParentNode;
  if (!pendingTurnKnown && expectedRawNode) return expectedRawNode;
  return null;
}

function throwCancelled(signal) {
  const reason = signal?.reason;
  const err = new Error(
    typeof reason === "string" && reason
      ? `Request cancelled (${reason})`
      : "Request cancelled"
  );
  err.cancelled = true;
  throw err;
}

function checkAbort(signal) {
  if (signal?.aborted) throwCancelled(signal);
}

function rateLimitError(info) {
  const err = new Error(info?.message || "ChatGPT rate limit reached");
  err.rateLimited = true;
  err.backoffMs = Number(info?.backoffMs) || 0;
  err.rateLimitSource = info?.source || "unknown";
  err.chatgptResponseStatus = Number(info?.status) || null;
  return err;
}

function renderedFailureError(text) {
  const message = String(text || "").replace(/\s+/g, " ").trim();
  if (!message) return null;
  if (isRateLimitReply(message)) {
    return rateLimitError({
      message,
      backoffMs: parseRateLimitBackoffMs(message),
      source: "rendered-error",
    });
  }
  if (
    !/(something (?:seems to have )?gone wrong|unable to generate|failed to (?:generate|send)|network error|temporarily unavailable)/i.test(
      message
    )
  ) {
    return null;
  }
  const err = new Error(`ChatGPT rejected the submitted turn: ${message.slice(0, 240)}`);
  err.chatgptResponseError = true;
  err.retryableChatGPT = true;
  return err;
}

async function conversationResponseFailure(response) {
  const status = response.status();
  if (status < 400) return null;
  const headers = response.headers();
  const immediate = rateLimitResponseInfo({ status, headers, body: "" });
  if (immediate) return rateLimitError(immediate);
  const length = Number(headers["content-length"] || 0);
  const body =
    length > RESPONSE_ERROR_MAX_BYTES
      ? ""
      : await response.text().catch(() => "");
  const info = rateLimitResponseInfo({ status, headers, body });
  if (info) return rateLimitError(info);
  const err = new Error(`ChatGPT conversation request failed with HTTP ${status}`);
  err.chatgptResponseError = true;
  err.retryableChatGPT = status === 408 || status === 409 || status >= 500;
  err.chatgptResponseStatus = status;
  return err;
}

function monitorConversationResponses(page) {
  let failure = null;
  let resolveFailure;
  const firstFailure = new Promise((resolve) => {
    resolveFailure = resolve;
  });
  const pending = new Set();
  const onResponse = (response) => {
    if (
      classifyConversationRequest(
        response.url(),
        response.request().method()
      ) !== "send"
    ) {
      return;
    }
    const task = conversationResponseFailure(response)
      .then((error) => {
        if (!error || failure) return;
        failure = error;
        resolveFailure(error);
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  page.on("response", onResponse);
  return {
    async wait(ms) {
      if (failure) throw failure;
      const error = await Promise.race([
        page.waitForTimeout(ms).then(() => null),
        firstFailure,
      ]);
      if (error) throw error;
    },
    throwIfFailed() {
      if (failure) throw failure;
    },
    close() {
      page.off("response", onResponse);
    },
  };
}

const IMAGE_INPUT_SELECTOR = '[data-testid="upload-photos-input"]';
const IMAGE_INPUT_FALLBACK = 'input[type="file"][accept*="image" i]';
const IMAGE_EXTENSIONS = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function imageFilePayloads(images = []) {
  return images.map((image, index) => {
    const mediaType = String(image?.mediaType || "").toLowerCase();
    const extension = IMAGE_EXTENSIONS[mediaType];
    if (!extension) throw new Error(`playwright-backend: unsupported image type ${mediaType || "unknown"}`);
    const buffer = Buffer.from(String(image?.data || ""), "base64");
    if (!buffer.length) throw new Error("playwright-backend: image file is empty or corrupted");
    const raw = String(image?.filename || `image-${index + 1}`).split(/[\\/]/).pop() || `image-${index + 1}`;
    const name = /\.[a-z0-9]{1,8}$/i.test(raw) ? raw : raw + extension;
    return { name, mimeType: mediaType, buffer };
  });
}

export function fillComposerText(editor, text, timeoutMs = 30_000) {
  const timeout = Math.max(1, Number(timeoutMs) || 30_000);
  return boundedDomRead(
    editor.fill(text, { timeout }),
    "ChatGPT composer fill",
    timeout
  );
}

async function clearComposerDraft(page) {
  const editor = page.locator("#prompt-textarea");
  if (await editor.count()) {
    await fillComposerText(editor, "", 10_000).catch(() => {});
  }

  for (let i = 0; i < 32; i++) {
    const remove = page.locator(
      'button[aria-label*="Remove file" i], button[aria-label*="Remove attachment" i], button[aria-label*="Remove image" i]'
    ).first();
    if (!(await remove.count())) break;
    await remove.click({ timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(100);
  }

  const inputs = page.locator(`${IMAGE_INPUT_SELECTOR}, ${IMAGE_INPUT_FALLBACK}`);
  for (let i = 0; i < (await inputs.count()); i++) {
    await inputs.nth(i).setInputFiles([], { timeout: 5_000 }).catch(() => {});
  }
}

async function uploadImages(page, images, signal) {
  if (!images?.length) return 0;
  const payloads = imageFilePayloads(images);
  const activeForm = page.locator('form[data-type="unified-composer"]').filter({ visible: true }).last();
  const formExact = activeForm.locator(IMAGE_INPUT_SELECTOR).last();
  const formFallback = activeForm.locator(IMAGE_INPUT_FALLBACK).last();
  const globalExact = page.locator(IMAGE_INPUT_SELECTOR).last();
  const globalFallback = page.locator(IMAGE_INPUT_FALLBACK).last();
  const formExactCount = await formExact.count();
  const formFallbackCount = await formFallback.count();
  const globalExactCount = await globalExact.count();
  const input = formExactCount
    ? formExact
    : formFallbackCount
      ? formFallback
      : globalExactCount
        ? globalExact
        : globalFallback;
  if (!(await input.count())) {
    throw new Error("playwright-backend: ChatGPT image upload input not found");
  }
  dbg(
    `image upload start files=${payloads.length} input=${formExactCount ? "form-exact" : formFallbackCount ? "form-fallback" : globalExactCount ? "global-exact" : "global-fallback"}`
  );

  checkAbort(signal);
  await input.setInputFiles(payloads);
  const started = Date.now();
  let lastState = null;
  let lastStateKey = "";
  while (Date.now() - started < IMAGE_UPLOAD_TIMEOUT_MS) {
    checkAbort(signal);
    const state = await page.evaluate((expected) => {
      const editors = [...document.querySelectorAll("#prompt-textarea")];
      const editor = editors.find((item) => item.getClientRects().length > 0) || editors.at(-1);
      const forms = [...document.querySelectorAll('form[data-type="unified-composer"]')];
      const form = editor?.closest('form[data-type="unified-composer"]') ||
        forms.find((item) => item.getClientRects().length > 0) || forms.at(-1);
      if (!form) return { ready: false, error: "" };
      const text = (form.innerText || "").trim();
      const alerts = [...document.querySelectorAll('[role="alert"]')]
        .map((item) => (item.innerText || "").trim())
        .filter(Boolean)
        .join("\n");
      const error = `${text}\n${alerts}`.match(
        /(?:upload failed|failed to upload|unable to upload|unsupported (?:file|image)|couldn'?t upload)[^\n]*/i
      )?.[0] || "";
      const removalSelector =
        'button[aria-label*="Remove file" i], button[aria-label*="Remove attachment" i], button[aria-label*="Remove image" i]';
      const formPreviews = form.querySelectorAll(`img, ${removalSelector}`).length;
      const globalRemovals = document.querySelectorAll(removalSelector).length;
      const previews = Math.max(
        formPreviews,
        globalRemovals,
      );
      const selectedFiles = [...document.querySelectorAll('input[type="file"]')]
        .reduce((count, item) => count + (item.files?.length || 0), 0);
      const uploading = !!document.querySelector('[role="progressbar"], [data-testid*="uploading" i]') || /\buploading\b/i.test(text);
      const send = form.querySelector(
        '[data-testid="send-button"], [data-testid="composer-send-button"], button[aria-label*="Send message" i], button[aria-label*="Send" i]'
      );
      const sendEnabled = !!send && !send.hasAttribute("disabled") && send.getAttribute("aria-disabled") !== "true";
      return {
        // ChatGPT may collapse several files into one gallery preview. The
        // input's selected file count proves the exact payload set while the
        // enabled Send button and lack of an upload indicator prove readiness.
        ready: (previews > 0 || selectedFiles >= expected) && !uploading && sendEnabled,
        error,
        previews,
        formPreviews,
        globalRemovals,
        selectedFiles,
        uploading,
        sendEnabled,
      };
    }, payloads.length);
    lastState = state;
    const stateKey = `${state.previews}:${state.formPreviews}:${state.globalRemovals}:${state.selectedFiles}:${state.uploading}:${state.sendEnabled}`;
    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      dbg(
        `image upload state previews=${state.previews} form=${state.formPreviews} removals=${state.globalRemovals} selected=${state.selectedFiles} uploading=${state.uploading} send=${state.sendEnabled}`
      );
    }
    if (state.error) throw new Error(`playwright-backend: ${state.error}`);
    if (state.ready) return payloads.length;
    await page.waitForTimeout(250);
  }
  throw new Error(
    `playwright-backend: image upload did not become ready (${payloads.length} image(s); previews=${lastState?.previews ?? 0}; selected=${lastState?.selectedFiles ?? 0}; uploading=${lastState?.uploading ?? false}; send=${lastState?.sendEnabled ?? false})`
  );
}

/** Best-effort: stop ChatGPT generation when the client cancels. */
async function clickStopGenerating(page) {
  try {
    await page
      .locator(
        '[data-testid="composer-stop-btn"], button[aria-label*="Stop generating" i], button[aria-label*="Stop" i]'
      )
      .first()
      .click({ timeout: 1500 });
  } catch {
    /* already stopped or gone */
  }
}

/**
 * Open the composer intelligence picker (the button that shows High/Medium/…).
 * @param {import('playwright').Page} page
 */
async function openIntelligencePicker(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(200);

  // Prefer the composer-area effort button (near the send controls).
  const candidates = page.locator("button[aria-haspopup='menu']");
  const n = await candidates.count();
  let target = null;
  for (let i = 0; i < n; i++) {
    const btn = candidates.nth(i);
    const text = ((await btn.innerText().catch(() => "")) || "").trim();
    const box = await btn.boundingBox().catch(() => null);
    if (!box || box.width < 30) continue;
    // Composer sits mid-page; sidebar history options are left-aligned.
    if (box.x < 300) continue;
    if (EFFORT_LABELS.test(text) || /Sol|GPT-5/i.test(text)) {
      target = btn;
      break;
    }
  }
  if (!target) {
    // Fallback: any effort-looking menu button.
    target = page
      .locator("button[aria-haspopup='menu']")
      .filter({ hasText: EFFORT_LABELS })
      .first();
  }
  if (!(await target.count())) {
    throw new Error("playwright-backend: intelligence picker button not found");
  }
  await target.click({ timeout: 5000 });
  await page.waitForSelector(
    '[data-testid="composer-intelligence-picker-content"], [role="menuitemradio"]',
    { timeout: 5000 }
  );
  await page.waitForTimeout(300);
}

export function pickerSubmenuMatches(text, label, value) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return (
    lines[0]?.toLowerCase() === String(label || "").trim().toLowerCase() &&
    lines.slice(1).join(" ").toLowerCase() ===
      String(value || "").replace(/\s+/g, " ").trim().toLowerCase()
  );
}

export async function activatePickerItem(item) {
  await item.waitFor({ state: "visible", timeout: 5_000 });
  try {
    await item.click({ timeout: 1_500 });
    return "pointer";
  } catch {
    // ChatGPT's current nested picker can render behind thread-bottom-container.
    // The exact visible menu item is still live, so dispatch its DOM click.
    await item.evaluate((element) => element.click());
    return "dom";
  }
}

/**
 * Ensure the ChatGPT composer is set to CHAT_MODEL + CHAT_EFFORT.
 * Idempotent: skips clicks when already selected. Best-effort — logs and
 * continues if the picker UI drifts (so a send still happens).
 *
 * @param {import('playwright').Page} page
 * @param {{model?: string, effort?: string}} [override]
 * @returns {Promise<{model: string, effort: string, ok: boolean}>}
 */
async function ensureIntelligenceSelection(page, override = {}) {
  const model = String(override.model ?? CHAT_MODEL).trim();
  const effort = String(override.effort ?? CHAT_EFFORT).trim();
  if (!model && !effort) {
    return { model, effort, ok: true, selection_verified: true };
  }

  let effortOk = !effort;
  let modelOk = !model;

  try {
    await openIntelligencePicker(page);

    // 1) Effort (Instant / Medium / High). Older clients expose direct
    // menuitemradios; current clients place them under an Effort submenu.
    if (effort) {
      const effortRe = new RegExp(
        `^${effort.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*5\\.5)?$`,
        "i"
      );
      let effortItem = page
        .locator('[role="menuitemradio"]:visible')
        .filter({ hasText: effortRe })
        .first();
      if (await effortItem.count()) {
        const checked = await effortItem.getAttribute("aria-checked");
        if (checked !== "true") {
          await activatePickerItem(effortItem);
          dbg(`selected effort: ${effort}`);
          await page.waitForTimeout(400);
          await openIntelligencePicker(page);
        } else {
          dbg(`effort already ${effort}`);
        }
        effortOk = true;
      } else {
        const effortSubmenu = page
          .locator('[role="menuitem"][aria-haspopup="menu"]:visible')
          .filter({ hasText: /^Effort/i })
          .first();
        if (await effortSubmenu.count()) {
          const current = await effortSubmenu.innerText().catch(() => "");
          if (pickerSubmenuMatches(current, "Effort", effort)) {
            dbg(`effort already ${effort}`);
            effortOk = true;
          } else {
            const activation = await activatePickerItem(effortSubmenu);
            if (activation === "dom") {
              dbg("opened nested effort picker through DOM activation");
            }
            await page.waitForTimeout(300);
            effortItem = page
              .locator('[role="menuitemradio"]:visible')
              .filter({ hasText: effortRe })
              .first();
            if (await effortItem.count()) {
              await activatePickerItem(effortItem);
              dbg(`selected effort: ${effort}`);
              effortOk = true;
              await page.waitForTimeout(400);
            } else {
              dbg(`effort option not found: ${effort}`);
            }
            await openIntelligencePicker(page);
          }
        } else {
          dbg(`effort option not found: ${effort}`);
        }
      }
    }

    // 2) Model family submenu (e.g. "GPT-5.6 Sol" menuitem → radio list).
    if (model) {
      const modelRe = new RegExp(
        model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      // Prefer an exact radio if already visible; else open the submenu.
      let modelRadio = page
        .locator('[role="menuitemradio"]:visible')
        .filter({ hasText: modelRe })
        .first();
      if (!(await modelRadio.count())) {
        const labelledSubmenu = page
          .locator('[role="menuitem"][aria-haspopup="menu"]:visible')
          .filter({ hasText: /^Model/i })
          .first();
        const submenu = page
          .locator('[role="menuitem"][aria-haspopup="menu"]:visible')
          .filter({ hasText: modelRe })
          .first();
        // Also match a parent like "GPT-5.6 Sol" when model is that string.
        const submenuAlt = page
          .locator('[role="menuitem"][aria-haspopup="menu"]:visible')
          .filter({ hasText: /GPT-5\.6\s*Sol|Sol/i })
          .first();
        const opener = (await labelledSubmenu.count())
          ? labelledSubmenu
          : (await submenu.count())
            ? submenu
            : submenuAlt;
        if (await opener.count()) {
          const current = await opener.innerText().catch(() => "");
          if (
            (await labelledSubmenu.count()) &&
            pickerSubmenuMatches(current, "Model", model)
          ) {
            modelOk = true;
            dbg(`model already ${model}`);
          } else {
            const activation = await activatePickerItem(opener);
            if (activation === "dom") {
              dbg("opened nested model picker through DOM activation");
            }
            await page.waitForTimeout(500);
            modelRadio = page
              .locator('[role="menuitemradio"]:visible')
              .filter({ hasText: modelRe })
              .first();
          }
        }
      }
      if (!modelOk && (await modelRadio.count())) {
        const checked = await modelRadio.getAttribute("aria-checked");
        if (checked !== "true") {
          await activatePickerItem(modelRadio);
          dbg(`selected model: ${model}`);
          await page.waitForTimeout(400);
        } else {
          dbg(`model already ${model}`);
          await page.keyboard.press("Escape").catch(() => {});
        }
        modelOk = true;
      } else {
        if (!modelOk) dbg(`model option not found: ${model}`);
        await page.keyboard.press("Escape").catch(() => {});
      }
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }

    await page.waitForTimeout(200);
    const ok = effortOk && modelOk;
    if (STRICT_MODEL_SELECTION && !ok) {
      const err = new Error(
        `STRICT_MODEL_SELECTION: could not verify ChatGPT picker (model=${model || "-"} effort=${effort || "-"})`
      );
      err.modelSelectionFailed = true;
      throw err;
    }
    return {
      model: ok ? model : "",
      effort: ok ? effort : "",
      requestedModel: model,
      requestedEffort: effort,
      ok,
      selection_verified: ok,
    };
  } catch (err) {
    if (err.modelSelectionFailed) throw err;
    dbg(`ensureIntelligenceSelection failed (${err.message}); continuing with current picker state`);
    await page.keyboard.press("Escape").catch(() => {});
    if (STRICT_MODEL_SELECTION) {
      const e = new Error(
        `STRICT_MODEL_SELECTION: picker error — ${err.message}`
      );
      e.modelSelectionFailed = true;
      throw e;
    }
    return {
      model: "",
      effort: "",
      requestedModel: model,
      requestedEffort: effort,
      ok: false,
      selection_verified: false,
    };
  }
}

export { CHAT_MODEL, CHAT_EFFORT, ensureIntelligenceSelection };

function safeToStream(text) {
  if (!text) return false;
  if (isRateLimitReply(text) || isConversationTooLong(text)) return false;
  return true;
}

// Scraps that aren't a real answer — the fallback scrape must reject these so it
// doesn't return composer labels or footer text as the "reply".
const BOILERPLATE = /^(high|low|medium|chatgpt can make mistakes[^.]*)\.?$/i;
function isBoilerplate(t) {
  const s = String(t || "").trim();
  if (!s) return true;
  return BOILERPLATE.test(s);
}

/** Conversation identity = URL pathname (ignore query/hash). */
function pathOf(u) {
  try {
    return new URL(u).pathname.replace(/\/+$/, "");
  } catch {
    return String(u || "");
  }
}

/**
 * Snapshot the NEW assistant reply + generation state.
 *
 * How the answer is located: each turn's rendered answer lives inside a
 * `.markdown` element that is a descendant of its
 * `[data-message-author-role="assistant"]` node. We take the LAST such markdown
 * block in the page as the current reply. This is precise (it excludes the
 * composer's "High" effort label, suggestion chips, and footer boilerplate that
 * polluted a whole-`main` read) and robust to the thinking model's late render.
 *
 * Done = the composer has no "stop generating" button (it flips back to "send"
 * when the model finishes).
 *
 * NEW-turn detection: `prev` records the assistant turns that existed BEFORE
 * this request was sent. In a reused conversation prior replies are real DOM
 * nodes, so we anchor on the last pre-send turn's data-message-id and only
 * read turns AFTER it; if the id is missing/unloaded we fall back to the
 * pre-send count. The loose "any last markdown" fallback is only allowed in a
 * brand-new chat (prev.count === 0), where there is nothing stale to misread.
 *
 * @param {import('playwright').Page} page
 * @param {{count: number, lastId: string|null, userCount?: number}} prev
 */
async function snapshot(page, prev) {
  return boundedDomRead(
    page.evaluate(({ before, beforeLastId, beforeUserCount }) => {
    const stopBtn = document.querySelector(
      '[data-testid="composer-stop-btn"], button[aria-label*="Stop generating" i], button[aria-label*="Stop" i]'
    );

    // Prefer structured assistant turns; fall back to any role=assistant node.
    const turns = document.querySelectorAll(
      '[data-message-author-role="assistant"], [data-testid^="conversation-turn"][data-message-author-role="assistant"]'
    );
    const userTurns = document.querySelectorAll('[data-message-author-role="user"]');
    const currentUser =
      userTurns.length > beforeUserCount ? userTurns[userTurns.length - 1] : null;

    // Index where NEW (post-send) turns start.
    let startIdx = before;
    if (beforeLastId) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].getAttribute("data-message-id") === beforeLastId) {
          startIdx = i + 1;
          break;
        }
      }
    }

    let text = "";
    let thinking = "";
    let turnEl = null;
    for (let i = turns.length - 1; i >= startIdx; i--) {
      const turn = turns[i];
      turnEl = turn;
      const md =
        turn.querySelector(".markdown") ||
        turn.querySelector('[class*="markdown"]') ||
        turn.querySelector(".prose") ||
        turn;
      const t = (md.innerText || md.textContent || "").trim();
      if (t) {
        text = t;
        break;
      }
    }

    // If turn count didn't grow but a markdown block did, still try last
    // markdown — ONLY safe in a fresh chat, where no stale reply can exist.
    if (!text && before === 0) {
      const markdowns = document.querySelectorAll(
        '[data-message-author-role="assistant"] .markdown, [data-message-author-role="assistant"] [class*="markdown"]'
      );
      for (let i = markdowns.length - 1; i >= 0; i--) {
        const t = (markdowns[i].innerText || "").trim();
        if (t) {
          text = t;
          break;
        }
      }
    }

    // Thinking status: ChatGPT web hides the raw chain-of-thought; the UI only
    // shows a shimmer ("Thinking") and later a recap button ("Thought for …").
    // Surface that so OpenCode can render a live reasoning block.
    const scope = turnEl || document;
    const btnInScope = [...scope.querySelectorAll("button")].find((b) =>
      /Thought for|Thinking/i.test((b.innerText || "") + (b.getAttribute("aria-label") || ""))
    );
    // Recap button is often a sibling/ancestor control, not inside the turn node.
    const btnGlobal = [...document.querySelectorAll("button")].find((b) =>
      /Thought for/i.test((b.innerText || "") + (b.getAttribute("aria-label") || ""))
    );
    const btn = btnInScope || btnGlobal;
    if (btn) {
      thinking = (btn.innerText || btn.getAttribute("aria-label") || "").trim();
    } else if (/^(thinking|reasoning)(\.{0,3}|…)?$/i.test(text)) {
      thinking = text;
      text = ""; // don't treat the shimmer as the answer
    } else {
      const shimmer = [...(turnEl ? turnEl.querySelectorAll("div,span") : [])].find((el) =>
        /^(thinking|reasoning)(\.{0,3}|…)?$/i.test((el.innerText || "").trim())
      );
      if (shimmer) thinking = (shimmer.innerText || "").trim();
    }

    const visibleText = (element) => {
      if (!element) return "";
      const style = getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        element.getClientRects().length === 0
      ) {
        return "";
      }
      return (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
    };
    const candidates = [
      ...document.querySelectorAll(
        '[role="alert"], [data-testid*="error" i], [class*="error" i]'
      ),
    ];
    const retry = [...document.querySelectorAll("button")].findLast((button) =>
      /^(retry|try again|regenerate)$/i.test(visibleText(button))
    );
    if (retry) {
      candidates.push(
        retry.closest(
          '[data-message-author-role], [data-testid^="conversation-turn"], article, section'
        ) || retry.parentElement
      );
    }
    const afterCurrentUser = (element) =>
      !!currentUser &&
      !!(
        currentUser.compareDocumentPosition(element) &
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    const errorText =
      candidates
        .filter(afterCurrentUser)
        .map(visibleText)
        .filter(
          (value) =>
            value &&
            value.length < 1_000 &&
            /(rate.?limit|usage limit|too many requests|try again|something (?:seems to have )?gone wrong|unable to generate|failed to (?:generate|send)|temporarily unavailable)/i.test(
              value
            )
        )
        .sort((a, b) => a.length - b.length)[0] || "";

    return {
      text,
      thinking,
      errorText,
      isGenerating: !!stopBtn,
      turnCount: turns.length,
      turnId: turnEl?.getAttribute("data-message-id") || null,
    };
    }, {
      before: prev.count,
      beforeLastId: prev.lastId,
      beforeUserCount: prev.userCount || 0,
    }),
    "ChatGPT reply snapshot"
  );
}

/**
 * Fallback reply extractor for the case where the .markdown node stays empty
 * (the thinking model occasionally renders the answer in a sibling layer).
 * Reads the whole conversation thread text and returns whatever comes after the
 * thinking banner, stripped of composer/footer boilerplate. Returns "" if
 * nothing usable. Only valid in a FRESH chat — in a reused conversation it
 * would return the whole prior transcript.
 */
async function scrapeMainReply(page) {
  return boundedDomRead(page.evaluate(() => {
    const main = document.querySelector("main") || document.body;
    let text = (main.innerText || "").trim();
    if (!text) return "";

    // Drop the "Thought for N seconds" banner (and anything before/including it).
    const thought = text.match(/Thought for [^\n]*\n/i);
    if (thought) text = text.slice(thought.index + thought[0].length).trim();

    // Strip trailing UI boilerplate.
    const trailers = [
      "ChatGPT can make mistakes. Check important info.",
      "ChatGPT can make mistakes.",
    ];
    for (const t of trailers) {
      const ti = text.lastIndexOf(t);
      if (ti >= 0) text = text.slice(0, ti).trim();
    }
    // Drop a trailing "High" effort label if present.
    text = text.replace(/\n+High\s*$/i, "").trim();
    return text;
  }), "ChatGPT main-reply scrape");
}

function cleanReply(text) {
  let t = String(text || "").trim();
  // Strip leading "Thought for …" / "Thinking …" banners if they leaked in.
  t = t.replace(/^(Thought for[^\n]*\n)+/i, "").trim();
  t = t.replace(/^(Thinking(\.{0,3}|…)\n)+/i, "").trim();
  t = t.replace(/\n+ChatGPT can make mistakes[^\n]*$/i, "").trim();
  t = t.replace(/\n+High\s*$/i, "").trim();
  return t;
}

/**
 * Emit ChatGPT's thinking status into OpenCode's reasoning channel.
 * Reasoning deltas are append-only, so we grow a status line with dots and
 * append the final "Thought for …" recap when it appears. Full CoT text is
 * not available from the ChatGPT web UI stream.
 */
function createThinkingEmitter(onThinking) {
  if (typeof onThinking !== "function") return null;
  let started = false;
  let lastRecap = "";
  let lastDotAt = 0;
  let finished = false;
  const emit = (s) => {
    if (!s) return;
    try {
      onThinking(s);
    } catch {
      /* client gone */
    }
  };
  return {
    observe(thinkingLabel, isGenerating) {
      if (finished) return;
      const label = String(thinkingLabel || "").trim();
      const recap = /Thought for/i.test(label) ? label : "";
      if (!started && (label || isGenerating)) {
        started = true;
        lastDotAt = Date.now();
        emit("Thinking…");
      }
      // Keep pulsing while stop-button OR thinking shimmer is live — not only
      // when isGenerating is true (ChatGPT sometimes drops the stop button
      // briefly while still showing "Thinking…", which froze OpenCode's UI).
      if (
        started &&
        !recap &&
        Date.now() - lastDotAt > 2000 &&
        (isGenerating || PLACEHOLDER.test(label))
      ) {
        lastDotAt = Date.now();
        emit(".");
      }
      if (recap && recap !== lastRecap) {
        lastRecap = recap;
        emit(started ? `\n${recap}` : recap);
        started = true;
      }
    },
    finish(thinkingLabel) {
      if (finished) return;
      finished = true;
      const label = String(thinkingLabel || "").trim();
      if (/Thought for/i.test(label) && label !== lastRecap) {
        emit(started ? `\n${label}` : label);
      } else if (started && !lastRecap) {
        emit("\n(done thinking)");
      }
    },
  };
}

/**
 * Send a message via the web UI and return the assistant's reply text.
 * @param {string} message
 * @param {{
 *   onToken?: (chunk: string) => void,
 *   onThinking?: (chunk: string) => void,
 *   chatUrl?: string|null,
 *   meta?: {chatUrl?: string, thinking?: string, model?: string, effort?: string},
 *   model?: string,
 *   effort?: string,
 *   signal?: AbortSignal,
 *   preferRawReply?: boolean,
 *   images?: Array<{data: string, mediaType: string, filename?: string}>,
 *   onStatus?: (status: {label: string, phase?: string}) => void,
 *   onMessageSubmitted?: () => void,
 * }} [opts]
 *        onToken is invoked with incremental text deltas (best-effort polling,
 *        not true token streaming — see README).
 *        onThinking streams ChatGPT thinking-status into reasoning_content.
 *        chatUrl: existing conversation to continue (fresh chat when absent).
 *        meta: out-param; meta.chatUrl is set to the conversation URL that
 *        ended up containing this exchange.
 *        model/effort: override CHAT_MODEL / CHAT_EFFORT for this request.
 *        signal: abort from client disconnect or POST /cancel.
 * @returns {Promise<string>} the assistant reply text
 * @throws err.continuationFailed=true when chatUrl was given but that
 *         conversation couldn't be opened (deleted, redirected, no composer) —
 *         the message was NOT sent, so the caller can safely retry fresh.
 * @throws err.cancelled=true when signal aborts.
 * @throws err.stalled=true when ChatGPT stops making progress.
 */
export async function chatUI(message, opts = {}) {
  const {
    onToken,
    onThinking,
    chatUrl,
    meta,
    model,
    effort,
    signal,
    preferRawReply,
    images = [],
    expectedRawNode = null,
    expectedPendingPrompt = null,
    expectedPendingUserMessageID = null,
    pendingTurnKnown = false,
    branchParentNode = null,
    onStatus = null,
    onMessageSubmitted = null,
  } = opts;
  // Native-tool suppression requires a raw-graph postcondition on every turn,
  // including plain-text turns. This is intentionally not configurable.
  const requireRawReply = true;
  // Guarded emitter: only live-stream characters that have been stable and
  // still prefix-match. On a mid-reply rewrite we abandon live emits and the
  // caller finishes with the authoritative final text.
  const guard = onToken ? createGuardedEmitter(onToken) : null;
  const thinking = createThinkingEmitter(onThinking);
  checkAbort(signal);

  return withSharedSessionScope(async ({ page, context, nativeToolFirewall }) => {
    const continuing = !!chatUrl;
    let submitted = false;
    let suppressionTurn = null;
    let responseMonitor = null;
    let verifiedBranchParentNode = branchParentNode || null;
    let retryBoundaryNode =
      verifiedBranchParentNode || expectedRawNode || null;
    const rawReaderOutcomes = new Set();
    const setPhase = (phase, label) => {
      if (meta) meta.failureStage = phase;
      try {
        onStatus?.({ label, phase });
      } catch {
        /* caller disconnected */
      }
    };
    const noteRawReader = ({ reader, outcome }) => {
      const value = `${reader}:${outcome}`;
      rawReaderOutcomes.add(value);
      if (meta) {
        meta.rawReaderOutcomes = [...rawReaderOutcomes].slice(-12);
        if (outcome === "ok") meta.rawReader = reader;
      }
    };
    const adoptDeliveredReply = async (boundaryNode) => {
      if (!continuing || !boundaryNode || !expectedPendingPrompt) return null;
      setPhase("reverify-delivered", "Re-verifying delivered ChatGPT reply");
      const adopted = await readRawLatestAssistantTurnRaced(
        page,
        context,
        chatUrl,
        {
          afterNodeID: boundaryNode,
          ...(expectedPendingUserMessageID
            ? { expectedUserMessageID: expectedPendingUserMessageID }
            : { expectedUserText: expectedPendingPrompt }),
          timeoutMs: 15_000,
          onReaderOutcome: noteRawReader,
        }
      );
      if (!adopted) return null;
      const adoptedDiscovery = isDiscoveryOnlyNativeActivity(adopted);
      if (adopted.nativeToolNames.length > 0 && !adoptedDiscovery) return null;
      if (meta) {
        meta.chatUrl = chatUrl;
        meta.rawCurrentNode = adopted.currentNode;
        meta.replySource = "raw-conversation";
        meta.replyRecovery = adoptedDiscovery
          ? "delivered-discovery-adopted"
          : "delivered-reply-adopted";
        meta.deliveryState = "recovered-verified";
        meta.nativeToolInspection = adoptedDiscovery ? "discovery-only" : "clean";
        meta.nativeToolRisk = adopted.nativeToolRisk;
        meta.nativeToolSideEffectsPossible = adopted.nativeToolSideEffectsPossible;
        if (adoptedDiscovery) meta.nativeToolNames = adopted.nativeToolNames;
        else delete meta.nativeToolNames;
        meta.rawNodeClass = adopted.rawNodeClass;
        meta.rawAuditReason = adopted.rawAuditReason;
        meta.deliveredReplyAdopted = true;
        meta.messageSubmitted = false;
      }
      await refreshSessionFile(context);
      dbg(`adopted delivered raw reply ${adopted.messageID} without Send`);
      return cleanReply(adopted.reply);
    };
    const onAbort = () => {
      // Fire-and-forget stop click; the poll loop will throw via checkAbort.
      clickStopGenerating(page).catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        await clickStopGenerating(page);
        throwCancelled(signal);
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      // Navigate only when needed: fresh chats always reload the home compose
      // view (so no stale assistant turn can be misread); reused conversations
      // skip navigation entirely if the shared page is already there.
      if (!continuing) {
        setPhase("browser-navigation", "Opening a fresh ChatGPT chat");
        await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });
      } else if (pathOf(page.url()) !== pathOf(chatUrl)) {
        setPhase("browser-navigation", "Opening the verified ChatGPT branch");
        dbg(`goto existing conversation ${chatUrl}`);
        await page.goto(chatUrl, { waitUntil: "domcontentloaded" });
      } else {
        dbg("already on conversation; skipping goto");
      }
      checkAbort(signal);

      // Adoption is deliberately ahead of every composer/renderer check. A
      // delivered raw reply remains recoverable even while ChatGPT's rendered
      // page is blank, still hydrating, or has no usable composer.
      const earlyAdopted = await adoptDeliveredReply(
        verifiedBranchParentNode || expectedRawNode || null
      );
      if (earlyAdopted) return earlyAdopted;

      // Cloudflare may show a "Just a moment…" interstitial first; with the stealth
      // flags in session.js it auto-resolves, but it can take ~10-20s.
      try {
        await page.waitForSelector("#prompt-textarea", {
          timeout: continuing ? 20_000 : 60_000,
        });
      } catch (err) {
        // Fail fast on an expired login instead of waiting out the reply timeout.
        if (await detectAuthExpired(page)) {
          throwSessionExpired(page.url());
        }
        if (continuing) {
          const e = new Error(
            `playwright-backend: existing conversation didn't show a composer (${chatUrl})`
          );
          if (expectedRawNode && expectedPendingPrompt) {
            e.continuationPending = true;
            e.messageNotSubmitted = true;
          } else {
            e.continuationFailed = true;
          }
          throw e;
        }
        throw err;
      }
      checkAbort(signal);

      // A deleted/unavailable conversation redirects back to the home view —
      // sending there would silently start a context-less chat. Bail instead.
      // (Auth redirects are reported as session-expired, not continuationFailed.)
      if (continuing && pathOf(page.url()) !== pathOf(chatUrl)) {
        if (await detectAuthExpired(page)) {
          throwSessionExpired(page.url());
        }
        const e = new Error(
          `playwright-backend: conversation redirected away (${chatUrl} -> ${page.url()})`
        );
        e.continuationFailed = true;
        throw e;
      }

      // Persisted chats often paint the composer before message turns hydrate.
      // Wait briefly so prev-turn anchoring sees the real history.
      if (continuing) {
        const loaded = await waitForConversationTurns(page);
        dbg(`conversation turns loaded: ${loaded}`);
        if (loaded === 0) {
          // The rendered thread is only diagnostic. Raw cursor/user UUID
          // anchoring below remains authoritative for continuation safety.
          if (meta) meta.domState = "dom-unavailable";
        }
      }
      checkAbort(signal);

      // Audit the authenticated raw head before touching the composer. A
      // persisted cursor lets us branch away from out-of-band descendants;
      // legacy mappings without a cursor are quarantined when their latest
      // turn contains native activity and matches the pending OpenCode delta.
      if (continuing) {
        setPhase("pre-send-audit", "Auditing ChatGPT before Send");
        const auditBoundary =
          verifiedBranchParentNode || expectedRawNode || null;
        let audit = await readRawConversationAuditRaced(
          page,
          context,
          chatUrl,
          {
            afterNodeID: auditBoundary,
            onReaderOutcome: noteRawReader,
          }
        );
        if (!audit) {
          // No submitted turn is waiting to be adopted, so the last committed
          // raw cursor is a safe sibling parent even when ChatGPT's current
          // head cannot be read. Force the outbound parent to that cursor and
          // retain the mandatory post-send raw audit.
          verifiedBranchParentNode =
            verifiedBranchParentForUnavailableAudit({
              branchParentNode: verifiedBranchParentNode,
              expectedRawNode,
              pendingTurnKnown,
            });
        }
        if (!audit && verifiedBranchParentNode) {
          // An explicit recovery branch is already anchored to a previously
          // verified clean cursor (or a normal continuation has no pending
          // submitted turn). If both raw readers are temporarily
          // unavailable, it is still safe to submit from that exact sibling;
          // the completed reply remains subject to mandatory raw post-checking.
          audit = {
            currentNode: verifiedBranchParentNode,
            boundaryNode: verifiedBranchParentNode,
            safeParentNode: verifiedBranchParentNode,
            drifted: false,
            userMessageID: null,
            userText: null,
            assistantCallNames: [],
            toolResultNames: [],
            nativeToolNames: [],
            rawNodeClass: "clean",
            rawAuditReason: "verified-branch-parent",
            nativeToolRisk: "clean",
            nativeToolSideEffectsPossible: false,
          };
          dbg(
            `raw pre-send readers unavailable; continuing from verified branch parent ${verifiedBranchParentNode}`
          );
        }
        if (!audit) {
          const err = new Error(
            `playwright-backend: raw conversation pre-send audit was unavailable for ${chatUrl}`
          );
          err.nativeToolRecovery = true;
          err.nativeToolRisk = "unverifiable";
          err.nativeSafeParentNode = null;
          err.chatUrl = chatUrl;
          err.nativeToolInspectionUnavailable = true;
          err.deliveryState = "pre-send-unverified";
          err.rawNodeClass = "unverifiable";
          err.rawAuditReason = "raw-presend-unavailable";
          throw err;
        }
        if (meta) meta.rawBeforeNode = audit.currentNode;

        // A prior generation may have completed in ChatGPT after OpenCode lost
        // its rendered reply. Adopt it without sending a duplicate request,
        // but only when the raw path is anchored to our committed boundary and
        // exact reconstructed pending prompt, is complete, and is tool-clean.
        if (audit.drifted && auditBoundary && expectedPendingPrompt) {
          const adopted = await adoptDeliveredReply(auditBoundary);
          if (adopted) return adopted;
        }

        if (!verifiedBranchParentNode) {
          const callNames = audit.assistantCallNames || [];
          const resultNames = audit.toolResultNames || [];
          const hasLegacyActivity = !expectedRawNode && (callNames.length || resultNames.length);
          const hasCursorDrift = !!expectedRawNode && audit.drifted;
          if (hasLegacyActivity || hasCursorDrift) {
            const normalize = (value) => String(value || "").replace(/\r\n/g, "\n").trim();
            const actual = normalize(audit.userText);
            const expected = normalize(expectedPendingPrompt);
            const legacyUserMatched =
              !!expectedRawNode ||
              (!!actual && (expected === actual || expected.startsWith(`${actual}\n`)));
            const err = new Error(
              `playwright-backend: persisted conversation head requires a safe branch (${chatUrl})`
            );
            err.nativeToolRecovery = true;
            err.nativeAssistantCallNames = callNames;
            err.nativeToolResultNames = resultNames;
            err.nativeSafeParentNode = legacyUserMatched ? audit.safeParentNode : null;
            err.nativeToolRisk = hasCursorDrift && !callNames.length && !resultNames.length
              ? "clean-drift"
              : legacyUserMatched
                ? audit.nativeToolRisk === "confirmed-no-side-effect"
                  ? "confirmed-no-side-effect"
                  : "native-activity"
                : "unverifiable";
            err.nativeToolSideEffectsPossible = audit.nativeToolSideEffectsPossible !== false;
            err.chatUrl = chatUrl;
            throw err;
          }
        }
      }

      // Arm the context before model-picker interaction. The current ChatGPT
      // client can issue /conversation/prepare while changing Intelligence;
      // it must be patched under the same turn ledger as the eventual Send.
      setPhase("firewall-preflight", "Arming ChatGPT safety firewall");
      await nativeToolFirewall.preflight(page, meta || {});
      suppressionTurn = nativeToolFirewall.beginTurn(meta || {}, {
        branchParentNode: verifiedBranchParentNode,
        composerText: COMPOSER_SENTINEL,
        userText: message,
      });

      // Lock the composer to the configured model + thinking effort (defaults:
      // GPT-5.6 Sol / High) before typing. Idempotent when already selected.
      setPhase("model-selection", "Selecting ChatGPT intelligence");
      const intel = await ensureIntelligenceSelection(page, { model, effort });
      if (meta) {
        meta.model = intel.selection_verified ? intel.model || CHAT_MODEL : null;
        meta.effort = intel.selection_verified
          ? intel.effort || CHAT_EFFORT
          : null;
        meta.requestedModel = intel.requestedModel ?? model;
        meta.requestedEffort = intel.requestedEffort ?? effort;
        meta.selection_verified = !!intel.selection_verified;
      }

      if (images.length > 0) {
        // Intelligence-picker interaction can remount ChatGPT's composer while
        // leaving a detached upload input behind. A file assigned to that stale
        // node disappears without an error. Reload only after model selection,
        // while the firewall is armed and before the outbound turn boundary is
        // captured, so image input is bound to the live composer.
        const composerUrl = continuing ? chatUrl : "https://chatgpt.com/";
        dbg(`reload image composer ${composerUrl}`);
        await page.goto(composerUrl, { waitUntil: "domcontentloaded" });
        try {
          await page.waitForSelector("#prompt-textarea", { timeout: 60_000 });
        } catch (error) {
          if (await detectAuthExpired(page)) throwSessionExpired(page.url());
          error.messageNotSubmitted = true;
          throw error;
        }
        if (continuing && pathOf(page.url()) !== pathOf(chatUrl)) {
          const error = new Error(
            `playwright-backend: image composer redirected away (${chatUrl} -> ${page.url()})`
          );
          error.messageNotSubmitted = true;
          throw error;
        }
        if (continuing) {
          const loaded = await waitForConversationTurns(page);
          dbg(`image composer turns loaded: ${loaded}`);
        }
      }

      // Record the assistant turns that exist BEFORE we send, so we only ever
      // read a NEW one (avoids re-reading a stale prior reply — critical when
      // reusing a conversation that's full of earlier answers).
      const prev = await boundedDomRead(
        page.evaluate(() => {
          const turns = document.querySelectorAll(
            '[data-message-author-role="assistant"]'
          );
          const last = turns[turns.length - 1] || null;
          return {
            count: turns.length,
            lastId: last?.getAttribute("data-message-id") || null,
            userCount: document.querySelectorAll('[data-message-author-role="user"]').length,
          };
        }),
        "ChatGPT prior-turn snapshot"
      ).catch((err) => {
        if (!err?.domReadTimeout) throw err;
        if (meta) meta.domState = "dom-unavailable";
        return { count: 0, lastId: null, userCount: 0 };
      });
      dbg(`prev turns=${prev.count} lastId=${prev.lastId || "-"}`);
      // The raw conversation graph is the stable turn boundary when ChatGPT's
      // rendered assistant selectors drift or an empty terminal node is added.
      // expectedUserText below is a second stale-reply guard when this cursor
      // cannot be read.
      const rawBeforeNode =
        continuing && requireRawReply
          ? verifiedBranchParentNode ||
            await readRawConversationCursor(page, chatUrl)
          : null;
      retryBoundaryNode = rawBeforeNode || retryBoundaryNode;
      if (meta) meta.rawBeforeNode = retryBoundaryNode;
      dbg(`raw boundary=${rawBeforeNode || "-"}`);

      await clearComposerDraft(page);
      setPhase("composer", "Preparing the ChatGPT composer");
      const editor = page.locator("#prompt-textarea");
      // Never expose the real (often very large) prompt to the rendered DOM or
      // Playwright call logs. The fail-closed request firewall replaces this
      // fixed marker in the outbound JSON while preserving uploaded assets.
      dbg(`filling composer sentinel; outbound chars=${message.length}`);
      await fillComposerText(editor, COMPOSER_SENTINEL);
      dbg("composer filled");
      let uploadedImageCount;
      try {
        uploadedImageCount = await uploadImages(page, images, signal);
      } catch (error) {
        const next = error instanceof Error ? error : new Error(String(error));
        // No conversation Send has happened yet. Composer inputs are transient
        // and ChatGPT occasionally leaves a fresh page with a stale "Max 0"
        // upload state, so the serialized provider may safely reload and retry.
        if (!/(?:unsupported image type|empty or corrupted)/i.test(next.message)) {
          next.imageUploadRetryable = true;
          next.messageNotSubmitted = true;
          if (meta) meta.messageSubmitted = false;
        }
        throw next;
      }
      if (meta) meta.uploadedImageCount = uploadedImageCount;
      checkAbort(signal);

      // Submit with the send button so embedded newlines stay inside one message.
      // If the click fails, fall back to Enter only after the full prompt is in
      // the composer.
      const activeForm = page.locator('form[data-type="unified-composer"]').filter({ visible: true }).last();
      const sendScope = (await activeForm.count()) ? activeForm : page;
      const sendBtn = sendScope.locator(
        '[data-testid="send-button"], [data-testid="composer-send-button"], button[aria-label*="Send message" i], button[aria-label*="Send" i]'
      ).filter({ visible: true }).last();
      responseMonitor = monitorConversationResponses(page);
      try {
        await sendBtn.click({ timeout: 8000 });
        dbg("clicked send");
      } catch (clickError) {
        // Only fall back when the click itself failed. The firewall refuses a
        // second generation request after one patched send, preventing the old
        // stop-button retry from double-submitting a prompt.
        const early = await nativeToolFirewall.waitForSend(suppressionTurn, 500);
        if (early.status === "sent") {
          dbg("send request observed despite click error");
        } else {
          const clicked = await page.evaluate(() => {
            const selector =
              '[data-testid="send-button"], [data-testid="composer-send-button"], button[aria-label*="Send message" i], button[aria-label*="Send" i]';
            const candidates = [...document.querySelectorAll(selector)];
            const button = candidates.reverse().find((item) => {
              const style = getComputedStyle(item);
              return (
                item.getClientRects().length > 0 &&
                style.visibility !== "hidden" &&
                style.display !== "none" &&
                !item.hasAttribute("disabled") &&
                item.getAttribute("aria-disabled") !== "true"
              );
            });
            if (!button) return false;
            button.click();
            return true;
          }).catch(() => false);
          if (clicked) {
            dbg(`send locator click failed (${String(clickError?.message || clickError).split("\n")[0]}); clicked live DOM button`);
          } else {
            await page.keyboard.press("Enter");
            dbg(`send locator click failed (${String(clickError?.message || clickError).split("\n")[0]}); pressed Enter`);
          }
        }
      }
      const sendAck = await nativeToolFirewall.waitForSend(suppressionTurn, 15_000);
      if (sendAck.status !== "sent") {
        const err = new Error(
          "playwright-backend: no firewall-verified ChatGPT conversation request followed Send"
        );
        err.messageNotSubmitted = true;
        // The fail-closed firewall proved that no conversation transport left
        // the page. For an image turn this is another safe fresh-composer retry
        // case, not an ambiguous submitted generation.
        if (images.length > 0) err.imageUploadRetryable = true;
        throw err;
      }
      if (meta) meta.messageSubmitted = true;
      if (meta) meta.deliveryState = "submitted";
      if (meta) meta.promptTransport = "transport-patched";
      if (meta) meta.outboundUserMessageID = sendAck.userMessageID || suppressionTurn.userMessageID;
      submitted = true;
      setPhase("generation", "Waiting for ChatGPT generation");
      try {
        onMessageSubmitted?.();
      } catch {
        /* lifecycle observers must never invalidate a verified Send */
      }
      dbg("firewall verified patched conversation request");
      const rawTurnOptions = {
        afterNodeID: rawBeforeNode,
        expectedUserMessageID: sendAck.userMessageID || suppressionTurn.userMessageID,
        expectedUserText: message,
      };
      const rawVerificationOptions = () => ({
        ...rawTurnOptions,
        // Raw graph synchronization can legitimately exceed the historical
        // 30-second post-check while still fitting comfortably in the turn's
        // end-to-end budget.
        timeoutMs: Math.min(
          120_000,
          Math.max(30_000, REPLY_HARD_CAP_MS - (Date.now() - start))
        ),
        onReaderOutcome: noteRawReader,
      });
      let domTimeoutRawTurn = null;
      const recoverDomTimeout = async (err) => {
        if (!err?.domReadTimeout) throw err;
        const currentUrl = await waitForConversationUrl(page, chatUrl, 30_000, signal);
        if (!requireRawReply || !currentUrl) throw err;
        const rawTurn = await readRawLatestAssistantTurnRaced(
          page,
          context,
          currentUrl,
          {
            ...rawTurnOptions,
            timeoutMs: Math.max(1, REPLY_HARD_CAP_MS - (Date.now() - start)),
            onReaderOutcome: noteRawReader,
          }
        );
        if (!rawTurn) throw err;
        domTimeoutRawTurn = rawTurn;
        if (meta) meta.replyRecovery = "dom-timeout-raw";
        if (meta) meta.domState = "dom-unavailable";
        dbg(`DOM snapshot timed out; recovered raw assistant source for ${rawTurn.messageID}`);
        return {
          text: rawTurn.reply,
          thinking: "",
          isGenerating: false,
          turnCount: prev.count + 1,
          turnId: rawTurn.messageID,
        };
      };

      // Wait briefly for the stop button to appear, which proves the message was
      // accepted by the UI. Never retry Send here: the firewall acknowledgement
      // already proves the single permitted generation request left Chromium.
      try {
        await page.waitForSelector(
          '[data-testid="composer-stop-btn"], button[aria-label*="Stop generating" i], button[aria-label*="Stop" i]',
          { timeout: 8000 }
        );
        dbg("submitted (stop btn appeared)");
      } catch {
        dbg("stop button did not appear; continuing without a duplicate send");
      }
      responseMonitor.throwIfFailed();
      checkAbort(signal);

      // Phase 1: wait for generation to start (the stop button appears, or a NEW
      // reply node / thinking placeholder appears). Keep this bounded — if the
      // send never took, don't burn the full Sol+High soft deadline.
      const start = Date.now();
      const PHASE1_MS = Math.min(90_000, REPLY_TIMEOUT_MS);
      let lastThinking = "";
      let phase1Snap = { isGenerating: false, text: "", thinking: "" };
      while (Date.now() - start < PHASE1_MS) {
        checkAbort(signal);
        await responseMonitor.wait(POLL_MS);
        try {
          phase1Snap = await snapshot(page, prev);
        } catch (err) {
          phase1Snap = await recoverDomTimeout(err);
        }
        const phase1Failure = renderedFailureError(phase1Snap.errorText);
        if (phase1Failure) throw phase1Failure;
        if (phase1Snap.thinking) lastThinking = phase1Snap.thinking;
        if (thinking) {
          thinking.observe(phase1Snap.thinking || lastThinking, phase1Snap.isGenerating);
        }
        if (phase1Snap.isGenerating || phase1Snap.text || phase1Snap.thinking) break;
      }
      dbg(`phase1 done @${((Date.now() - start) / 1000).toFixed(1)}s`);
      if (
        !phase1Snap.isGenerating &&
        !phase1Snap.text &&
        !phase1Snap.thinking &&
        Date.now() - start >= PHASE1_MS
      ) {
        dbg(`generation never started within ${Math.round(PHASE1_MS / 1000)}s — continuing to poll anyway`);
      }

      // Phase 2: poll until generation finishes and the text is a stable,
      // non-placeholder string. Guarded live-streaming emits only characters
      // that have been stable and still prefix-match (see stream-guard.js).
      // Sol+High thinking on large OpenCode prompts often exceeds 150s — keep
      // waiting past REPLY_TIMEOUT_MS while the stop button / thinking UI is live.
      let lastText = domTimeoutRawTurn ? cleanReply(domTimeoutRawTurn.reply) : "";
      let doneAt = 0;
      let genDoneAt = 0;
      let pollN = 0;
      let lastSnap = phase1Snap;
      let extendedLogged = false;
      let lastProgressAt = Date.now();
      let lastProgressKey = "";
      let latestRawTurn = domTimeoutRawTurn;
      let usedEmptyDomRaw = !!domTimeoutRawTurn;
      let lastRawAttemptAt = 0;

      while (!domTimeoutRawTurn && !pastDeadline(start, lastSnap, lastText || lastSnap.text)) {
        checkAbort(signal);
        await responseMonitor.wait(POLL_MS);
        let s;
        try {
          s = await snapshot(page, prev);
        } catch (err) {
          s = await recoverDomTimeout(err);
          latestRawTurn = domTimeoutRawTurn;
          usedEmptyDomRaw = true;
          lastText = cleanReply(s.text);
          lastSnap = s;
          break;
        }
        lastSnap = s;
        const renderedFailure = renderedFailureError(s.errorText);
        if (renderedFailure) throw renderedFailure;
        const text = cleanReply(s.text);
        pollN++;
        if (s.thinking) lastThinking = s.thinking;
        if (thinking) thinking.observe(s.thinking || lastThinking, s.isGenerating);
        const elapsed = Date.now() - start;
        if (!extendedLogged && elapsed >= REPLY_TIMEOUT_MS) {
          extendedLogged = true;
          dbg(`soft timeout ${Math.round(REPLY_TIMEOUT_MS / 1000)}s reached but ChatGPT still busy — extending (hard cap ${Math.round(REPLY_HARD_CAP_MS / 1000)}s)`);
        }

        // Progress = generating flip, thinking-label change, or text growth.
        const progressKey = [
          s.isGenerating ? "1" : "0",
          String(s.thinking || "").slice(0, 80),
          String(text || "").length,
          String(text || "").slice(-48),
        ].join("|");
        if (progressKey !== lastProgressKey) {
          lastProgressKey = progressKey;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > REPLY_STALL_MS) {
          const err = new Error(
            `playwright-backend: ChatGPT stalled (no progress for ${Math.round(REPLY_STALL_MS / 1000)}s at ${Math.round(elapsed / 1000)}s)`
          );
          err.stalled = true;
          throw err;
        }

        if (DEBUG && (pollN % 6 === 0 || (text && text !== lastText) || s.thinking)) {
          dbg(
            `poll#${pollN} @${(elapsed / 1000).toFixed(1)}s gen=${s.isGenerating} think=${JSON.stringify((s.thinking || "").slice(0, 40))} text=${JSON.stringify((text || "").slice(0, 40))}`
          );
        }

        if (text && text !== lastText) {
          lastText = text;
          if (guard && !requireRawReply && safeToStream(text)) guard.observe(text);
          doneAt = 0;
        } else if (text && guard && !requireRawReply && safeToStream(text)) {
          // Same text still showing — let the guard commit if it's gone stable.
          guard.observe(text);
        }

        // Done = not generating AND we have real (non-placeholder) text that has
        // been stable for STABLE_DONE_MS.
        if (!s.isGenerating && text && !PLACEHOLDER.test(text) && !isBoilerplate(text)) {
          if (!doneAt) doneAt = Date.now();
          if (Date.now() - doneAt > STABLE_DONE_MS) break;
        } else if (!s.isGenerating && !text) {
          // Generation finished but no markdown text appeared yet. The thinking
          // model sometimes renders the answer into .markdown late, or in a
          // sibling layer. Keep waiting a while longer; only fall back to a
          // full-thread scrape after a generous grace period — and only in a
          // fresh chat, where the thread contains nothing but this exchange.
          if (!genDoneAt) genDoneAt = Date.now();
          // A tool reply can exist in the authenticated raw conversation while
          // the rendered DOM exposes only an empty terminal assistant node.
          // Resolve it as soon as generation has settled instead of waiting for
          // the unrelated 10-minute soft deadline.
          if (
            requireRawReply &&
            Date.now() - genDoneAt > STABLE_DONE_MS &&
            Date.now() - lastRawAttemptAt > 5000 &&
            /\/c\//.test(page.url())
          ) {
            lastRawAttemptAt = Date.now();
            latestRawTurn = await readRawLatestAssistantTurnRaced(
              page,
              context,
              page.url(),
              rawVerificationOptions()
            );
            if (latestRawTurn) {
              lastText = cleanReply(latestRawTurn.reply);
              if (lastText) {
                usedEmptyDomRaw = true;
                lastSnap = { ...s, turnId: latestRawTurn.messageID };
                break;
              }
            }
          }
          if (Date.now() - genDoneAt > 8000 && prev.count === 0) {
            const fallback = cleanReply(await scrapeMainReply(page));
            if (fallback && !PLACEHOLDER.test(fallback) && !isBoilerplate(fallback)) {
              lastText = fallback;
              if (guard && !requireRawReply && safeToStream(fallback)) guard.observe(fallback);
              break;
            }
          }
          // Continued chats: don't sit until hard cap after thinking finished
          // with an empty reply node — fail fast so OpenCode can recover.
          if (Date.now() - genDoneAt > REPLY_IDLE_GRACE_MS) {
            dbg(`generation idle with no text for ${Math.round(REPLY_IDLE_GRACE_MS / 1000)}s — stopping`);
            break;
          }
        } else {
          doneAt = 0;
          if (s.isGenerating) genDoneAt = 0;
        }
      }

      checkAbort(signal);
      responseMonitor.throwIfFailed();

      // Final read in case the last poll raced — or we hit the deadline while a
      // reply was already on screen (common with Sol+High after long thinking).
      if (!lastText || PLACEHOLDER.test(lastText) || isBoilerplate(lastText)) {
        // Give a late-rendering .markdown a moment after stop-generating flips.
        if (!lastSnap.isGenerating) {
          await page.waitForTimeout(1500).catch(() => {});
        }
        const s = await snapshot(page, prev);
        lastText = cleanReply(s.text) || lastText;
        if (s.thinking) lastThinking = s.thinking;
      }

      // Last-resort: if .markdown stayed empty, try the full-thread scrape
      // (fresh chats only — see above).
      if ((!lastText || PLACEHOLDER.test(lastText) || isBoilerplate(lastText)) && prev.count === 0) {
        const fallback = cleanReply(await scrapeMainReply(page));
        if (fallback) lastText = fallback;
      }

      // Final raw fallback also covers hard/soft deadline exits and a raw API
      // response that synchronized just after the last idle-loop attempt.
      if (
        (!lastText || PLACEHOLDER.test(lastText) || isBoilerplate(lastText)) &&
        requireRawReply &&
        /\/c\//.test(page.url())
      ) {
        latestRawTurn =
          latestRawTurn ||
          await readRawLatestAssistantTurnRaced(
            page,
            context,
            page.url(),
            rawVerificationOptions()
          );
        if (latestRawTurn) {
          lastText = cleanReply(latestRawTurn.reply);
          if (lastText) {
            usedEmptyDomRaw = true;
            lastSnap = { ...lastSnap, turnId: latestRawTurn.messageID };
          }
        }
      }

      if (!lastText || PLACEHOLDER.test(lastText) || isBoilerplate(lastText)) {
        if (await detectAuthExpired(page)) {
          throwSessionExpired(page.url());
        }
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        const currentUrl = page.url().split(/[?#]/)[0];
        const err = nativeToolFirewall.lockViolation(
          [],
          /\/c\//.test(currentUrl) ? currentUrl : null,
          `raw conversation post-check was unavailable after ${elapsedSec}s`
        );
        err.message = `playwright-backend: raw conversation post-check was unavailable (${elapsedSec}s; idle-grace=${Math.round(REPLY_IDLE_GRACE_MS / 1000)}s); further sends are blocked`;
        err.nativeToolInspectionUnavailable = true;
        err.deliveryState = "not-delivered";
        if (meta) meta.replyRecovery = "unavailable";
        if (meta) meta.deliveryState = "not-delivered";
        throw err;
      }

      if (meta) meta.deliveryState = "delivered";

      // Final thinking scrape (recap button often appears only after generation).
      try {
        await page.waitForTimeout(400);
        const finalSnap = await snapshot(page, prev);
        lastSnap = finalSnap;
        if (finalSnap.thinking) lastThinking = finalSnap.thinking;
      } catch {
        /* ignore */
      }
      if (thinking) thinking.finish(lastThinking);

      const currentChatUrl = page.url().split(/[?#]/)[0];
      let replySource = usedEmptyDomRaw ? "raw-conversation" : "rendered-dom";
      let acceptedNativeDiscovery = false;
      if (meta) {
        meta.nativeToolInspection = "unavailable";
        delete meta.nativeToolNames;
      }
      let authoritativeRawTurn = null;
      if (requireRawReply && /\/c\//.test(currentChatUrl)) {
        setPhase("post-send-audit", "Verifying ChatGPT raw ancestry");
        const rawTurn =
          latestRawTurn ||
          await readRawLatestAssistantTurnRaced(
            page,
            context,
            currentChatUrl,
            rawVerificationOptions()
          );
        authoritativeRawTurn = rawTurn;
        if (rawTurn) {
          const names = rawTurn.nativeToolNames || [];
          acceptedNativeDiscovery = isDiscoveryOnlyNativeActivity(rawTurn);
          if (meta) {
            meta.nativeToolInspection = names.length
              ? acceptedNativeDiscovery
                ? "discovery-only"
                : "detected"
              : "clean";
            meta.nativeToolRisk =
              rawTurn.nativeToolRisk || (names.length ? "native-activity" : "clean");
            meta.nativeToolSideEffectsPossible = rawTurn.nativeToolSideEffectsPossible;
            meta.rawNodeClass = rawTurn.rawNodeClass || (names.length ? "native-activity" : "clean");
            meta.rawAuditReason = rawTurn.rawAuditReason || (names.length ? "tool-result" : "none");
            if (names.length) meta.nativeToolNames = names;
            else delete meta.nativeToolNames;
          }
          lastText = rawTurn.reply;
          replySource = "raw-conversation";
          dbg(`using mandatory raw assistant source for ${rawTurn.messageID || lastSnap.turnId}`);
          if (names.length && !acceptedNativeDiscovery) {
            if (meta) meta.deliveryState = "delivered-rejected";
            if (meta) meta.rawRejectedNode = rawTurn.currentNode || null;
            const err = nativeToolFirewall.lockViolation(names, currentChatUrl);
            err.nativeToolRecovery = true;
            err.nativeAssistantCallNames = rawTurn.assistantCallNames || names;
            err.nativeToolResultNames = rawTurn.toolResultNames || [];
            err.nativeSafeParentNode = rawTurn.safeParentNode || null;
            err.nativeContaminatedNode = rawTurn.currentNode || null;
            err.nativeToolRisk = rawTurn.nativeToolRisk === "confirmed-no-side-effect"
              ? "confirmed-no-side-effect"
              : "native-activity";
            err.nativeToolSideEffectsPossible = rawTurn.nativeToolSideEffectsPossible !== false;
            err.deliveryState = "delivered-rejected";
            err.rawNodeClass = rawTurn.rawNodeClass || "native-activity";
            err.rawAuditReason = rawTurn.rawAuditReason || "tool-result";
            err.message =
              `ChatGPT delivered a reply, but authenticated safety verification detected native activity despite transport suppression (${names.join(", ")}). ` +
              "No OpenCode host command from the rejected reply was executed, but ChatGPT-native state may already have changed. " +
              `Further sends are blocked for this provider process. Chat: ${currentChatUrl}`;
            throw attachRejectedReply(err, lastText, { source: replySource });
          }
        } else {
          if (meta) {
            meta.nativeToolInspection = "unavailable";
            meta.deliveryState = "verification-unavailable";
            meta.rawNodeClass = "unverifiable";
            meta.rawAuditReason = "raw-postcheck-unavailable";
            delete meta.nativeToolNames;
          }
          const err = nativeToolFirewall.lockViolation(
            [],
            currentChatUrl,
            "raw conversation post-check was unavailable"
          );
          err.message = `playwright-backend: ChatGPT delivered a reply, but the authenticated raw conversation post-check was unavailable for ${currentChatUrl}; further sends are blocked`;
          err.nativeToolInspectionUnavailable = true;
          err.deliveryState = "verification-unavailable";
          err.rawNodeClass = "unverifiable";
          err.rawAuditReason = "raw-postcheck-unavailable";
          throw attachRejectedReply(err, lastText, { source: replySource });
        }
      } else {
        const err = nativeToolFirewall.lockViolation(
          [],
          null,
          "ChatGPT did not expose a conversation URL for raw post-checking"
        );
        err.message = "playwright-backend: ChatGPT did not expose a conversation URL for mandatory raw inspection; further sends are blocked";
        err.nativeToolInspectionUnavailable = true;
        err.deliveryState = "verification-unavailable";
        throw attachRejectedReply(err, lastText, { source: replySource });
      }

      if (meta) meta.deliveryState = "verified";

      // Flush any remainder that still prefix-matches what we already streamed.
      // Skip finish for banner replies — the server will reject them.
      if (
        guard &&
        (meta?.nativeToolInspection === "clean" ||
          meta?.nativeToolInspection === "discovery-only") &&
        safeToStream(lastText)
      ) {
        guard.finish(lastText);
      }

      // Report which conversation now holds this exchange. A fresh chat redirects
      // to /c/<id> once the first reply starts; if that hasn't happened the URL
      // isn't a conversation yet and we simply report nothing.
      if (meta) {
        if (/\/c\//.test(currentChatUrl)) meta.chatUrl = currentChatUrl;
        if (authoritativeRawTurn?.currentNode) {
          meta.rawCurrentNode = authoritativeRawTurn.currentNode;
        }
        meta.replySource = replySource;
        if (acceptedNativeDiscovery) meta.replyRecovery = "native-discovery-accepted";
        else if (domTimeoutRawTurn) meta.replyRecovery = "dom-timeout-raw";
        else if (usedEmptyDomRaw) meta.replyRecovery = "empty-dom-raw";
        else delete meta.replyRecovery;
        if (lastThinking) meta.thinking = lastThinking;
        if (guard) {
          meta.streamedChars = guard.getEmitted().length;
          meta.streamAbandoned = guard.wasAbandoned();
        }
      }

      // Persist rotating cookies so the login stays alive between re-exports.
      await refreshSessionFile(context);

      dbg(`done @${((Date.now() - start) / 1000).toFixed(1)}s len=${lastText.length}`);
      return lastText;
    } catch (err) {
      err.messageSubmitted = submitted;
      err.failureStage = meta?.failureStage || err.failureStage;
      err.rawReader = meta?.rawReader || err.rawReader;
      err.rawReaderOutcomes = meta?.rawReaderOutcomes || err.rawReaderOutcomes;
      if (submitted && meta) {
        const current = page.url().split(/[?#]/)[0];
        if (/\/c\//.test(current)) meta.chatUrl = current;
        if (meta.deliveryState === "submitted") meta.deliveryState = "submitted-unverified";
      }
      if (err?.rateLimited) {
        const current = page.url().split(/[?#]/)[0];
        if (/\/c\//.test(current)) err.chatUrl = current;
        err.safeParentNode = retryBoundaryNode;
        err.messageSubmitted = submitted;
        err.outboundUserMessageID =
          meta?.outboundUserMessageID || suppressionTurn?.userMessageID || null;
        if (meta) {
          meta.deliveryState = "rate-limited";
          meta.rateLimitSource = err.rateLimitSource || "unknown";
        }
      }
      if (!submitted) await clearComposerDraft(page).catch(() => {});
      throw err;
    } finally {
      responseMonitor?.close();
      nativeToolFirewall.finishTurn(suppressionTurn);
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  });
}
