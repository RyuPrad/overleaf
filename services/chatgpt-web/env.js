import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { config } from "dotenv";

const xdg = process.env.XDG_DATA_HOME?.trim();
const configuredDataDir = process.env.CHATGPT_WEB_DATA_DIR?.trim();
const dataDir = resolve(
  configuredDataDir || join(xdg || join(homedir(), ".local", "share"), "opencode", "chatgpt-web"),
);
const configuredEnvFile = process.env.CHATGPT_WEB_ENV_FILE?.trim();

export const ENV_FILE = configuredEnvFile
  ? isAbsolute(configuredEnvFile)
    ? configuredEnvFile
    : resolve(configuredEnvFile)
  : join(dataDir, ".env");

// Native OpenCode runs inside arbitrary project directories. Never load that
// project's .env implicitly; only load the provider's private config file.
config({ path: ENV_FILE });
