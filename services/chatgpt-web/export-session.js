// export-session.js
// Captures the current logged-in ChatGPT session into a Playwright
// private storageState JSON file, so the native provider / compatibility
// server can launch a browser that's already authenticated — no login flow.
//
// HOW IT WORKS:
//   This script expects you to be ALREADY logged into chatgpt.com in the
//   Playwright MCP browser (the one this project drives). It opens chatgpt.com
//   in a fresh Playwright browser, waits for the auth to be present, and saves
//   the cookies + localStorage via context.storageState().
//
//   In practice the EASIEST way to create the first session.json is:
//     1. Log into chatgpt.com in the Playwright MCP browser (Google OAuth, etc.)
//     2. Use the MCP `browser` tools to call storageState on that live context,
//        OR run this script after logging in via a HEADED window.
//
//   This file supports the scripted path. For the MCP-driven first capture,
//   see the README ("First-time setup") — that's the path used during bootstrap.

import { chromium } from "playwright";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_SESSION_FILE } from "./paths.js";
import { hasAuthenticatedSession } from "./session.js";

const flag = (v) => String(v ?? "").trim();
const HEADED = flag(process.env.HEADED) === "1";
const OUT = DEFAULT_SESSION_FILE;

async function main() {
  console.log("[export-session] Launching browser…");
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  console.log("[export-session] Opening chatgpt.com — please log in if prompted…");
  await page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded" });

  // Logged-out ChatGPT currently exposes a composer too. Require the account
  // session endpoint to return a real access token before saving any state.
  console.log("[export-session] Waiting for authenticated state (up to 5 min)…");
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline && (await hasAuthenticatedSession(page)) !== true) {
    if (page.isClosed()) break;
    await page.waitForTimeout(1000);
  }
  if ((await hasAuthenticatedSession(page)) !== true) {
    console.error(
      "[export-session] Timed out waiting for login. Re-run after logging in (HEADED=1 helps)."
    );
    await browser.close();
    process.exit(1);
  }

  const state = await context.storageState();

  const directory = dirname(OUT);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(OUT, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(OUT, 0o600);

  const cookieCount = state.cookies?.length ?? 0;
  console.log(`[export-session] ✅ Saved session to ${OUT} (${cookieCount} cookies).`);
  console.log("[export-session] You can now run `npm start`.");
  await browser.close();
}

main().catch((err) => {
  console.error("[export-session] ❌", err);
  process.exit(1);
});
