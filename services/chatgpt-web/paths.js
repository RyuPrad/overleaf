import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import "./env.js";

const xdg = process.env.XDG_DATA_HOME?.trim();
const root = process.env.CHATGPT_WEB_DATA_DIR?.trim();

export const DATA_DIR = resolve(
  root || join(xdg || join(homedir(), ".local", "share"), "opencode", "chatgpt-web")
);

function configured(value, fallback) {
  const input = String(value || "").trim();
  if (!input) return fallback;
  return isAbsolute(input) ? input : resolve(input);
}

export const DEFAULT_SESSION_FILE = configured(
  process.env.CHATGPT_WEB_SESSION_FILE || process.env.SESSION_FILE,
  join(DATA_DIR, "session.json")
);

export const DEFAULT_CONVERSATION_FILE = configured(
  process.env.CHATGPT_WEB_CONVERSATION_FILE || process.env.PERSIST_STORE_FILE,
  join(DATA_DIR, "conversations.json")
);
