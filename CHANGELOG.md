# Changelog

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
