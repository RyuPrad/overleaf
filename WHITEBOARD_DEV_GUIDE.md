# Overleaf Whiteboard Development Guide

## Using the App — No Coding Required

This section is for someone who just wants to **use the customized Overleaf app normally**. You do not need to know Git, Docker, WSL, or programming for the steps below.

### 1. Start Overleaf

On Windows, open the existing launcher:

`C:\Users\ryupr\AppData\Local\OverleafLauncher\launch-overleaf.vbs`

After it starts, open your web browser and go to:

`http://localhost/project`

That is your local Overleaf website.

### 2. Open or create a project

Use Overleaf like a normal document editor:

1. Open an existing project, or create a new one.
2. Use `.tex` files for normal LaTeX writing.
3. Click **Recompile** to update the PDF preview.
4. Your files and project stay inside your local Overleaf installation.

You do not need to open a terminal just to write documents or use the whiteboard.

### 3. Create a whiteboard

Inside a project:

1. Create a new file.
2. Give it a name ending in `.tldraw`, for example `notes.tldraw` or `diagram.tldraw`.
3. Click the new `.tldraw` file in the file list.
4. Overleaf will open the drawing canvas instead of the normal text editor.

The `.tldraw` ending is what tells this customized Overleaf to treat the file as a whiteboard.

### 4. Use the whiteboard

You can use it like a normal drawing/whiteboard app. For example, you can:

- draw freehand
- add shapes
- add text
- move and resize objects
- select and delete objects
- zoom and pan around the canvas
- switch between the whiteboard and your normal `.tex` files

You should not need to manually save the whiteboard. Changes are stored through Overleaf as you work.

### 5. Come back to a whiteboard later

Just open the same project and click the same `.tldraw` file again. The saved drawing should load back onto the canvas.

You can also switch to another file and return to the whiteboard without losing your work.

### 6. Use the whiteboard together with LaTeX

A simple way to use this project is:

1. Write your paper, homework, notes, or report in normal `.tex` files.
2. Keep diagrams, brainstorming, rough sketches, and planning in one or more `.tldraw` files in the same project.
3. Switch between the document and whiteboard from the file list on the left.

The whiteboard does not replace LaTeX; it is an extra file type inside the same Overleaf project.

### 7. Use the Whiteboard Assistant

When a `.tldraw` file is open, select the **Assistant** tab in the right rail.
The Assistant can propose structured whiteboard edits and can optionally edit one
linked `.tex` file. Choose **Suggest** to preview and accept a draft, or **Direct**
for non-destructive changes to apply immediately. Deletions and substantial TeX
removals are always forced back to Suggest mode. Applied transactions have an
**Undo** action, which refuses to run if a collaborator changed an affected shape
or the linked TeX content afterward.

Use the chat picker at the top of the Assistant to switch between saved chat
histories. **New Chat** creates a separate history and inherits the current
Suggest/Direct mode and linked TeX file. The first successful prompt becomes the
chat title; use the chat menu to rename or delete it. The selected chat is
remembered separately for each project and whiteboard in the current browser.
Chat histories are shared with project collaborators who can read the board.

To refer to a project file in a prompt, type `@` in the message box. Continue
typing to filter by filename or folder path, then choose a result with the mouse
or with **Up/Down** and **Enter/Tab**. **Escape** closes the picker. Chosen files
appear above the message as removable chips, and up to 20 files can be included
in one request. Editable project documents send their current text as prioritized
read-only context. Uploaded files such as images and PDFs can also be selected,
but currently contribute their project path and metadata only. An `@` reference
does not make a file writable; only the separately selected linked `.tex` file
can be edited by an Assistant transaction.

Assistant-created worked solutions are normalized before they reach tldraw.
Visible escaped line-break tokens are converted into real rich-text paragraphs,
and long or multiline text receives a bounded width instead of expanding into an
unreadable single line. During document replay, the compatibility path also
recognizes the narrow auto-sized records produced by the earlier bug, repairs
their paragraphs, and spaces consecutive blocks vertically. Reopening an
affected board is enough to display the repaired layout; the original document
history is not destructively rewritten.

The Assistant reuses the authenticated ChatGPT-Web session maintained by the
custom OpenCode installation. Authentication is mounted read-only into the
Overleaf sidecar, while Overleaf keeps its own conversation map under the
toolkit data directory. Deleting an Overleaf chat forgets only its local history
and mapping; it does not delete the corresponding chat from the ChatGPT account
or undo board/TeX changes that were already applied.

### 8. If the app does not open

First try these simple steps:

1. Make sure the launcher was opened.
2. Wait until the local Overleaf services have started.
3. Refresh `http://localhost/project` in your browser.
4. If it still does not work, ask an AI coding assistant to check the local Overleaf services for you.

You can say:

> My local Overleaf at `http://localhost/project` is not working. Please read `/root/src/overleaf-whiteboard/WHITEBOARD_DEV_GUIDE.md`, check the running services and logs, explain what is wrong in simple language, and do not delete or reset anything unless I approve it.

### 9. If a whiteboard does not open correctly

Do not edit the raw contents of the `.tldraw` file yourself. Instead, ask an AI assistant to inspect the problem.

For example:

> My `.tldraw` whiteboard is not loading correctly in local Overleaf. Please diagnose it without deleting the board or changing its saved data unless necessary.

### 10. Things a normal user does not need to touch

For everyday use, you can ignore:

- Git and GitHub branches
- Docker commands
- WSL commands
- source-code files
- build commands
- the internal JSON stored inside `.tldraw` documents

Those are only needed when developing or repairing the app.

---

## Start Here — Beginner Guide

If you are new to this project, you do **not** need to understand the whole Overleaf codebase before working on the whiteboard. Use this document as your map and follow this order whenever you come back to the project.

### 1. Start the local Overleaf

The easiest way on your Windows machine is to use the existing launcher:

`C:\Users\ryupr\AppData\Local\OverleafLauncher\launch-overleaf.vbs`

That launcher starts the Docker-based Overleaf environment inside WSL. After it starts, open:

`http://localhost/project`

If you are working directly inside WSL instead, the equivalent command is:

```bash
cd /root/overleaf-toolkit
bin/up -d
```

You normally do **not** need to rebuild Docker images just to open and use the current whiteboard version.

### 2. Know the two important folders

Most work happens in only these two places:

- `/root/src/overleaf-whiteboard` — the Overleaf source code and whiteboard implementation.
- `/root/overleaf-toolkit` — the local Docker/runtime setup used to launch your customized Overleaf.

If you ask an AI coding agent to work on the whiteboard, tell it to work from:

`/root/src/overleaf-whiteboard`

and to read this guide before changing anything.

### 3. Check the project before making changes

Before editing code, run or ask the AI agent to run:

```bash
cd /root/src/overleaf-whiteboard
git status --short
git branch --show-current
git log -5 --oneline --decorate
git remote -v
docker ps
```

The expected development branch is:

`feature/overleaf-whiteboard`

Your writable GitHub remote is named `fork`. The `origin` remote belongs to the main Overleaf project and should normally be treated as read-only.

### 4. Where the whiteboard code lives

For most whiteboard changes, start with these files:

- `services/web/frontend/js/features/ide-react/components/editor/tldraw-editor.tsx` — the actual tldraw whiteboard, persistence, collaboration, and read-only behavior.
- `services/web/frontend/js/features/ide-react/components/layout/editor.tsx` — decides when Overleaf opens the whiteboard instead of the normal text editor.
- `services/web/config/settings.defaults.js` — tells Overleaf that `.tldraw` files are editable documents.
- `services/web/package.json` — contains the tldraw dependencies.

If your change is about drawing behavior, collaboration, persistence, or loading a board, `tldraw-editor.tsx` is usually the first file to inspect.

### 5. How to test your changes

For a simple manual test:

1. Open your local Overleaf project.
2. Create or open a file ending in `.tldraw`, for example `board.tldraw`.
3. Draw shapes or text.
4. Open another file and return to the whiteboard.
5. Reload the browser and check that the drawing still exists.
6. If testing collaboration, open the same project in a second browser/session and verify changes appear in both.

If something fails, first check:

```bash
docker logs --since 10m sharelatex 2>&1 | grep -Ei 'error|exception|fatal|whiteboard|tldraw'
```

### 6. When you actually need to rebuild

Normal source inspection does not require a rebuild. A production Docker rebuild is mainly needed when you want to test new frontend code in the real deployed local Overleaf image.

The Community image is built from:

```bash
cd /root/src/overleaf-whiteboard/server-ce
make build-community
```

Then rebuild the local no-auth wrapper:

```bash
cd /root/overleaf-toolkit/local-noauth
docker build --progress=plain -t local/overleaf-noauth:6.2.2 .
```

Then restart the local stack:

```bash
cd /root/overleaf-toolkit
bin/up -d
```

The Community build is large and can use a lot of memory, so do not run it unnecessarily.

### 7. How to save your work to GitHub

After changes are tested:

```bash
cd /root/src/overleaf-whiteboard
git status
git diff --check
git add <files-you-changed>
git commit -m "Describe the change"
git push fork feature/overleaf-whiteboard
```

Do not push to `origin` unless your GitHub permissions change.

### 8. How to ask an AI agent for help

A useful starting prompt is:

> Work on the Overleaf whiteboard project in `/root/src/overleaf-whiteboard`. Read `WHITEBOARD_DEV_GUIDE.md` first. Check git status, the current branch, recent commits, and running Docker containers before changing anything. Preserve unrelated changes. Implement and verify the requested change end to end, and push only if I explicitly ask you to.

You can then add your specific request, for example:

> Add support for inserting LaTeX equations as structured whiteboard objects.

or:

> Investigate why whiteboard changes from a second browser are not appearing immediately. Diagnose first; do not change code until the cause is clear.

### 9. What you should avoid as a beginner

Avoid these unless you specifically know why they are needed:

- Do not run destructive Git commands such as `git reset --hard`.
- Do not delete Docker volumes or Mongo data just to fix a frontend issue.
- Do not reinstall or upgrade large dependency trees without a reason.
- Do not push directly to the upstream `origin` repository.
- Do not change the `.tldraw` persistence format casually; existing boards depend on it.
- Do not rebuild the full Community image for every tiny investigation.

If you are unsure, ask the AI agent to **inspect and explain first**, then make the smallest necessary change.

---

This document is the machine-specific technical guide for the local Overleaf whiteboard development environment. It is intended to be useful both to a human developer and to future AI coding agents working on this machine.

## Project Summary

This branch adds collaborative `.tldraw` whiteboards to the Overleaf editor by treating `.tldraw` as an editable document type and rendering a tldraw canvas instead of the normal source editor when such a document is opened.

The whiteboard state is persisted inside the Overleaf document as newline-delimited JSON diff or snapshot records. This lets the implementation reuse Overleaf's existing document storage, realtime collaboration, permissions, and history mechanisms. AI threads and transaction metadata are stored separately in MongoDB so they are shared by project collaborators.

## Git Repositories

### Overleaf source repository

- Local path: `/root/src/overleaf-whiteboard`
- Current feature branch: `feature/overleaf-whiteboard`
- Development base commit: `9fde2052b2e21fd79a9b8c30dab97a1ef6663875`
- Whiteboard/Assistant implementation commit: `0d62c4684aa9ebfbb613ce67365a44bb80a45140`
- Upstream remote: `origin -> https://github.com/overleaf/overleaf.git`
- Writable fork remote: `fork -> https://github.com/RyuPrad/overleaf.git`
- Pushed branch: `fork/feature/overleaf-whiteboard`

The upstream `origin` is read-only for this account. Push feature work to `fork`, not `origin`.

### Overleaf Toolkit

- Local path: `/root/overleaf-toolkit`
- Local configuration: `/root/overleaf-toolkit/config/overleaf.rc` and
  `/root/overleaf-toolkit/config/variables.env`
- Local authentication overlay: `/root/overleaf-toolkit/local-noauth`

The toolkit runs the locally built Overleaf image and supporting MongoDB/Redis containers.

## Local Runtime

The current local stack is:

- `sharelatex` -> image `local/overleaf-noauth:6.2.2`
- `mongo` -> image `mongo:8.0`
- `redis` -> image `redis:7.4`
- `chatgpt-web-overleaf` -> image `local/overleaf-chatgpt-web:1`
- Overleaf HTTP endpoint -> `http://127.0.0.1`
- Host binding -> `127.0.0.1:80 -> sharelatex:80`

The no-auth image is intentionally local-development-only. Do not use it in production.

## Important Files

### Whiteboard editor

`services/web/frontend/js/features/ide-react/components/editor/tldraw-editor.tsx`

Responsibilities:

- Creates a tldraw `TLStore`.
- Loads `.tldraw` document contents from Overleaf's current document snapshot.
- Replays newline-delimited persisted tldraw diffs into the store.
- Listens for user-originated tldraw store changes.
- Batches local changes for a short interval and appends them to the Overleaf document as JSON diff lines.
- Listens for Overleaf remote operations and reconciles the tldraw store from the canonical document snapshot.
- Respects Overleaf write permissions by switching tldraw to read-only mode when needed.
- Shows a read-only error banner when persisted whiteboard data is invalid or unsupported.
- Registers safe structured LaTeX and function-plot shape types.
- Applies, previews, and conflict-checks Assistant transactions.
- Supports explicit lossless TikZ export/import.

Current persistence constants:

- Format: `overleaf-tldraw-diff`
- Version: `2` (version 1 diffs remain readable)
- Snapshot format: `overleaf-tldraw-snapshot`
- Local batching delay: `120 ms`

Additional implementation areas:

- `services/web/frontend/js/features/whiteboard/` — persistence, custom shapes,
  safe math parsing, TikZ, scene actions, Assistant UI, and the active-board bridge.
- `services/web/app/src/Features/WhiteboardAi/` — authenticated multi-session,
  proposal, explicit file-reference context, commit, reject, delete, rename,
  and undo APIs, with scoped JSON 4xx handling for validation and conflicts.
- `services/web/frontend/js/features/whiteboard/assistant/file-mentions.ts` —
  project-file flattening, `@` query detection, filtering, and mention insertion.
- `services/web/frontend/js/features/whiteboard/text-shape-normalization.ts` —
  readable Assistant text widths, escaped-line-break conversion, and narrowly
  scoped replay/reflow compatibility for malformed legacy Assistant shapes.
- `services/chatgpt-web/` — isolated browser-session sidecar runtime.
- `/root/overleaf-toolkit/doc/whiteboard-ai.md` — deployment and shared-auth guide.

### Editor routing

`services/web/frontend/js/features/ide-react/components/layout/editor.tsx`

The editor checks whether the open document name ends with `.tldraw`. If so, it renders `TldrawEditor` instead of `SourceEditor`. The symbol palette is also hidden for whiteboard documents.

### Editable extension registration

`services/web/config/settings.defaults.js`

`.tldraw` is added to `defaultTextExtensions`. This makes Overleaf treat `.tldraw` files as editable documents rather than binary file references.

### Dependencies

`services/web/package.json`

Added dependencies:

- `tldraw: 4.2.0`
- `@tldraw/assets: 4.2.0`

`yarn.lock` contains the resolved tldraw dependency graph.

## Whiteboard Persistence Format

Most lines of a `.tldraw` Overleaf document are JSON diff objects with this structure:

```json
{
  "format": "overleaf-tldraw-diff",
  "version": 2,
  "added": [],
  "updated": [],
  "removed": []
}
```

Version 2 diffs may also carry `transactionId` and `source` metadata. Periodic
`overleaf-tldraw-snapshot` records compact long histories. The implementation
reconstructs the document by:

1. Creating the required tldraw document and default page records.
2. Parsing each non-empty line.
3. Validating the format/version.
4. Normalizing only recognized malformed legacy Assistant text records.
5. Applying added and updated records.
6. Removing deleted record IDs.

This format maps naturally onto Overleaf text operations and realtime collaboration while bounded compaction prevents indefinite append-only growth.

## Local Build Workflow

Run the Community image build from:

`/root/src/overleaf-whiteboard/server-ce`

Preferred reproducible command:

```bash
cd /root/overleaf-toolkit
bin/build-whiteboard
```

This builds the Community image from the configured source, the local no-auth
wrapper, and the private ChatGPT-Web sidecar image. The lower-level
`make build-community` command remains available from `server-ce`.

During the successful build, webpack minifier parallelism was temporarily disabled to work around local memory pressure, then the webpack config was restored. There is no intentional webpack-config change in the whiteboard commit.

If a future build is killed during JS/CSS minification, first suspect local memory pressure rather than a source error.

## Local No-Auth Image

Directory:

`/root/overleaf-toolkit/local-noauth`

Files:

- `Dockerfile`
- `AuthenticationController.mjs`

The local wrapper image is built from the custom Overleaf Community image and replaces authentication behavior for local development.

Build command used successfully:

```bash
cd /root/overleaf-toolkit/local-noauth
docker build --progress=plain -t local/overleaf-noauth:6.2.2 .
```

## Starting the Local Stack

From:

`/root/overleaf-toolkit`

Start with:

```bash
bin/up -d
```

If the first startup attempt reports a temporary Mongo connection refusal while the replica set is initializing, check container status and retry after Mongo becomes healthy.

Useful status command:

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
```

Expected services:

- `sharelatex`
- `mongo`
- `redis`
- `chatgpt-web-overleaf`

## Useful Verification Commands

### Check the app responds

```bash
curl -fsS http://127.0.0.1/
```

### Inspect recent Overleaf logs

```bash
docker logs --since 10m sharelatex
```

### Search specifically for whiteboard errors

```bash
docker logs --since 10m sharelatex 2>&1 | grep -Ei 'error|exception|fatal|whiteboard|tldraw'
```

### Confirm `.tldraw` is exposed as editable

Load an Overleaf project page and inspect the `ol-ExposedSettings` metadata. The `textExtensions` array should contain `tldraw`.

### Confirm the deployed bundle contains whiteboard code

```bash
docker exec sharelatex bash -lc \
  "grep -RIl 'overleaf-tldraw-diff' /overleaf/services/web/public/js 2>/dev/null"
```

## Verified End-to-End Behavior

The following was verified against the running local instance:

- Production Community image build succeeds.
- Local no-auth image builds successfully.
- The sidecar image builds, starts healthy, enforces GPT-5.6 Sol / High, and
  has no host port.
- Overleaf, the sidecar, MongoDB, and Redis run successfully.
- `.tldraw` appears in exposed editable text extensions.
- The deployed IDE bundle contains the whiteboard implementation.
- A real `.tldraw` document opens as a tldraw canvas without browser-console
  errors, including compatibility with the original persisted format.
- The Assistant rail opens and its authenticated per-board session APIs return
  200/201 for list, create, get, rename, and delete operations.
- Two live Assistant sessions receive distinct ChatGPT conversation URLs; a
  follow-up reuses the selected session's URL and retains its earlier context.
- The Assistant composer offers an accessible, keyboard-navigable project-file
  picker after `@`; selected editable documents are prioritized as read-only AI
  context and uploaded files are identified without claiming their contents were
  inspected.
- The previously applied Question 13 transaction with 15 literal `\n` tokens
  replays as three bounded multiline text blocks. Browser geometry checks report
  positive gaps between every block, and the rendered board has no console
  errors.
- Session-to-conversation mappings survive a sidecar restart, and local deletion
  forgets only the selected mapping and its local MongoDB history.
- Common TikZ import renders a safe function plot and a structured LaTeX shape;
  MathJax produces SVG for the equation.
- Imported shapes survive a browser reload, and their cleanup survives another
  reload.
- Focused safe-math and TikZ tests pass (6 tests).
- Focused Assistant text normalization/reflow tests pass (5 tests).
- `git diff --check` passed before commit.

Live AI proposal generation uses the existing custom OpenCode ChatGPT-Web
authentication through a read-only bind mount. Overleaf does not share
OpenCode's conversation map.

## Recommended Manual Browser Test

1. Open a local Overleaf project at `http://127.0.0.1`.
2. Create a file such as `board.tldraw`.
3. Open it and confirm the tldraw canvas replaces the source editor.
4. Draw several shapes and text objects.
5. Switch to another file and back; confirm the canvas state persists.
6. Reload the page; confirm the canvas reconstructs correctly.
7. Open the same project in a second browser session and verify collaborative changes appear remotely.
8. Delete and update shapes in both sessions.
9. Test read-only access and confirm editing is disabled.
10. Inspect browser console and `sharelatex` logs for errors.

## Git Workflow for Future Changes

The branch currently tracks the writable fork remote.

Typical workflow:

```bash
cd /root/src/overleaf-whiteboard
git status
git pull --rebase fork feature/overleaf-whiteboard
# edit / test
git add <files>
git commit -m "Describe change"
git push fork feature/overleaf-whiteboard
```

Do not attempt to push directly to `origin` unless upstream permissions change.

## AI Agent Handoff Notes

When an AI coding agent continues this project, it should begin by checking:

```bash
cd /root/src/overleaf-whiteboard
git status --short
git branch --show-current
git log -5 --oneline --decorate
git remote -v
docker ps
```

Important assumptions for future agents:

- This is a large Overleaf monorepo; avoid broad dependency reinstalls unless required.
- A successful production build already exists, so do not rebuild automatically for tiny source inspections.
- The host previously lacked a usable Yarn install state even though Corepack was present.
- The running Docker image contains production dependencies, not necessarily the full development toolchain needed for ESLint/TypeScript checks.
- Building the complete Community image is the strongest verification currently completed.
- Temporary dependency/install-state artifacts should not be committed.
- Keep the whiteboard implementation isolated to `.tldraw` documents.
- Preserve compatibility with normal text documents and Python editor behavior.
- Preserve Overleaf write/read-only permission behavior.
- Persistence changes require backward compatibility or an explicit format-version migration strategy.

## Known Technical Risks and Future Improvements

### Browser-backed AI session

The sidecar automates the ChatGPT web application rather than an official API.
It deliberately fails closed when the required model and effort cannot be
verified, but upstream UI changes can still require maintenance. Its session
file is a secret and must remain private. Overleaf reads the custom OpenCode
session through a read-only mount and stores its keyed conversation map in a
separate toolkit data directory.

### Conflict/reconciliation behavior

Remote Overleaf operations trigger a full replay into the tldraw store. This is simple and robust for an initial implementation but may become expensive for large whiteboards.

### Asset handling

The current implementation uses tldraw asset URLs for application assets, but rich user-created external assets/images may require a dedicated Overleaf-backed asset persistence strategy.

### Testing

The safe math evaluator and TikZ parser have focused tests. Future work should
expand automated coverage for:

- diff parsing and validation
- serialization
- replay ordering
- remote-operation reconciliation
- permissions/read-only mode
- malformed data behavior
- `.tldraw` editor routing
- multi-client realtime behavior

## Current Implementation

The complete whiteboard/Assistant implementation is committed as
`0d62c4684aa9ebfbb613ce67365a44bb80a45140` and pushed to
`fork/feature/overleaf-whiteboard`. Its toolkit deployment support is committed
as `7a9e8ab9edca58cba1d2f7673c0b0056cb096117` and pushed to the personal
toolkit repository. The deployment reuses only OpenCode's ChatGPT-Web
authentication file; no OpenCode source or conversation state is copied into
Overleaf.
