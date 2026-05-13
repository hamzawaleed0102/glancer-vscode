export type ClaudeModel = 'default' | 'opus' | 'sonnet' | 'haiku';
export type TitleSource = 'default' | 'ai' | 'rename' | 'manual';

export interface AgentSnapshot {
  id: string;
  name: string;
  titleSource: TitleSource;
  model: ClaudeModel;
  tldr: string | null;
  attentionReason: string | null;
  errorReason: string | null;
  progress: { value: number; label: string } | null;
  /**
   * Slug of the Skill currently driving the turn, set by Claude via
   * `update_state`. Rendered as a small pill on the card. `null` when no
   * skill is active. Source of truth is Claude's MCP call — Glance doesn't
   * infer the skill, only displays what Claude reports.
   */
  skill: string | null;
  streaming: boolean;
  /**
   * True from the moment the agent is spawned until Claude's TUI is on
   * screen (alt-screen entered, or 2s fallback). While true the renderer
   * shows a "Starting session…" indicator on the card instead of the usual
   * model/flag rows, and the terminal display is held on a placeholder so
   * the user doesn't see the shell echo of the `claude …` invocation.
   */
  starting: boolean;
}

/**
 * One past Claude Code session for the current workspace, as surfaced by
 * the "Open old session" picker. Synthesized host-side from
 * ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl — Claude doesn't
 * store an explicit title, so `firstPrompt` is the first usable user
 * message text (truncated to 200 chars). `null` means no usable prompt
 * was found.
 *
 * `name` carries the Glance-assigned title for this session when we have
 * one — set by Claude via the MCP `update_state` tool and persisted in
 * sessions.json. Only populated when titleSource was non-default. The
 * UI prefers `name` over `firstPrompt`, and renders "untitled session"
 * only when both are absent.
 */
export interface OldSession {
  sessionId: string;
  firstPrompt: string | null;
  name: string | null;
  mtimeMs: number;
}

export type HostToWebview =
  | { type: 'state'; agents: AgentSnapshot[]; activeId: string | null }
  | { type: 'agentAdded'; agent: AgentSnapshot }
  | { type: 'agentRemoved'; id: string }
  | { type: 'agentUpdate'; id: string; fields: Partial<AgentSnapshot> }
  | { type: 'activeChanged'; id: string | null }
  /**
   * Sent by the host after `focusPanel` runs (Cmd+Shift+G or any reveal).
   * The webview dispatches a `glancer:focus` window event so AgentList can
   * pull keyboard focus into its container, enabling Up/Down/Enter/G to be
   * handled by React without VS Code keybinding contexts.
   */
  | { type: 'focus' }
  /**
   * Play a tiny attention tone in the webview. Fires alongside the
   * turn-complete toast notification so the user hears + sees the alert.
   */
  | { type: 'playTone' }
  /**
   * Reply to `listOldSessions`. Always fired even if the list is empty
   * (e.g. no past sessions for this workspace) so the picker can flip
   * out of its loading state.
   */
  | { type: 'oldSessions'; sessions: OldSession[] };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'newAgent'; model?: ClaudeModel }
  | { type: 'select'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'resetTitle'; id: string }
  /**
   * User pressed Enter while a card was focused — bring the agent's
   * terminal into view AND steal focus into it (unlike `select`, which
   * uses preserveFocus so the panel keeps keyboard nav).
   */
  | { type: 'focusTerminal'; id: string }
  /**
   * Webview reports its own focus/blur state. Used by the host to suppress
   * turn-complete toasts when the user is already looking at the panel.
   */
  | { type: 'panelFocus'; focused: boolean }
  /**
   * User dragged a card to reorder. `ids` is the full new ordering as
   * the webview just rendered it (so the host can adopt it verbatim and
   * persist for next launch). The webview applies the reorder
   * optimistically; the host treats this message as authoritative.
   */
  | { type: 'reorder'; ids: string[] }
  /**
   * User opened the old-sessions picker. Host scans the workspace's
   * Claude project dir and replies with `oldSessions`. Fetched every
   * open — no client-side cache — so freshly-finished sessions show up.
   */
  | { type: 'listOldSessions' }
  /**
   * User picked a session in the picker. Host spawns a new agent card
   * with `claude --resume <sessionId>` using the same cwd as `newAgent`.
   */
  | { type: 'openOldSession'; sessionId: string }
  /**
   * User pressed `f` on a focused agent panel. Host toggles the
   * VS Code bottom panel between maximized and unmaximized so the
   * terminal can take the whole window for reading + leaving easily.
   */
  | { type: 'toggleMaximizedPanel' };
