# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

VS Code extension ("Glance — Claude Code", publisher `hamzawaleed`, view id `glancer.agents`) that runs multiple Claude Code sessions in real VS Code terminals and surfaces per-session status cards (title, TL;DR, progress, needs-input/error) in a sidebar webview. The product is branded "Glance"; internal symbols / commands / settings are still `glancer.*` — do not rename them.

## Commands

Package manager is **pnpm** (`.npmrc` pins `node-linker=hoisted` and lists `esbuild` + `node-pty` as the only built deps). Do not use npm/yarn — `postinstall` runs `scripts/fix-pty-perms.mjs`, which depends on the hoisted layout.

```bash
pnpm install          # also runs scripts/fix-pty-perms.mjs (chmod +x node-pty's spawn-helper)
pnpm run build        # esbuild: extension host + webview + per-file test compile
pnpm run watch        # all three esbuild contexts in watch mode + copyStatic polling
pnpm run test         # node --test on the two compiled test files in out/
pnpm run fix-pty      # re-run the spawn-helper chmod (if a pnpm rebuild stripped it)
```

Launch the Extension Development Host from VS Code with **F5** after `pnpm run build` (or while `pnpm run watch` is running).

### Tests

Tests are plain `node:test` files compiled by esbuild to CJS and executed against the JS in `out/`. The test command is hard-coded to two files:

```bash
node --test out/extractMarkers.test.js out/transcriptWatcher.test.js
```

Run a single test file: `node --test out/extractMarkers.test.js` (after `pnpm run build`). Run one named test: `node --test --test-name-pattern='extracts TL;DR' out/extractMarkers.test.js`. Tests must be added to both the `testEntries` array in `esbuild.config.mjs` and the `scripts.test` command in `package.json` — there is no glob.

## Architecture

Three runtimes cooperate per agent. Understand all three before changing the marker / state pipeline.

### 1. Extension host (`src/extension.ts`, `src/agents/`, `src/view/AgentPanelProvider.ts`)

- `AgentManager` owns the `Map<id, Agent>`, the global hook-events chokidar watcher (`storageDir/events/`), and on-disk persistence (`storageDir/sessions.json` + `storageDir/state/<id>.json`).
- On activation it copies `out/markers/hook.mjs` and `out/markers/mcp-server.mjs` into `globalStorageUri` and writes:
  - `hook-settings.json` — registers `hook.mjs` for `Stop`, `UserPromptSubmit`, `Notification`, `SessionStart` (passed to `claude --settings`).
  - `mcp-config.json` — registers the Glance MCP server (passed to `claude --mcp-config`); env carries `GLANCER_INSTRUCTIONS_FILE`.
  - `glancer-instructions.txt` — the system prompt the MCP server returns in its `initialize` response's `instructions` field. **No `--append-system-prompt` is used** — that path was removed because shell echo leaked the prompt into the terminal.
- `Agent` spawns a `node-pty` child shell that runs `clear && claude --dangerously-skip-permissions [--model X] --settings … --mcp-config … [--resume <sessionId>]`. The PTY is wrapped in a `vscode.Pseudoterminal` so VS Code owns scrollback. See `src/agents/pseudoterminal.ts` — it holds a "Starting session…" placeholder until Claude emits the alt-screen escape (`\x1b[?1049h` / `1047h` / `47h`) or a 5s deadline elapses, then flushes; this hides the shell echo of the launch command.

### 2. Marker / state pipeline (the load-bearing flow)

Claude updates the agent card **exclusively** via the MCP tool `glancer - update_state` (server: `src/markers/mcp-server.mjs`). The pipeline is:

```
Claude tool call
  → mcp-server.mjs writes/merges JSON to $GLANCER_STATE_FILE (storageDir/state/<id>.json)
  → Agent's chokidar stateWatcher fires (usePolling, 250ms)
  → Agent.applyState() diffs and emits Partial<AgentSnapshot>
  → AgentManager forwards as agentUpdate to webview
```

Five required fields on every call: `title`, `tldr`, `progress`, `needsInput`, `error`. The system prompt (`src/markers/systemPrompt.ts`) hammers on "all five, every call" — the schema enforces it via `required` in `mcp-server.mjs`. Missing fields preserve prior value (silent desync); explicit `null` clears.

`src/markers/extractMarkers.ts` and `src/markers/transcriptWatcher.ts` are a **legacy fallback** path that parses emoji markers (`🔊 TL;DR:`, `🏷️ Title:`, etc.) out of the JSONL transcript at `~/.claude/projects/*/<sessionId>.jsonl`. They are not currently wired into `AgentManager` but are kept compiled + tested. If you remove either, drop the corresponding entry from `esbuild.config.mjs::testEntries` and `package.json::scripts.test`.

Hook events flow independently:

```
Claude fires hook → hook.mjs writes JSON file → AgentManager events watcher → handleHookEvent
  SessionStart → setSessionId; if source='clear'|'compact', resetCardState (wipes title + markers)
  UserPromptSubmit → markUserPrompted + clearTransient (streaming on, wipes tldr/needs/error/progress)
  Stop → notifyTurnComplete (streaming off, toast + tone via webview)
  Notification → setNeedsAttention (gated on streaming=true to ignore Claude's 60s idle ping)
```

### 3. Persistence and dormant agents

- `sessions.json` only contains agents where `hasUserPrompt === true`. Agents created but never prompted have no JSONL on disk, so `claude --resume <id>` would fail with "No conversation found" — they're filtered out.
- On reload, restored entries become **dormant** Agents: the card renders from `state/<id>.json` (seeded by the stateWatcher's initial `add` event) but no PTY is spawned. `reveal()` / `select` / `focusTerminal` calls `revive()` which spawns Claude with `--resume <sessionId>`.
- `Agent.onExit` (PTY exit) calls `becomeDormant()` — it does **not** remove the agent from the map. Cmd+R reload and accidental terminal closes both fire exit; deleting on those would wipe `sessions.json`. Permanent removal only happens via `AgentManager.kill()` → `removeAgent()` (also calls `purgePersistentState()` to delete the state file).
- The activity-bar badge is a derived count of `agents.where(needsAttention)` — recomputed on **every** `agentUpdate`, never tracked incrementally (avoids drift bugs).

### 4. Webview (`src/view/webview/`)

React 18 mounted into a `WebviewView` with `retainContextWhenHidden: true`. Communicates over typed `postMessage` envelopes defined in `src/shared/messages.ts` (`HostToWebview` / `WebviewToHost`) — keep both unions in sync when adding messages.

Focus race notes: `AgentPanelProvider.scheduleFocusRetries` fires `focusTerminal` at 150/400/900/1600ms after auto-spawn because a single call gets eaten during VS Code launch. `pendingFocusTerminalId` is the backup path consumed by the first `panelFocus(true)` message from the webview. Don't simplify these without testing the "VS Code launched with Glance already the active view" case.

## Conventions and gotchas

- **Marker sanitization**: every model-supplied string goes through `sanitizeMarkerString` in `src/agents/Agent.ts`, which strips `null`/`undefined`/`true`/`false`/`n/a`/`na` literals. Add new bad values to `MARKER_STRING_BAD_VALUES` rather than gating per call site.
- **Shell quoting**: paths get baked into hook commands run by Claude via `/bin/sh -c`. macOS `globalStorageUri` lives under `~/Library/Application Support/…` (contains a space). All such paths go through `shellQuote` in `Agent.ts` / inline POSIX quoting in `AgentManager.ts`. Don't pass unquoted paths.
- **Streaming flag**: only flipped by `clearTransient` (UserPromptSubmit → true) and `notifyTurnComplete` / `setNeedsAttention` (→ false). **Do not** wire `onData` to flip it — typed characters echo through `onData` and would falsely toggle streaming on while the user is typing.
- **node-pty is `external`** in `esbuild.config.mjs::hostConfig` — the native binding can't be bundled. `fsevents` is also external. The `postinstall` hook chmod+x's `node_modules/node-pty/prebuilds/<platform>/spawn-helper` because npm tarballs strip the executable bit and VS Code's hardened runtime won't `posix_spawnp` a non-executable.
- **Build outputs the host expects at runtime**: `out/extension.js` (main), `out/webview/{main.js,index.html,styles.css}` (loaded via `webview.asWebviewUri`), `out/markers/{hook,mcp-server}.mjs` (copied to `globalStorageUri` on activation). `copyStatic()` in `esbuild.config.mjs` re-copies them and chmods the `.mjs` files to 0755 — preserve that on changes.
- **TypeScript split**: `tsconfig.json` covers the host (CJS, excludes `src/view/webview/**`); `tsconfig.webview.json` is `noEmit: true` and covers the webview + shared. esbuild does the actual compilation for both.
- **Title source precedence** (`Agent.applyState`): `'manual'` and `'rename'` block AI-supplied titles; `'ai'` and `'default'` accept them. `/clear` (SessionStart source=`clear`) resets the title back to `glancer-XX` so the next turn's `update_state` can re-claim it.
