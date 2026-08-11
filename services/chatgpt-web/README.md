# Native ChatGPT Web provider

This package embeds the logged-in ChatGPT web-session bridge directly inside
OpenCode. It implements AI SDK `LanguageModelV3`, so OpenCode calls it like any
other bundled provider—there is no localhost API, systemd service, or
OpenAI-compatible provider shim in the native path.

```text
OpenCode session
  -> built-in chatgpt-web provider
  -> in-process serialized browser runtime
  -> Playwright + saved ChatGPT storageState
  -> chatgpt.com
```

The original HTTP routes remain available as a compatibility/debug runtime,
but normal OpenCode use never starts them.

## Built-in models

- `chatgpt-web/gpt` (Sol High alias)
- `chatgpt-web/gpt-5.6-sol-high`
- `chatgpt-web/gpt-5.6-sol-medium`
- `chatgpt-web/gpt-5.6-sol-instant`

The model id controls the ChatGPT Intelligence picker. A request fails when
`STRICT_MODEL_SELECTION=1` and the selected model/effort cannot be verified;
otherwise provider metadata reports `selectionVerified: false`. The picker
adapter supports both the legacy direct radio list and ChatGPT's nested Model
and Effort submenus, including the current thread-overlay click fallback.

## Private runtime data

Native state lives outside the repository:

```text
~/.local/share/opencode/chatgpt-web/
├── .env                 # optional private runtime settings
├── session.json         # Playwright storageState; equivalent to a login
└── conversations.json   # persisted OpenCode-history -> ChatGPT-chat map
```

`XDG_DATA_HOME` is honored. `CHATGPT_WEB_DATA_DIR`,
`CHATGPT_WEB_SESSION_FILE`, and `CHATGPT_WEB_CONVERSATION_FILE` override these
paths. Never commit or share `session.json`.

To migrate an existing `chatgpt-local-api` session:

```bash
install -d -m 700 ~/.local/share/opencode/chatgpt-web
cp /path/to/chatgpt-local-api/auth/session.json ~/.local/share/opencode/chatgpt-web/session.json
cp /path/to/chatgpt-local-api/auth/conversations.json ~/.local/share/opencode/chatgpt-web/conversations.json
chmod 600 ~/.local/share/opencode/chatgpt-web/session.json ~/.local/share/opencode/chatgpt-web/conversations.json
```

For a fresh interactive capture, install the matching Chromium revision and
run the export helper from the fork:

```bash
bunx playwright install chromium
HEADED=1 bun run --cwd packages/chatgpt-web export-session
```

## OpenCode configuration

The provider and models are built in, so only the model setting is required:

```jsonc
{
  "model": "chatgpt-web/gpt-5.6-sol-high",
  "small_model": "chatgpt-web/gpt-5.6-sol-high"
}
```

Runtime settings can live in
`~/.local/share/opencode/chatgpt-web/.env` (copy `.env.example`) or in native
provider options:

```jsonc
{
  "provider": {
    "chatgpt-web": {
      "options": {
        "runtime": {
          "backend": "playwright",
          "headed": false,
          "persistChat": true,
          "liveStream": true,
          "cooldownMs": 5000,
          "rateLimitBackoffMs": 90000,
          "rateLimitMinBackoffMs": 30000,
          "rateLimitMaxBackoffMs": 900000,
          "turnHardCapMs": 1200000,
          "rawPostcheckTimeoutMs": 30000,
          "strictModelSelection": false
        }
      }
    }
  }
}
```

Provider options take precedence over process environment and the private
`.env`. The `.env` is loaded from the provider data directory, never from the
current project, so a repository's own `.env` cannot silently reconfigure the
browser runtime.

## Image input

All built-in `chatgpt-web` models accept PNG, JPEG, GIF, and WebP images. In
the terminal UI, copy an image or screenshot and press `Ctrl+V`; OpenCode shows
an `[Image N]` marker, briefly confirms the attachment, and sends the image
with the prompt. Multiple pasted images are uploaded together. If a terminal
consumes image-only `Ctrl+V`, use `<leader>v` (`Ctrl+X`, then `V`) to invoke
OpenCode's clipboard reader directly. The web and desktop clients use the same
native provider path for their existing image attachments.

On WSL, the TUI resolves Windows PowerShell through `wslpath`, including when
`appendWindowsPath = false`, and reports clipboard failures instead of silently
ignoring them. Image bytes are passed to Playwright in memory and uploaded
through ChatGPT's composer; they are never flattened into the text/tool protocol
or written to the native conversation map. OpenCode's normal session storage
still retains the prompt attachment. PDFs and other non-image files are not
supported by this provider.

## Native behavior retained from the bridge

- one serialized shared browser session with adaptive cooldown. Rate limits are
  detected from short assistant banners, rendered failed-turn cards, and
  rejected ChatGPT conversation responses (including HTTP 429). The active
  OpenCode turn waits cancellably and retries for as long as the limit remains,
  branching from the verified pre-send parent when available or using a clean
  fresh chat when it is not;
- in-memory ChatGPT composer uploads for image prompts, with delta-only image
  submission on persisted chats and content-digest conversation matching;
- one persisted ChatGPT chat per matching OpenCode history, with delta-only
  continuation, transactional mapping replacement, and bounded compact
  recovery;
- bounded contenteditable composer fills for ordinary and compact recovery
  prompts, preventing a stalled keyboard insertion from hanging before Send;
- strict, whole-reply tool parsing with allowlisting and Ajv schema validation:
  JSON `TOOL_CALL` for structured tools and a quote-safe line-based
  `SHELL_CALL` envelope for bash/SSH;
- an action-aware execution boundary that requires category-compatible
  OpenCode proof for host, SSH, filesystem, current-web, and configured-service
  actions before accepting a final answer. Filesystem reads, shell validation
  or tests, and edit tools are all accepted as intermediate steps; completed
  results still need to prove the requested mutation/compilation before the
  policy is satisfied;
- explicit filesystem coverage for local documents, LaTeX/PDF work, and direct
  Windows/WSL/POSIX path checks, with proof required again after each new user
  action rather than inherited from an older turn;
- a browser-context request firewall installed before any page exists. Each
  turn refreshes the authenticated model/app inventory, blocks external app
  links, patches prepare and completion JSON with dynamic feature/tool deny
  lists, and appends ChatGPT's server-validated hidden tool opt-out after the
  user prompt. The `memory` feature and `bio` tool are always included even
  when the model inventory does not advertise memory, matching the live web
  client's separate memory control. Unknown transports, payload drift, and
  duplicate sends fail before another prompt can leave Chromium;
- mandatory authenticated raw-turn inspection for ChatGPT-native
  `container`, `python`, `file_search`, browser, connector, or similar tools.
  An exact finished `api_tool.list_resources` or `api_tool.search_tools`
  assistant call with one marker-free, finished text result authored by
  `api_tool` is classified as discovery-only. Its final raw assistant reply is
  accepted and its cursor is committed without locking the provider. No native
  result is accepted as evidence about the OpenCode host. A matched `bio`
  call/result pair is classified as confirmed side-effect-free only when its
  authenticated raw result has the exact `memory_disabled` failure reason;
  missing or unknown outcomes remain side-effect-capable. `api_tool.call_tool`,
  execution identifiers, unmatched/incomplete discovery nodes, and all other
  native recipients remain blocked. Exact child aliases are still
  transport-disabled alongside connector ids;
- hidden connector-link context prompts authored as `api_tool` are not treated
  as executions only when they are direct children of the UUID-bound user
  turn, hidden, text-only, addressed to `all`, marked `command=prompt`, match
  the `connector_link_*_prompt` family, carry no execution/result identifiers,
  and have no assistant native recipient; near-matches remain blocked;
- execution-ledger checks for local build claims;
- Google Docs, SSH/remote-probe, and local-file hallucination guards;
- conservative handoff intent detection and recovery prompts that never invent
  a filesystem target;
- clarifying questions pass through instead of being replaced by tool nudges;
- plan-only asks (`lets plan this first`, `don't implement yet`, …) remain
  tool-free, while unverified claims about ChatGPT's environment are rewritten;
- shell calls use `SHELL_CALL`, `PURPOSE`, optional `WORKDIR` / `TIMEOUT_MS`,
  and a final raw `COMMAND` field that may span physical lines, so renderer
  wrapping, nested quotes, `%`, and backslashes never pass through JSON string
  escaping;
- every reply is rebound to the exact assistant message in ChatGPT's
  authenticated conversation source, so ordinary Markdown and tool envelopes
  preserve code fences, LaTeX, and backslashes instead of accepting rendered
  DOM transformations. An empty terminal node can resolve to the newest usable
  raw assistant text after the pre-send boundary. Resolution also binds to the
  user-message UUID captured from the patched outbound request and polls for a
  bounded raw-graph synchronization window; unavailable raw ancestry remains
  terminal and never falls back to DOM;
- the page and browser-context raw readers race under bounded pre-send and
  post-delivery deadlines. A blank rendered-thread hydration spinner cannot
  quarantine a clean persisted chat when the context reader still verifies its
  saved cursor. Each reader retries transient auth-session/token acquisition
  failures for that entire window. When no submitted turn awaits adoption,
  ordinary continuation and explicit recovery retain the last verified cursor
  as the sibling parent even when the failed audit could not rediscover it; a
  send from this exact branch remains subject to mandatory raw post-checking.
  One 20-minute active-generation budget is shared by the initial send,
  cooldown, and correction/recovery attempts. A confirmed rate-limit wait
  pauses that budget, keeps the turn cancellable, and resumes a fresh budget
  window for the next guarded attempt, so a multi-window account limit cannot
  brick the OpenCode session;
- provider metadata reports `nativeToolSuppression`, `memorySuppression`,
  disabled feature/tool counts, `appPreflight`, `nativeToolInspection`,
  `nativeToolRisk`, `rawNodeClass`, `rawAuditReason`, `deliveryState`, recovery
  stage/attempt/parent verification, `rateLimitRetries`, `rateLimitWaitMs`,
  `rateLimitSource`, and `replySource`. Tool names
  are sanitized and never include commands, outputs, conversation contents, or
  credentials. Successful replies report `replySource: raw-conversation`;
- bash/shell `command` values over ~4096 chars are rejected so mega remote
  audits must be split across turns (`BASH_COMMAND_MAX` overrides);
- malformed tool requests get error-specific hints and a copy-paste
  `SHELL_CALL` example; if the in-chat
  nudge still fails, the harness escalates once in a fresh ChatGPT chat;
- before giving up on harness rejections (malformed TOOL_CALL, fake
  deliverables), one rejection-specific correction is posted into the current
  ChatGPT chat;
- correction recovery for malformed OpenCode envelopes remains capped at three
  model replies and fresh-chat packets stay below 32k characters. The clean raw
  cursor is stored after every successful turn and audited before the next
  Send. Exact discovery-only replies are accepted directly. Older persisted
  discovery-only, clean-drift, or confirmed-no-side-effect quarantines resume
  automatically once per provider request regardless of their historical
  attempt counter, using a verified sibling or bounded clean compact chat.
  Side-effect-capable or unverifiable activity is quarantined until the user
  types `retry`; an explicitly authorized recovery with no safe parent uses a
  fresh ChatGPT chat. When the rejected turn yielded a complete captured
  assistant reply, `allow reply` discloses it once as explicitly unverified,
  inert text without executing tool envelopes or reusing the contaminated
  branch. The capture is process-memory-only, expires after 30 minutes by
  default, and is never persisted or logged. `retry fresh` (or
  `recover fresh`) always selects a compact fresh chat and carries the OpenCode
  execution ledger so already successful mutations are not repeated. Repeated
  retry failures and changed system/MCP preambles are rebound only through one
  unique persisted hashed stable-anchor prefix of user turns and tool-call
  structures; provider-normalized plain assistant prose is excluded. Recovery controls are removed from
  model intent, including one matching shell/PTTY-added quote pair, and the 32k
  compact cap remains mandatory. Explicit recovery can also
  rebind a legacy mapping after a changed system/MCP preamble, but only when
  the complete non-system history has one unique prefix match;
- quarantine failures expose the stable
  `chatgpt_web_native_activity_quarantine` code and a bounded recovery-action
  list. `continue anyway` still passes through ordinary OpenCode envelope,
  permission, and action-policy checks; once validated, the latched shared
  browser is disposed before the tool call is returned so its tool-result
  follow-up starts with a clean firewall;
- Playwright/provider exception text passes through a final redaction boundary
  before diagnostics, status history, or LanguageModelV3 errors. Authorization,
  cookie, set-cookie, token, and bearer values are stripped, long diagnostics
  are bounded, and causes/response headers are never copied across the provider
  boundary;
- up to 32 OpenCode-to-ChatGPT mappings are retained by default
  (`PERSIST_MAX_CHATS` overrides);
- raw-authoritative buffered answer emission, live thinking events,
  cancellation propagation, stall detection, and session-cookie refresh;
- tool choice follows only the caller's explicit contract: `auto` or omitted
  accepts text or any valid advertised tool call, `none` rejects calls,
  `required` accepts any advertised tool, and a named choice accepts only that
  exact tool. Prompt wording and service names never promote `auto` to a
  required or preferred tool;
- the TUI busy footer shows provider phases, elapsed time, and a live
  rate-limit retry countdown. While busy it suppresses unrelated shortcut hints
  and clips long status text to one row so it cannot wrap over the input area
  on narrow terminals;
- routine `[server]` / conversation-store info logs are silent unless
  `DEBUG=1` (stderr only), so they do not paint over the OpenCode TUI input bar.

The native provider deliberately omits the HTTP idempotency layer: there is no
lost localhost response for a client to replay. Errors after the ChatGPT Send
button are not blindly retried by the shared browser. A confirmed rate-limit
rejection is safe to retry from the verified pre-send parent; other submitted
errors still require the existing raw-graph safety proof or explicit recovery
consent.

## Development checks

From `packages/chatgpt-web`:

```bash
npm test
```

From `packages/opencode`, use the focused integration gate:

```bash
bun run test:native-provider
```

Do not use whole-monorepo `bun typecheck` as the routine provider gate on this
WSL installation; it is intentionally optional because it is resource-heavy.
The release build is the authoritative compile check:

```bash
OPENCODE_CHANNEL=native-chatgpt OPENCODE_VERSION=1.17.18 \
  ./packages/opencode/script/build.ts --single --skip-install
```

To run both focused gates, build a timestamped release with provenance, and
atomically update `~/.local/lib/opencode-custom/current`:

```bash
bun run install:native-chatgpt
```

## Optional HTTP compatibility runtime

The old API remains useful for curl-level diagnostics:

```bash
DRY_RUN=0 bun run --cwd packages/chatgpt-web start
curl http://127.0.0.1:8787/health
```

It exposes `GET /`, `GET /health`, `POST /cancel`, `POST /chat`, and
`POST /v1/chat/completions`. Keep it bound to `127.0.0.1`; these routes have no
authentication. `DRY_RUN` applies only to this HTTP entrypoint—the explicitly
selected native provider is live.

## Limitations

- Browser automation is slower and more UI-sensitive than an official API.
- The direct backend usually fails because ChatGPT requires browser-generated
  proof/sentinel tokens; `BACKEND=playwright` is the supported default.
- ChatGPT cookies expire and UI selectors can change.
- Image upload depends on ChatGPT's composer file input and may require a
  selector update if that UI changes.
- This automates the account's logged-in web session. Keep the runtime private
  and make sure this usage is acceptable for the account.
