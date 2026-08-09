# Overleaf Whiteboard Development Guide

This document is the machine-specific technical guide for the local Overleaf whiteboard development environment. It is intended to be useful both to a human developer and to future AI coding agents working on this machine.

## Project Summary

This branch adds collaborative `.tldraw` whiteboards to the Overleaf editor by treating `.tldraw` as an editable document type and rendering a tldraw canvas instead of the normal source editor when such a document is opened.

The whiteboard state is persisted inside the Overleaf document as newline-delimited JSON diff records. This lets the implementation reuse Overleaf's existing document storage, realtime collaboration, permissions, and history mechanisms instead of introducing a separate whiteboard backend.

## Git Repositories

### Overleaf source repository

- Local path: `/root/src/overleaf-whiteboard`
- Current feature branch: `feature/overleaf-whiteboard`
- Current whiteboard commit: `4ca6ad7e6b1282a1b078ac3adbdc978799fdbc2a`
- Upstream remote: `origin -> https://github.com/overleaf/overleaf.git`
- Writable fork remote: `fork -> https://github.com/RyuPrad/overleaf.git`
- Pushed branch: `fork/feature/overleaf-whiteboard`

The upstream `origin` is read-only for this account. Push feature work to `fork`, not `origin`.

### Overleaf Toolkit

- Local path: `/root/overleaf-toolkit`
- Local configuration: `/root/overleaf-toolkit/config/variables.env`
- Local authentication overlay: `/root/overleaf-toolkit/local-noauth`

The toolkit runs the locally built Overleaf image and supporting MongoDB/Redis containers.

## Local Runtime

The current local stack is:

- `sharelatex` -> image `local/overleaf-noauth:6.2.2`
- `mongo` -> image `mongo:8.0`
- `redis` -> image `redis:7.4`
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

Current persistence constants:

- Format: `overleaf-tldraw-diff`
- Version: `1`
- Local batching delay: `120 ms`

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

Each line of a `.tldraw` Overleaf document is one JSON object with this structure:

```json
{
  "format": "overleaf-tldraw-diff",
  "version": 1,
  "added": [],
  "updated": [],
  "removed": []
}
```

The implementation reconstructs the document by:

1. Creating the required tldraw document and default page records.
2. Parsing each non-empty line.
3. Validating the format/version.
4. Applying added and updated records.
5. Removing deleted record IDs.

This append-only format was chosen to map naturally onto Overleaf text operations and realtime collaboration.

## Local Build Workflow

Run the Community image build from:

`/root/src/overleaf-whiteboard/server-ce`

Primary command:

```bash
make build-community
```

The successful whiteboard build produced an image based on branch name `feature/overleaf-whiteboard` and source revision `93a4f0c88a1aa3217db8773993ff178edff208d9` before the whiteboard commit was created.

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
- Overleaf, MongoDB, and Redis run successfully.
- `.tldraw` appears in exposed editable text extensions.
- The deployed IDE bundle contains the whiteboard implementation.
- A temporary `.tldraw` document can be created through Overleaf's live `/project/:Project_id/doc` API.
- The temporary `.tldraw` document can be deleted successfully with HTTP 204.
- No whiteboard/tldraw server errors appeared during that API lifecycle verification.
- `git diff --check` passed before commit.

Browser-based visual verification of the tldraw canvas was not completed because browser automation permission was rejected during that session. Future work should include interactive canvas verification.

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

### Append-only document growth

Every whiteboard change currently appends another diff line. Long-lived boards may become large. A future compaction strategy may be necessary.

Possible approach:

- Periodically serialize a canonical snapshot.
- Introduce a new persistence record type or format version.
- Compact only when collaboration state is safe.

### Conflict/reconciliation behavior

Remote Overleaf operations trigger a full replay into the tldraw store. This is simple and robust for an initial implementation but may become expensive for large whiteboards.

### Asset handling

The current implementation uses tldraw asset URLs for application assets, but rich user-created external assets/images may require a dedicated Overleaf-backed asset persistence strategy.

### Testing

Future work should add automated tests for:

- diff parsing and validation
- serialization
- replay ordering
- remote-operation reconciliation
- permissions/read-only mode
- malformed data behavior
- `.tldraw` editor routing
- multi-client realtime behavior

## Current Commit

Whiteboard implementation commit:

```text
4ca6ad7e6b Add collaborative tldraw whiteboard support
```

Pushed to:

```text
https://github.com/RyuPrad/overleaf/tree/feature/overleaf-whiteboard
```
