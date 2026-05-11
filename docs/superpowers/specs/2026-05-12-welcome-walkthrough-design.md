# Welcome walkthrough — design

**Date:** 2026-05-12
**Status:** Approved (pending spec review)
**Target version:** 0.0.3

## Goal

After someone installs Glance for the first time, they should learn — without reading the README — that:

1. Glance lives on the **left activity bar**.
2. `⌘⇧G` / `Ctrl+Shift+G` focuses the panel.
3. When the panel is focused, `g` spawns a new agent.
4. `Enter` jumps into the active agent's terminal; `Esc` comes back.
5. `↑/↓` cycle agents, double-click a title to rename, `⌘⌫` / `Ctrl+Backspace` kills.

These shortcuts already exist (split between `package.json` keybindings and webview-internal handlers in `src/view/webview/AgentList.tsx`); they're just undiscoverable. The walkthrough surfaces them, nothing more.

## Mechanism

A VS Code **Walkthrough** contributed by the extension. Native mechanism — same one Copilot, GitLens, and the built-in Welcome page use. Auto-opens once on first install, re-openable any time from the Command Palette.

Walkthroughs come with auto-ticking step completion when a registered command runs or a view opens. We wire these to Glance's existing commands so the boxes tick as the user actually performs each step.

## Manifest changes (`package.json`)

### `contributes.walkthroughs`

```jsonc
"walkthroughs": [
  {
    "id": "glancer.welcome",
    "title": "Glance — Claude Code: Quick Tour",
    "description": "Run multiple Claude Code sessions side-by-side. Learn the shortcuts in 30 seconds.",
    "steps": [
      {
        "id": "find",
        "title": "Find Glance in the activity bar",
        "description": "Look for the Glance icon on the left activity bar. Click it to open the panel.\n[Open Glance](command:glancer.focusPanel)",
        "media": { "image": "media/walkthrough/find.png", "altText": "The Glance icon highlighted on the VS Code activity bar" },
        "completionEvents": ["onView:glancer.agents"]
      },
      {
        "id": "focus",
        "title": "Open the panel — ⌘⇧G / Ctrl+Shift+G",
        "description": "From anywhere in VS Code, press ⌘⇧G (macOS) or Ctrl+Shift+G (Windows/Linux) to focus the panel.\n[Try it](command:glancer.focusPanel)",
        "media": { "markdown": "media/walkthrough/focus.md" },
        "completionEvents": ["onCommand:glancer.focusPanel"]
      },
      {
        "id": "spawn",
        "title": "Spawn an agent — press g",
        "description": "With the panel focused, press the **g** key to spawn a new Claude session. (Or use ⌘⌥N / Ctrl+Alt+N from anywhere.)\n[Spawn one now](command:glancer.newAgent)",
        "media": { "image": "media/walkthrough/spawn.png", "altText": "Agent list with a `g` keycap overlay" },
        "completionEvents": ["onCommand:glancer.newAgent"]
      },
      {
        "id": "enter",
        "title": "Jump into its terminal — Enter",
        "description": "With a card selected in the panel, press **Enter** to hand keyboard focus to that agent's terminal. Press **Esc** to come back to the panel.",
        "media": { "image": "resources/readme/card-anatomy.png", "altText": "Anatomy of an agent card: title, TL;DR, progress bar, status stripe, kill" },
        "completionEvents": ["onCommand:workbench.action.terminal.focus"]
      },
      {
        "id": "more",
        "title": "Cycle, rename, kill",
        "description": "- **↑ / ↓** — cycle agents (panel focused)\n- **Double-click** a card title — rename it (renames are sticky until `/clear`)\n- **⌘⌫ / Ctrl+Backspace** — kill the active agent\n\nThat's everything. Have fun.",
        "media": { "image": "resources/readme/notification.png", "altText": "VS Code toast firing when an agent finishes a turn in the background" }
      }
    ]
  }
]
```

### `contributes.commands`

Add one entry:

```jsonc
{ "command": "glancer.showWalkthrough", "title": "Glance: Show Welcome Tour" }
```

### `activationEvents`

Add `"onStartupFinished"` alongside the existing `"onView:glancer.agents"`. Required because the auto-open check must run on first launch before the user has touched the view. The check itself is a single `globalState.get` and a `setTimeout` — negligible startup cost; no PTY spawns until a card is opened.

## Auto-open logic (`src/extension.ts`)

```ts
const SEEN_KEY = 'glancer.walkthrough.seen';
const WALKTHROUGH_ID = 'hamzawaleed.glance-claude-code#glancer.welcome';

// Inside activate(), after registerWebviewViewProvider:
if (!context.globalState.get<boolean>(SEEN_KEY)) {
  // Defer to next tick so the activity bar paints before the walkthrough opens.
  setTimeout(() => {
    vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
    void context.globalState.update(SEEN_KEY, true);
  }, 0);
}

context.subscriptions.push(
  vscode.commands.registerCommand('glancer.showWalkthrough', () => {
    return vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
  }),
);
```

`globalState` is per-user, not per-workspace — exactly once across all folders the user opens. The third argument to `openWalkthrough` (`toSide=false`) opens the tour as a full editor tab, not split.

## New files

```
media/walkthrough/
  find.png       NEW — Glance icon on activity bar with a pointer arrow (≈1158×600 px, VS Code walkthrough recommended)
  spawn.png      NEW — agent list with a `g` keycap overlay (≈1158×600 px)
  focus.md       NEW — inline markdown rendered as step-2 media: a big ⌘⇧G keycap and one sentence
```

Steps 4 and 5 reuse existing `resources/readme/card-anatomy.png` and `resources/readme/notification.png` — no duplicate copies.

`.vscodeignore` already exists. Add `docs/**` to it so the spec is not shipped in the `.vsix`. `media/walkthrough/**` is not excluded by current rules, so the new walkthrough assets are bundled by default — confirmed by reading `.vscodeignore` before writing this spec.

## What does NOT change

- No new keybindings — `g`, `Enter`, `↑/↓`, `Esc`, `⌘⌫` are already wired in `src/view/webview/AgentList.tsx`. The walkthrough only documents them.
- No changes to `AgentManager`, marker pipeline, or webview React code.
- No new dependencies.
- README stays as-is. (Optional follow-up: add one line pointing at the Command Palette command to re-open the tour. Out of scope for this spec.)
- `CLAUDE.md` gets one paragraph under "Architecture → 1. Extension host" describing the SEEN flag and walkthrough activation.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Activation event `onView:glancer.agents` doesn't fire on first launch, so the SEEN check never runs and the tour never opens. | Add `onStartupFinished` to `activationEvents`. |
| `onCommand:workbench.action.terminal.focus` completion event ticks on **any** terminal focus, not just Glance terminals. | Acceptable: the step still teaches the right behavior; the false-positive only mis-ticks the box. Not worth a custom command. |
| User installs 0.0.2, then upgrades to 0.0.3 — they should also see the tour. | `globalState` is empty for them on the `SEEN_KEY` (new key), so they get it once on first launch after upgrade. Same behavior as a fresh install — intended. |
| Tour yanks focus mid-typing if VS Code is restored with a file open. | `setTimeout(…, 0)` defers one tick; VS Code's `openWalkthrough` opens as an editor tab, not modal, and respects user navigation. Acceptable. |
| If the extension ID is ever renamed again, the SEEN flag resets and the tour re-shows. | Tolerable. Project memory says renaming is done. |

## Testing

Manual verification (no automated test — walkthroughs are pure manifest + state, and the test runner is hard-coded to two existing files):

1. From a clean VS Code profile (`code --user-data-dir /tmp/glance-test`), install the built `.vsix`.
2. Reload — confirm the walkthrough opens automatically as an editor tab.
3. Click each step's "Try it" command link; confirm checkmarks tick.
4. Close VS Code, reopen — confirm the tour does **not** re-open.
5. Run `Glance: Show Welcome Tour` from the Command Palette — confirm it re-opens.
6. Confirm step-completion auto-ticks when you actually use the shortcuts (`⌘⇧G`, `g`, `Enter`).

No new entries to `esbuild.config.mjs::testEntries` or `package.json::scripts.test`.

## Out of scope

- Localization of step copy (English only for now).
- Animations / GIFs in step media (PNG only, per the existing asset convention).
- Tracking walkthrough completion / analytics.
- Re-showing the tour on version bumps after 0.0.3.
