import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { createClaudePty, type ClaudePty } from './pseudoterminal';
import { watchState, type StateWatcher, type AgentState } from '../markers/stateWatcher';
import type { AgentSnapshot, ClaudeModel, TitleSource } from '../shared/messages';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/zsh';
}

/**
 * Strings the model emits when it confuses our string-typed marker
 * fields (tldr / title / needsInput / error / progress.label) with
 * booleans or "do I have a value" sentinels. None of these are
 * meaningful card content — they always come from a schema
 * misinterpretation. Compared case-insensitively after trim.
 */
const MARKER_STRING_BAD_VALUES: ReadonlySet<string> = new Set([
  'null',
  'undefined',
  'none',
  'true',
  'false',
  'n/a',
  'na',
]);

/**
 * Normalize a model-supplied string marker. Returns `null` for any
 * value that isn't a usable sentence/clause:
 *   - non-strings (booleans, numbers, objects)
 *   - empty / whitespace-only strings
 *   - schema-confusion literals like "null", "true", "n/a"
 * Trims surrounding whitespace on accepted values.
 *
 * Centralized here (not inlined per-call site) so every place that
 * consumes a model-written marker — applyState, setNeedsAttention,
 * progress.label, future fields — runs through the same gate. Adding
 * a new bad value to the blocklist propagates automatically.
 */
function sanitizeMarkerString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (MARKER_STRING_BAD_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function capitalizeFirstLetter(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface AgentInit {
  id: string;
  cwd: string;
  model: ClaudeModel;
  hookSettingsPath: string;
  /**
   * JSON file registering the Glancer MCP server. The server returns its
   * Glancer system instructions in the MCP `initialize` response, so the
   * prompt never appears on the claude CLI — no shell echo to worry about.
   */
  mcpConfigPath: string;
  eventsDir: string;
  hookScriptPath: string;
  /**
   * Absolute path of the per-agent JSON status file Claude maintains via the
   * `glancer_update_state` MCP tool. The extension watches this file to
   * drive the agent card — see `stateWatcher.ts` and `summarySystemPrompt`
   * for the contract.
   */
  stateFilePath: string;
  /**
   * When true, the Agent is restored from disk but no PTY is spawned. The
   * card shows last-known state; the first `reveal()` / `select` revives the
   * Agent and starts Claude with `--resume sessionId`. Used by the
   * AgentManager on extension reload so we don't spin up every Claude
   * session immediately.
   */
  dormant?: boolean;
  /** Existing Claude session id to resume (passed via `claude --resume`). */
  sessionId?: string | null;
  /** Snapshot fields to seed the dormant Agent with — usually the persisted name/titleSource. */
  initialSnapshot?: {
    name?: string;
    titleSource?: TitleSource;
  };
  /**
   * Whether the user has already chatted in this session. If true, the
   * Agent skips waiting for the next UserPromptSubmit before becoming
   * eligible for persistence. Set from sessions.json on restore.
   */
  hasUserPrompt?: boolean;
  /**
   * An existing VS Code terminal (from a previous extension host) that
   * survived a reload with its underlying Claude process still alive.
   * AgentManager identifies these by their eye `ThemeIcon` and matches
   * them to persisted agents by name. When provided: the Agent skips
   * `spawn()` (no new PTY), wires `this.terminal` to the survivor, and
   * runs in "adopted" mode — `claude` stays null, state still flows via
   * the state-file watcher (Claude inside the old PTY keeps writing to
   * it), but we can't send programmatic input or repaint the tab name.
   * Closing the tab in this mode is treated as a kill (see
   * AgentManager.onDidCloseTerminal).
   */
  adoptedTerminal?: vscode.Terminal;
}

export class Agent implements vscode.Disposable {
  readonly id: string;
  private _name: string;
  private _titleSource: TitleSource = 'default';
  private _model: ClaudeModel;
  private _tldr: string | null = null;
  private _attentionReason: string | null = null;
  private _errorReason: string | null = null;
  private _progress: { value: number; label: string } | null = null;
  private _streaming = false;
  private _starting = true;

  private claude: ClaudePty | null = null;
  private terminal: vscode.Terminal | null = null;
  private stateWatcher: StateWatcher;
  private readonly stateFilePath: string;
  private readonly init: AgentInit;
  private _sessionId: string | null = null;
  private _dormant: boolean;
  /**
   * True once the user has submitted at least one prompt. Until this flips,
   * Claude hasn't written the session JSONL on disk and `--resume <id>`
   * would fail with "No conversation found". The manager uses this flag to
   * decide whether to persist the agent across launches.
   */
  private _hasUserPrompt: boolean;
  /**
   * True when this Agent took over a terminal that survived a previous
   * extension host. We don't own a PTY in this mode (claude is null), so
   * tab-name updates are skipped and the close handling in AgentManager
   * treats the close as an explicit kill rather than dormant-on-exit.
   */
  private _adopted = false;

  private readonly changeEmitter = new vscode.EventEmitter<Partial<AgentSnapshot>>();
  readonly onChange = this.changeEmitter.event;

  /** Fires when persistable metadata changes (sessionId, name, titleSource). */
  private readonly metaChangeEmitter = new vscode.EventEmitter<void>();
  readonly onMetaChange = this.metaChangeEmitter.event;

  private readonly exitEmitter = new vscode.EventEmitter<void>();
  readonly onExit = this.exitEmitter.event;

  /**
   * Fires when Claude's Stop hook reports the end of a response. The Stop
   * hook is the cleanest "turn complete, ball is in user's court" signal —
   * far more reliable than guessing from PTY idle timers, which fire on
   * mid-turn pauses (slow tool calls, etc).
   */
  private readonly turnCompleteEmitter = new vscode.EventEmitter<void>();
  readonly onTurnComplete = this.turnCompleteEmitter.event;

  /**
   * True when the card is currently showing an "attention" signal that
   * warrants user action: an interactive prompt waiting on them, or a
   * hard error blocking progress. The manager sums these across all
   * agents into the activity-bar badge count. Computed from state, not
   * tracked separately — clearTransient (UserPromptSubmit) wipes both,
   * which naturally drops this back to false.
   */
  get needsAttention(): boolean {
    return this._attentionReason !== null || this._errorReason !== null;
  }

  /**
   * True between UserPromptSubmit and Stop. Used by AgentManager to gate
   * the Notification hook: if the turn already ended (streaming=false),
   * any incoming "needs input" notification is Claude Code's 60s idle
   * ping rather than a real attention request, and should be ignored.
   */
  get streaming(): boolean {
    return this._streaming;
  }

  constructor(init: AgentInit) {
    this.init = init;
    this.id = init.id;
    this._name = init.initialSnapshot?.name ?? `glance-${init.id.slice(3)}`;
    this._titleSource = init.initialSnapshot?.titleSource ?? 'default';
    this._model = init.model;
    this.stateFilePath = init.stateFilePath;
    this._sessionId = init.sessionId ?? null;
    this._dormant = init.dormant === true;
    this._hasUserPrompt = init.hasUserPrompt === true;

    // Dormant agents aren't "starting" — they're showing their last-known
    // state. The starting placeholder is for live launches only.
    if (this._dormant) this._starting = false;

    if (init.adoptedTerminal) {
      // Adopt path: terminal already exists (from previous extension host),
      // Claude is presumably still running inside it. Wire up the reference,
      // skip spawn — markers continue flowing via the state-file watcher.
      this.terminal = init.adoptedTerminal;
      this._adopted = true;
      this._starting = false;
    } else if (!this._dormant) {
      this.spawn();
    }

    // Always watch the state file. For dormant agents it reads back the
    // persisted markers from the last session. For live agents (spawned or
    // adopted) it picks up updates from Claude's MCP tool calls.
    this.stateWatcher = watchState(this.stateFilePath, (state) =>
      this.applyState(state),
    );
  }

  /** True when this Agent adopted a surviving terminal at construction. */
  get adopted(): boolean {
    return this._adopted;
  }

  /**
   * Build the launch command and spawn the Claude PTY. Called once at
   * construction for live agents and on `revive()` for dormant ones.
   */
  private spawn(): void {
    const init = this.init;
    const modelFlag = init.model === 'default' ? '' : ` --model ${init.model}`;
    // `--resume <id>` reconnects to the prior conversation. Only emitted
    // when we have a sessionId from a previous run; fresh agents start a
    // new Claude session and the SessionStart hook captures its id.
    const resumeFlag = this._sessionId
      ? ` --resume ${shellQuote(this._sessionId)}`
      : '';
    // No `--append-system-prompt` — the Glancer MCP server returns the
    // system instructions through its `initialize` response's
    // `instructions` field, the official MCP mechanism for it.
    const initialCommand =
      `clear && claude --dangerously-skip-permissions${modelFlag}` +
      ` --settings ${shellQuote(init.hookSettingsPath)}` +
      ` --mcp-config ${shellQuote(init.mcpConfigPath)}` +
      resumeFlag;

    this.claude = createClaudePty({
      cwd: init.cwd,
      shell: defaultShell(),
      env: {
        ...process.env,
        GLANCER_AGENT_ID: init.id,
        GLANCER_EVENTS_DIR: init.eventsDir,
        GLANCER_HOOK_SCRIPT: init.hookScriptPath,
        GLANCER_STATE_FILE: this.stateFilePath,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
      initialCommand,
    });

    // Seed the terminal tab title with the current agent name so a restored
    // session with an AI/manual title shows that title in the VS Code
    // terminal panel from the moment it spawns — not just the default
    // `glance-XX`. Subsequent renames are pushed via `claude.setName`.
    //
    // Green tint on the tab indicator + eye icon visually distinguishes
    // Glancer-owned terminals from regular user shells in the same panel,
    // so it's obvious which sessions are managed by our extension.
    this.terminal = vscode.window.createTerminal({
      name: this._name,
      pty: this.claude.pty,
      color: new vscode.ThemeColor('terminal.ansiGreen'),
      iconPath: new vscode.ThemeIcon('eye'),
    });

    // NOTE: deliberately no `onData → markStreaming` wiring. Terminal echoes
    // (e.g. characters typed into Claude's input box) also flow through
    // onData, so a PTY-driven `streaming` flag spuriously turns the bubble
    // on while the user is just typing. The canonical signals come from
    // Claude's hooks: UserPromptSubmit flips streaming on (in
    // clearTransient), Stop flips it off (in notifyTurnComplete).
    this.claude.onExit(() => {
      this.exitEmitter.fire();
      // PTY exit is NOT the same as "user wants this agent deleted". It
      // happens on every Cmd+R reload (VS Code tears down terminals before
      // the extension can react) and on any accidental terminal close. We
      // transition to dormant so the card stays in sessions.json — the
      // user can revive it by clicking, or delete it deliberately via the
      // Glancer kill button.
      this.becomeDormant();
    });
    this.claude.onStartupComplete(() => {
      if (!this._starting) return;
      this._starting = false;
      this.changeEmitter.fire({ starting: false });
    });
  }

  /**
   * Drop the live PTY/terminal references and mark the Agent dormant.
   * Triggered when the underlying Claude process exits for any reason
   * (terminal closed, VS Code reload, claude binary crash). The card stays
   * visible with last-known markers; reveal()/revive() can later spawn a
   * fresh PTY with `--resume <sessionId>`.
   */
  private becomeDormant(): void {
    if (this._dormant) return;
    this._dormant = true;
    this.claude = null;
    try {
      this.terminal?.dispose();
    } catch {
      // already disposed by VS Code on shutdown
    }
    this.terminal = null;
    if (this._streaming) {
      this._streaming = false;
      this.changeEmitter.fire({ streaming: false });
    }
  }

  /**
   * Revive a dormant agent — spawn the Claude PTY (with --resume if we have
   * a sessionId from the previous run). Subsequent reveals just show the
   * existing terminal.
   */
  revive(): void {
    if (!this._dormant) return;
    this._dormant = false;
    this._starting = true;
    this.changeEmitter.fire({ starting: true });
    this.spawn();
  }

  /**
   * Cwd / model / sessionId getters for the manager when persisting.
   * They're plain reads, not part of the snapshot diff machinery.
   */
  get cwd(): string { return this.init.cwd; }
  get model(): ClaudeModel { return this._model; }
  get sessionId(): string | null { return this._sessionId; }
  get titleSource(): TitleSource { return this._titleSource; }
  get name(): string { return this._name; }
  get hasUserPrompt(): boolean { return this._hasUserPrompt; }

  /**
   * Called when SessionStart hook fires with a new session id. Triggers
   * onMetaChange so the manager re-persists sessions.json.
   */
  setSessionId(id: string): void {
    if (this._sessionId === id) return;
    this._sessionId = id;
    this.metaChangeEmitter.fire();
  }

  /**
   * Called when UserPromptSubmit fires. Until this flips, Claude has not
   * written a session JSONL — `--resume` on a session with no user message
   * fails with "No conversation found". The manager filters un-prompted
   * agents out of sessions.json so they don't get restored on next launch.
   */
  markUserPrompted(): void {
    if (this._hasUserPrompt) return;
    this._hasUserPrompt = true;
    this.metaChangeEmitter.fire();
  }

  /**
   * Wipe every per-turn card marker AND the title back to default.
   * Used when Claude runs /clear (SessionStart with source='clear') —
   * the conversation just got reset, so any "needs input" / error /
   * tldr / progress / AI-assigned title carried over from the prior
   * conversation is stale. The title reverts to `glance-XX` so the
   * next turn's update_state can claim a fresh title.
   *
   * Also persists by writing nulls into the state file so the on-disk
   * snapshot used to seed dormant restores doesn't bring the stale
   * markers back on the next reload. Re-fires metaChange so sessions.json
   * picks up the title reset.
   */
  resetCardState(): void {
    const patch: Partial<AgentSnapshot> = {};
    const defaultName = `glance-${this.id.slice(3)}`;
    if (this._name !== defaultName || this._titleSource !== 'default') {
      this._name = defaultName;
      this._titleSource = 'default';
      patch.name = defaultName;
      patch.titleSource = 'default';
      this.claude?.setName(defaultName);
    }
    if (this._tldr !== null) { this._tldr = null; patch.tldr = null; }
    if (this._attentionReason !== null) { this._attentionReason = null; patch.attentionReason = null; }
    if (this._errorReason !== null) { this._errorReason = null; patch.errorReason = null; }
    if (this._progress !== null) { this._progress = null; patch.progress = null; }
    if (this._streaming) { this._streaming = false; patch.streaming = false; }
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    if (patch.name !== undefined) this.metaChangeEmitter.fire();
    // Overwrite the persisted state file so a dormant restore re-seeds
    // from a clean slate (including the reset title).
    try {
      fs.writeFileSync(
        this.stateFilePath,
        JSON.stringify(
          { title: this._name, tldr: null, progress: null, needsInput: null, error: null },
          null,
          2,
        ),
      );
    } catch {
      // Non-fatal — the next MCP update_state call will overwrite anyway.
    }
  }

  /** Called by AgentManager when Claude's Stop hook fires for this agent. */
  notifyTurnComplete(): void {
    // Explicit "turn ended" — flip streaming off so the bubble goes away
    // and the green ✓ takes over (based on tldr/progress). Without this,
    // streaming would stay true forever, since no PTY-data heuristic
    // resets it now.
    const patch: Partial<AgentSnapshot> = {};
    if (this._streaming) {
      this._streaming = false;
      patch.streaming = false;
    }
    // Clear any attention marker the Notification hook set mid-turn. If
    // Stop fires, the interactive picker was answered (or cancelled) —
    // the user is no longer being asked anything. Without this, picker
    // answers don't trigger any hook of their own, so the yellow state
    // persists until the next UserPromptSubmit or an explicit
    // needsInput=null from the model's next update_state call (which it
    // often doesn't emit mid-tool-chain).
    if (this._attentionReason !== null) {
      this._attentionReason = null;
      patch.attentionReason = null;
    }
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
  }

  /**
   * Set the attention marker directly. Used by AgentManager when the
   * `Notification` hook fires — that hook represents "Claude (or one of
   * its slash commands) needs the user's input", which won't always flow
   * through the MCP update_state path (e.g. interactive pickers in slash
   * commands like /feedback never call MCP). Also flips streaming off and
   * re-uses the turnComplete event so the toast logic stays in one place.
   */
  setNeedsAttention(reason: string): void {
    // Sanitize through the same gate as model-supplied markers so a
    // junk Notification payload (literal "true", "null", etc.) can't
    // surface as attention text. Fall back to a generic label if the
    // payload was unusable.
    const next = sanitizeMarkerString(reason) ?? 'Waiting for input';
    let changed = false;
    const patch: Partial<AgentSnapshot> = {};
    if (this._attentionReason !== next) {
      this._attentionReason = next;
      patch.attentionReason = next;
      changed = true;
    }
    if (this._streaming) {
      this._streaming = false;
      patch.streaming = false;
      changed = true;
    }
    if (changed) this.changeEmitter.fire(patch);
    this.turnCompleteEmitter.fire();
  }

  /** True when this agent's terminal is the active VS Code terminal. */
  isTerminalActive(): boolean {
    return !!this.terminal && vscode.window.activeTerminal === this.terminal;
  }

  /** True when this agent owns the given VS Code terminal instance. */
  ownsTerminal(t: vscode.Terminal): boolean {
    return this.terminal === t;
  }

  clearTransient(): void {
    // Called on every UserPromptSubmit. Wipes every per-turn marker — TL;DR,
    // needs-input, error, progress — so the card resets to a clean state
    // while we wait for the next response. Title is intentionally preserved:
    // it's a session-level marker that Claude only emits on the first turn.
    //
    // Sets `streaming = true` to show the blinking bubble. The Stop hook
    // (via notifyTurnComplete) is responsible for flipping it back off —
    // there's no idle-timer fallback, so an agent that crashes mid-turn
    // would stay pulsing. That's an acceptable trade for not having the
    // bubble flicker every time the user types a character.
    const patch: Partial<AgentSnapshot> = {};
    if (this._tldr !== null) {
      this._tldr = null;
      patch.tldr = null;
    }
    if (this._attentionReason !== null) {
      this._attentionReason = null;
      patch.attentionReason = null;
    }
    if (this._errorReason !== null) {
      this._errorReason = null;
      patch.errorReason = null;
    }
    if (this._progress !== null) {
      this._progress = null;
      patch.progress = null;
    }
    if (!this._streaming) {
      this._streaming = true;
      patch.streaming = true;
    }
    if (Object.keys(patch).length > 0) this.changeEmitter.fire(patch);
  }

  setManualTitle(name: string): void {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      // Empty input means "drop my override, go back to the auto-assigned
      // glance-id title". Flip titleSource to 'default' so the AI marker
      // can overwrite it from the next response.
      this._titleSource = 'default';
      this._name = `glance-${this.id.slice(3)}`;
    } else {
      this._titleSource = 'manual';
      this._name = capitalizeFirstLetter(trimmed);
    }
    this.claude?.setName(this._name);
    this.changeEmitter.fire({ name: this._name, titleSource: this._titleSource });
    this.metaChangeEmitter.fire();
  }

  reveal(): void {
    // First reveal of a dormant agent revives it — spawns the Claude PTY
    // with `--resume <sessionId>` and shows the new terminal. Subsequent
    // reveals just bring the terminal to the foreground.
    if (this._dormant) this.revive();
    this.terminal?.show(true);
  }

  /**
   * Like reveal(), but pulls focus *into* the terminal. Used when the user
   * presses Enter on a focused card — reveal() alone keeps focus on the
   * Glancer panel (preserveFocus=true) so Up/Down navigation keeps working;
   * this variant deliberately steals focus.
   */
  focusTerminal(): void {
    if (this._dormant) this.revive();
    this.terminal?.show(false);
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      name: this._name,
      titleSource: this._titleSource,
      model: this._model,
      tldr: this._tldr,
      attentionReason: this._attentionReason,
      errorReason: this._errorReason,
      progress: this._progress,
      streaming: this._streaming,
      starting: this._starting,
    };
  }

  /**
   * Tear down runtime state (PTY, terminal, watchers, emitters) but LEAVE
   * the on-disk state file in place. Called on extension shutdown so the
   * next launch can restore the agent's last-known markers from the file.
   */
  dispose(): void {
    this.stateWatcher.dispose();
    this.claude?.dispose();
    this.terminal?.dispose();
    this.changeEmitter.dispose();
    this.exitEmitter.dispose();
    this.metaChangeEmitter.dispose();
    this.turnCompleteEmitter.dispose();
  }

  /**
   * Delete the on-disk state file. Called by AgentManager only when the
   * user explicitly kills the agent (not on extension shutdown).
   */
  purgePersistentState(): void {
    try {
      fs.unlinkSync(this.stateFilePath);
    } catch {
      // file may not exist — Claude never wrote it
    }
  }

  /**
   * Applies a parsed state JSON from Claude's status file. Field semantics:
   *   - missing → leave current value alone
   *   - explicit null → clear
   *   - value → set
   */
  private applyState(s: AgentState): void {
    const patch: Partial<AgentSnapshot> = {};

    if ('tldr' in s && s.tldr !== undefined) {
      const next = sanitizeMarkerString(s.tldr);
      if (next !== this._tldr) {
        this._tldr = next;
        patch.tldr = next;
      }
    }
    if (
      'title' in s &&
      this._titleSource !== 'manual' &&
      this._titleSource !== 'rename'
    ) {
      const sanitized = sanitizeMarkerString(s.title);
      const next = sanitized !== null ? capitalizeFirstLetter(sanitized) : null;
      if (next !== null && next !== this._name) {
        this._name = next;
        this._titleSource = 'ai';
        patch.name = next;
        patch.titleSource = 'ai';
        this.claude?.setName(next);
      }
    }
    if ('needsInput' in s && s.needsInput !== undefined) {
      const next = sanitizeMarkerString(s.needsInput);
      if (next !== this._attentionReason) {
        this._attentionReason = next;
        patch.attentionReason = next;
      }
    }
    if ('error' in s && s.error !== undefined) {
      const next = sanitizeMarkerString(s.error);
      if (next !== this._errorReason) {
        this._errorReason = next;
        patch.errorReason = next;
      }
    }
    if ('progress' in s && s.progress !== undefined) {
      const p = s.progress;
      const cleanLabel =
        p && typeof p === 'object' ? sanitizeMarkerString(p.label) : null;
      const next =
        p &&
        typeof p === 'object' &&
        typeof p.value === 'number' &&
        Number.isFinite(p.value) &&
        cleanLabel !== null
          ? { value: Math.max(0, Math.min(1, p.value)), label: cleanLabel }
          : null;
      const same =
        (next === null && this._progress === null) ||
        (next !== null &&
          this._progress !== null &&
          next.value === this._progress.value &&
          next.label === this._progress.label);
      if (!same) {
        this._progress = next;
        patch.progress = next;
      }
    }

    if (Object.keys(patch).length > 0) {
      this.changeEmitter.fire(patch);
      // Name/titleSource end up in sessions.json — re-persist when either
      // moves so a restart picks up the AI-set title without losing the
      // user's manual override.
      if (patch.name !== undefined || patch.titleSource !== undefined) {
        this.metaChangeEmitter.fire();
      }
    }
  }

}
