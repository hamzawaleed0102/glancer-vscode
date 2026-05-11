# Changelog

## 0.0.5 — 2026-05-12

- Polish: auto-assigned agent names now read `glance-XX` (matches the product) instead of the legacy `glancer-XX`. Existing renamed cards keep their saved name.
- Polish: manual renames and AI-supplied titles are auto-capitalized on the first letter so cards present consistently.

## 0.0.4 — 2026-05-12

- Add: first-install welcome walkthrough that teaches the activity-bar location plus the focus / spawn / enter / cycle / kill shortcuts. Re-openable any time via **Glance: Show Welcome Tour** in the Command Palette.
- Polish: opaque, full-bleed extension icon so the Marketplace listing doesn't show transparent corners.
- Docs: drop the Marketplace badge from the README (redundant with the listing page itself) and add an author byline.

## 0.0.3 — 2026-05-12

- Docs: trim README to the user-facing surface (remove contributor-only build/test instructions).

## 0.0.2 — 2026-05-12

- Fix: clear the yellow "needs attention" marker when a turn ends, so answering or cancelling an interactive picker no longer leaves the card stuck in a waiting state.
- Improve: clicking a Glance terminal tab in the panel below now highlights its agent card in the sidebar automatically.
- Polish: active agent card has a stronger highlight (layered ring + bolder title) to stand out from the rest of the list.
- Refresh: new app icon and activity-bar glyph.

## 0.0.1 — 2026-05-11

- Initial Marketplace release.
- Multi-session Claude Code agent panel with per-session status cards (title, TL;DR, progress, needs-input, error).
- Real VS Code terminals via `node-pty`, per-agent state via MCP `update_state` tool.
- Activity-bar badge for agents needing attention; `/clear` resets the card; drag-to-reorder.
