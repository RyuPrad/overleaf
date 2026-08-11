// session.js
// Launch a Playwright browser context that is ALREADY logged into ChatGPT,
// using a saved storageState (cookies + localStorage) file. Mirrors the
// withSession() pattern from x-controller/index.js.
//
// Run the package's export-session command once to create the private native
// session.json, then this module needs no login flow at all.
//
// OpenCode fires concurrent requests (title + main). Launching a fresh
// Chromium per request made the second call wait minutes behind the first.
// Shared session reuse keeps one browser alive across serialized requests.
//
// After each successful turn we optionally write the live storageState back
// to SESSION_FILE so rotating cookies keep the login alive between manual
// re-exports. Auth-expired pages fail fast with a clear error instead of
// waiting out the 150s reply timeout.

import { chromium } from "playwright";
import { chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { DEFAULT_SESSION_FILE } from "./paths.js";
import { createNativeToolFirewall } from "./native-tool-firewall.js";
import { debugLog } from "./debug-log.js";

const flag = (v) => String(v ?? "").trim();
const HEADED = flag(process.env.HEADED) === "1";
const SESSION_FILE = DEFAULT_SESSION_FILE;
const REFRESH_SESSION = flag(process.env.REFRESH_SESSION || "1") !== "0";
const BROWSER_CLOSE_TIMEOUT_MS = Number(process.env.BROWSER_CLOSE_TIMEOUT_MS || 5_000);

/** @type {null | {browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page, nativeToolFirewall: ReturnType<typeof createNativeToolFirewall>, busy: boolean}} */
let shared = null;
let sharedLock = Promise.resolve();
let sharedGeneration = 0;
let lastRefreshAt = 0;
const REFRESH_MIN_INTERVAL_MS = 60_000;
const ownedBrowserPids = new WeakMap();

function browserChildPids() {
  try {
    return readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .filter((pid) => {
        try {
          const status = readFileSync(`/proc/${pid}/status`, "utf8");
          const parent = Number(status.match(/^PPid:\s+(\d+)/m)?.[1] || 0);
          if (parent !== process.pid) return false;
          const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
          return /(?:chrome|chromium|headless_shell)/i.test(command) &&
            command.includes("--remote-debugging-pipe");
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

function registerOwnedBrowser(browser, before) {
  const prior = new Set(before || []);
  const current = browserChildPids();
  const pid = current.find((candidate) => !prior.has(candidate)) || current.at(-1);
  if (pid) ownedBrowserPids.set(browser, pid);
}

function killOwnedBrowser(browser) {
  const pid = ownedBrowserPids.get(browser);
  if (!pid || !browserChildPids().includes(pid)) return false;
  try {
    process.kill(pid, "SIGKILL");
    ownedBrowserPids.delete(browser);
    return true;
  } catch {
    return false;
  }
}

export async function closeBrowserBounded(
  browser,
  label = "ChatGPT browser",
  timeoutMs = BROWSER_CLOSE_TIMEOUT_MS
) {
  if (!browser) return true;
  let timer;
  const closing = Promise.resolve()
    .then(() => browser.close())
    .then(() => true, () => true);
  try {
    const closed = await Promise.race([
      closing,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    if (!closed) {
      debugLog(`${label} close exceeded ${timeoutMs}ms; detaching stale handle`, "[session]");
      if (killOwnedBrowser(browser)) {
        debugLog(`force-terminated owned Chromium for ${label}`, "[session]");
      }
    }
    return closed;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Launch a browser context already authenticated via the saved session.
 *
 * Stealth note: ChatGPT sits behind Cloudflare, which serves a "Just a
 * moment…" challenge to anything it fingerprints as automated. A vanilla
 * Playwright launch gets stuck there even with a valid session. The settings
 * below (the --disable-blink-features flag + hiding navigator.webdriver) let
 * the challenge auto-resolve so the saved cookies take effect.
 *
 * @returns {Promise<{browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page}>}
 *   Caller is responsible for closing the browser (or use withSessionScope).
 */
export async function withSession() {
  if (!existsSync(SESSION_FILE)) {
    const err = new Error(
      `ChatGPT session file missing at ${SESSION_FILE}. Run \`bun run --cwd packages/chatgpt-web export-session\` or migrate the existing storageState file.`
    );
    err.sessionExpired = true;
    throw err;
  }

  const browserPidsBefore = browserChildPids();
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  registerOwnedBrowser(browser, browserPidsBefore);
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    // Match the UA of a current real Chrome; Playwright's default headless UA
    // is a fingerprint Cloudflare flags.
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });
  // Hide the navigator.webdriver flag that headless Chrome sets by default.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  // Install before creating the first page. Every page and retry in this
  // context is therefore unable to submit an unpatched conversation request.
  const nativeToolFirewall = createNativeToolFirewall();
  await nativeToolFirewall.install(context);
  const page = await context.newPage();
  return { browser, context, page, nativeToolFirewall };
}

/**
 * Run an async fn inside a session, then ALWAYS close the browser.
 * Prefer withSharedSessionScope for the live API server.
 * @param {(opts: {browser, context, page}) => Promise<any>} fn
 * @returns {Promise<any>} whatever fn returns
 */
export async function withSessionScope(fn) {
  const { browser, context, page } = await withSession();
  try {
    return await fn({ browser, context, page });
  } finally {
    await closeBrowserBounded(browser, "scoped browser");
  }
}

/**
 * Verify the current browser context against ChatGPT's authenticated session
 * endpoint. A logged-out ChatGPT page can expose the same composer selector as
 * an authenticated account, so DOM state alone is not sufficient.
 */
export async function hasAuthenticatedSession(page) {
  try {
    const response = await page.request.get("https://chatgpt.com/api/auth/session", {
      failOnStatusCode: false,
      timeout: 10_000,
    });
    if (!response.ok()) return null;
    const session = await response.json();
    return typeof session?.accessToken === "string" && session.accessToken.length > 0;
  } catch {
    return null;
  }
}

/**
 * True when the current page looks like a ChatGPT login / auth wall rather
 * than the logged-in composer. Used to fail fast instead of waiting 150s.
 */
export async function detectAuthExpired(page) {
  const authenticated = await hasAuthenticatedSession(page);
  if (authenticated !== null) return !authenticated;

  try {
    const info = await page.evaluate(() => {
      const href = location.href || "";
      const path = location.pathname || "";
      const text = (document.body?.innerText || "").slice(0, 4000);
      const hasComposer = !!document.querySelector("#prompt-textarea");
      const loginBtn = !!document.querySelector(
        'button[data-testid="login-button"], a[href*="login"], button[data-testid="welcome-login-button"]'
      );
      return { href, path, text, hasComposer, loginBtn };
    });

    if (info.hasComposer) return false;

    if (
      /\/auth\b|\/login\b|\/signin\b|accounts\.google|auth0\.openai/i.test(
        info.href
      )
    ) {
      return true;
    }
    if (info.loginBtn) return true;
    if (
      /\b(log\s*in|sign\s*in|create an account|welcome to chatgpt)\b/i.test(
        info.text
      ) &&
      !info.hasComposer
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Throw a clear, actionable session-expired error. */
export function throwSessionExpired(detail = "") {
  const err = new Error(
    `ChatGPT session expired — re-export ${SESSION_FILE}` +
      (detail ? ` (${detail})` : "")
  );
  err.sessionExpired = true;
  throw err;
}

/**
 * Persist the live browser cookies/localStorage back to SESSION_FILE so
 * rotating session tokens keep the login alive between manual re-exports.
 * Rate-limited to once per minute; failures are non-fatal.
 */
export async function refreshSessionFile(context) {
  if (!REFRESH_SESSION || !context) return false;
  const now = Date.now();
  if (now - lastRefreshAt < REFRESH_MIN_INTERVAL_MS) return false;
  try {
    await context.storageState({ path: SESSION_FILE });
    chmodSync(SESSION_FILE, 0o600);
    lastRefreshAt = now;
    debugLog(`refreshed ${SESSION_FILE}`, "[session]");
    return true;
  } catch (err) {
    debugLog(`refresh failed: ${err.message}`, "[session]");
    return false;
  }
}

/**
 * Run fn against a long-lived shared browser. Serializes access so two
 * OpenCode requests never drive the same page concurrently.
 *
 * Browser recreation inside this scope is only for health checks. Request
 * errors are never replayed here; the server may separately dispose a locked
 * browser only after it proves a safe sibling parent or receives explicit
 * consent for a fresh-chat recovery.
 */
export async function withSharedSessionScope(fn) {
  const generation = sharedGeneration;
  const run = sharedLock.then(async () => {
    if (generation !== sharedGeneration) {
      const err = new Error("ChatGPT browser lease was replaced before use");
      err.cancelled = true;
      err.staleBrowserLease = true;
      throw err;
    }

    // Health check only — never wrap fn in recreate-and-retry.
    if (shared) {
      let healthy = false;
      try {
        healthy = !!(shared.page && !shared.page.isClosed());
      } catch {
        healthy = false;
      }
      if (!healthy) {
        try {
          await closeBrowserBounded(shared.browser, "unhealthy shared browser");
        } catch {
          /* ignore */
        }
        shared = null;
      }
    }

    if (!shared) {
      const fresh = await withSession();
      if (generation !== sharedGeneration) {
        await closeBrowserBounded(fresh.browser, "superseded shared browser");
        const err = new Error("ChatGPT browser lease was replaced during startup");
        err.cancelled = true;
        err.staleBrowserLease = true;
        throw err;
      }
      shared = { ...fresh, busy: false, generation };
    }

    const current = shared;
    try {
      const result = await fn(current);
      if (generation !== sharedGeneration) {
        const err = new Error("ChatGPT browser result arrived from a stale lease");
        err.cancelled = true;
        err.staleBrowserLease = true;
        throw err;
      }
      return result;
    } catch (err) {
      // Drop the shared handle when the browser/page died or auth expired.
      // Do NOT recreate and re-invoke fn (that would re-send after Submit).
      const msg = String(err?.message || err);
      const browserDead =
        /has been closed|Target page|browser has been closed/i.test(msg);
      if (browserDead || err?.sessionExpired) {
        await closeBrowserBounded(current?.browser, "failed shared browser");
        if (shared === current) shared = null;
      }
      throw err;
    }
  });

  // Keep the lock chain alive even when a task fails.
  sharedLock = run.then(
    () => {},
    () => {}
  );
  return run;
}

/**
 * Dispose the serialized browser after a fail-closed firewall lock. Recovery
 * callers must prove a safe branch/fresh-chat strategy before invoking this;
 * this function never retries a request by itself.
 */
export async function resetSharedSession() {
  const current = shared;
  shared = null;
  sharedGeneration += 1;
  // Detach from a wedged owner immediately. Its generation check prevents a
  // late callback from publishing state into the replacement browser.
  sharedLock = Promise.resolve();
  if (!current) return false;
  await closeBrowserBounded(current.browser, "recovery browser");
  return true;
}

/** Close the shared browser (used on process shutdown). */
export async function closeSharedSession() {
  const cur = shared;
  shared = null;
  sharedGeneration += 1;
  sharedLock = Promise.resolve();
  if (!cur) return;
  // Best-effort final cookie flush before exit.
  try {
    if (REFRESH_SESSION) {
      await cur.context.storageState({ path: SESSION_FILE });
      chmodSync(SESSION_FILE, 0o600);
    }
  } catch {
    /* ignore */
  }
  await closeBrowserBounded(cur.browser, "shutdown browser");
}

export { SESSION_FILE, HEADED, REFRESH_SESSION };
