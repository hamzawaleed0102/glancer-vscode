import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { Agent } from './Agent';
import { nextAgentId } from './ids';
import { summarySystemPrompt } from '../markers/systemPrompt';
import type { AgentSnapshot, ClaudeModel } from '../shared/messages';

interface ManagerInit {
  context: vscode.ExtensionContext;
}

type ManagerEvent =
  | { type: 'added'; agent: AgentSnapshot }
  | { type: 'removed'; id: string }
  | { type: 'updated'; id: string; fields: Partial<AgentSnapshot> }
  | { type: 'active'; id: string | null }
  | { type: 'turnComplete'; id: string; snapshot: AgentSnapshot }
  | { type: 'unread'; total: number };

/**
 * Hook script writes one JSON file per event into the events dir. We watch that dir
 * (chokidar, 'add'), parse, route to the right Agent. The script self-heals: it
 * never throws and never blocks Claude's turn.
 */
export class AgentManager implements vscode.Disposable {
  private readonly agents = new Map<string, Agent>();
  private activeId: string | null = null;

  private readonly storageDir: string;
  private readonly eventsDir: string;
  private readonly stateDir: string;
  private readonly hookScriptPath: string;
  private readonly mcpServerPath: string;
  private readonly hookSettingsPath: string;
  private readonly mcpConfigPath: string;
  private readonly instructionsPath: string;
  private readonly sessionsFile: string;
  private readonly eventsWatcher: FSWatcher;

  private readonly changeEmitter = new vscode.EventEmitter<ManagerEvent>();
  readonly onChange = this.changeEmitter.event;

  constructor(init: ManagerInit) {
    this.storageDir = init.context.globalStorageUri.fsPath;
    fs.mkdirSync(this.storageDir, { recursive: true });

    this.eventsDir = path.join(this.storageDir, 'events');
    fs.mkdirSync(this.eventsDir, { recursive: true });

    // Per-agent JSON status files live here. Claude is instructed (via the
    // system prompt) to overwrite its file with `{title, tldr, progress,
    // needsInput, error}` after every response; each agent watches its own
    // file and routes the fields into the snapshot.
    this.stateDir = path.join(this.storageDir, 'state');
    fs.mkdirSync(this.stateDir, { recursive: true });

    // Copy the hook and MCP server scripts to storageDir so they have stable
    // absolute paths even when the extension is updated.
    this.hookScriptPath = path.join(this.storageDir, 'hook.mjs');
    const bundledHookPath = path.join(init.context.extensionPath, 'out', 'markers', 'hook.mjs');
    try {
      fs.copyFileSync(bundledHookPath, this.hookScriptPath);
      fs.chmodSync(this.hookScriptPath, 0o755);
    } catch (err) {
      console.warn('[glancer] failed to install hook script:', err);
    }

    this.mcpServerPath = path.join(this.storageDir, 'mcp-server.mjs');
    const bundledMcpPath = path.join(
      init.context.extensionPath,
      'out',
      'markers',
      'mcp-server.mjs',
    );
    try {
      fs.copyFileSync(bundledMcpPath, this.mcpServerPath);
      fs.chmodSync(this.mcpServerPath, 0o755);
    } catch (err) {
      console.warn('[glancer] failed to install MCP server script:', err);
    }

    this.hookSettingsPath = path.join(this.storageDir, 'hook-settings.json');
    // Claude Code runs hook commands through `/bin/sh -c`, so the path must be
    // shell-quoted. VS Code's globalStorageUri lives under
    // "~/Library/Application Support/..." on macOS — the space breaks
    // unquoted invocation.
    const shellQuoted = `'${this.hookScriptPath.replace(/'/g, `'\\''`)}'`;
    // Claude Code's hook schema: each event maps to an array of matcher groups,
    // each carrying its own `hooks` array of command entries. Empty `matcher`
    // means "match every invocation".
    const matcherGroup = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: shellQuoted }],
      },
    ];
    fs.writeFileSync(
      this.hookSettingsPath,
      JSON.stringify(
        {
          hooks: {
            Stop: matcherGroup,
            UserPromptSubmit: matcherGroup,
            Notification: matcherGroup,
            SessionStart: matcherGroup,
          },
        },
        null,
        2,
      ),
    );

    // Glancer system instructions. The MCP server reads this file on
    // startup and returns its contents in the `initialize` response's
    // `instructions` field — the official MCP mechanism for surfacing
    // prompt-like guidance to the model. Written first so the path baked
    // into mcp-config.json (and read by Claude Code at session start)
    // already exists.
    this.instructionsPath = path.join(this.storageDir, 'glancer-instructions.txt');
    fs.writeFileSync(this.instructionsPath, summarySystemPrompt(''));

    this.mcpConfigPath = path.join(this.storageDir, 'mcp-config.json');
    fs.writeFileSync(
      this.mcpConfigPath,
      JSON.stringify(
        {
          mcpServers: {
            glancer: {
              command: 'node',
              args: [this.mcpServerPath],
              // The MCP server reads this file on startup and returns its
              // contents in the `initialize` response's `instructions`
              // field — the official MCP mechanism for surfacing
              // prompt-like guidance to the model. This is why we no
              // longer need `--append-system-prompt` on the claude CLI.
              env: {
                GLANCER_INSTRUCTIONS_FILE: this.instructionsPath,
              },
            },
          },
        },
        null,
        2,
      ),
    );

    this.eventsWatcher = chokidar.watch(this.eventsDir, {
      persistent: true,
      ignoreInitial: true,
      usePolling: true,
      interval: 200,
    });
    this.eventsWatcher.on('add', (filePath: string) => {
      console.log('[glancer] events watcher: add', filePath);
      this.handleHookEvent(filePath);
    });
    this.eventsWatcher.on('ready', () => {
      console.log('[glancer] events watcher ready, dir=', this.eventsDir);
    });
    this.eventsWatcher.on('error', (err) => {
      console.error('[glancer] events watcher error', err);
    });

    // Sessions persistence: array of dormant-agent metadata that survives
    // across VS Code launches. The marker state (tldr/progress/etc.) lives
    // alongside in `state/<id>.json` files written by Claude via MCP.
    this.sessionsFile = path.join(this.storageDir, 'sessions.json');
    this.restorePersistedAgents();
  }

  /**
   * Read sessions.json (if present) and reconstruct each entry as a dormant
   * Agent. The card appears in the panel immediately with the last-known
   * snapshot; the PTY isn't spawned until the user clicks the card (which
   * calls reveal() → revive() and starts claude with `--resume <id>`).
   */
  private restorePersistedAgents(): void {
    console.log('[glancer] restorePersistedAgents: reading', this.sessionsFile);
    let raw: string;
    try {
      raw = fs.readFileSync(this.sessionsFile, 'utf8');
    } catch (err) {
      console.log(
        `[glancer] restorePersistedAgents: no sessions file (err=${err instanceof Error ? err.message : err})`,
      );
      return;
    }
    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      console.warn(`[glancer] restorePersistedAgents: parse failed (${err}), raw=${raw.slice(0, 200)}`);
      return;
    }
    if (!Array.isArray(entries)) {
      console.warn('[glancer] restorePersistedAgents: file is not an array, ignoring');
      return;
    }
    console.log(`[glancer] restorePersistedAgents: found ${entries.length} entries`);
    for (const e of entries as Array<{
      id: string;
      cwd: string;
      model: ClaudeModel;
      sessionId: string | null;
      name: string;
      titleSource: AgentSnapshot['titleSource'];
      hasUserPrompt?: boolean;
    }>) {
      if (!e || typeof e.id !== 'string' || typeof e.cwd !== 'string') {
        console.warn('[glancer] restorePersistedAgents: skipping malformed entry', e);
        continue;
      }
      // Skip if the workspace folder no longer exists — Claude's --resume
      // would fail anyway, and the user can't meaningfully interact.
      if (!fs.existsSync(e.cwd)) {
        console.warn(`[glancer] restorePersistedAgents: skipping ${e.id} — cwd missing: ${e.cwd}`);
        continue;
      }
      const agent = this.makeAgent({
        id: e.id,
        cwd: e.cwd,
        model: e.model ?? 'default',
        dormant: true,
        sessionId: e.sessionId ?? null,
        initialSnapshot: {
          name: e.name,
          titleSource: e.titleSource,
        },
        hasUserPrompt: e.hasUserPrompt ?? true,
      });
      this.agents.set(e.id, agent);
      console.log(`[glancer] restored dormant ${e.id} name="${e.name}" sessionId=${e.sessionId ?? 'null'}`);
    }
    console.log(`[glancer] restorePersistedAgents: created ${this.agents.size} dormant agent(s)`);
  }

  /**
   * Serialize the current agent set to sessions.json. Called whenever an
   * agent is added, removed, or fires `onMetaChange` (sessionId / name /
   * titleSource updates). The marker fields (tldr / progress / etc.) are
   * NOT in this file — they live in each agent's state/<id>.json.
   */
  private persist(): void {
    // Only persist agents the user has actually chatted with. Empty sessions
    // (auto-spawned card, no UserPromptSubmit yet) have a sessionId from
    // SessionStart but no JSONL on disk — `claude --resume <id>` fails on
    // those with "No conversation found with session ID". Filtering them
    // out keeps the restore path clean.
    const entries = Array.from(this.agents.values())
      .filter((a) => a.hasUserPrompt)
      .map((a) => ({
        id: a.id,
        cwd: a.cwd,
        model: a.model,
        sessionId: a.sessionId,
        name: a.name,
        titleSource: a.titleSource,
        hasUserPrompt: true,
      }));
    try {
      fs.writeFileSync(this.sessionsFile, JSON.stringify(entries, null, 2));
      const skipped = this.agents.size - entries.length;
      console.log(
        `[glancer] persist: wrote ${entries.length} agent(s) to ${this.sessionsFile}` +
          (skipped > 0 ? ` (${skipped} unprompted skipped)` : ''),
      );
    } catch (err) {
      console.warn('[glancer] failed to persist sessions:', err);
    }
  }

  /** Common Agent construction wiring used by both `newAgent` and restore. */
  private makeAgent(opts: {
    id: string;
    cwd: string;
    model: ClaudeModel;
    dormant?: boolean;
    sessionId?: string | null;
    initialSnapshot?: { name?: string; titleSource?: AgentSnapshot['titleSource'] };
    hasUserPrompt?: boolean;
  }): Agent {
    const agent = new Agent({
      id: opts.id,
      cwd: opts.cwd,
      model: opts.model,
      hookSettingsPath: this.hookSettingsPath,
      mcpConfigPath: this.mcpConfigPath,
      eventsDir: this.eventsDir,
      hookScriptPath: this.hookScriptPath,
      stateFilePath: path.join(this.stateDir, `${opts.id}.json`),
      dormant: opts.dormant,
      sessionId: opts.sessionId,
      initialSnapshot: opts.initialSnapshot,
      hasUserPrompt: opts.hasUserPrompt,
    });
    agent.onChange((fields) => {
      this.changeEmitter.fire({ type: 'updated', id: opts.id, fields });
      // Any change to attentionReason or errorReason can shift the badge
      // count. Cheap: O(agents). Re-emit unconditionally on any update so
      // we don't have to special-case those fields here AND in setNeedsAttention.
      if ('attentionReason' in fields || 'errorReason' in fields) {
        this.emitUnreadCount();
      }
    });
    agent.onMetaChange(() => this.persist());
    agent.onTurnComplete(() =>
      this.changeEmitter.fire({
        type: 'turnComplete',
        id: opts.id,
        snapshot: agent.snapshot(),
      }),
    );
    // NOTE: we deliberately do NOT auto-remove on PTY exit. VS Code reload
    // and accidental terminal closure both fire exit, and removing on those
    // events wipes sessions.json out from under us. The Agent transitions
    // to dormant on its own (see Agent.becomeDormant). Permanent removal
    // only happens via the explicit Glancer kill button → removeAgent().
    return agent;
  }

  list(): AgentSnapshot[] {
    return Array.from(this.agents.values()).map((a) => a.snapshot());
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  newAgent(opts: { cwd: string; model?: ClaudeModel }): string {
    const id = nextAgentId(this.agents.keys());
    const agent = this.makeAgent({
      id,
      cwd: opts.cwd,
      model: opts.model ?? 'default',
    });
    this.agents.set(id, agent);
    this.changeEmitter.fire({ type: 'added', agent: agent.snapshot() });
    this.setActive(id);
    agent.reveal();
    this.persist();
    return id;
  }

  kill(id: string): void {
    this.removeAgent(id);
  }

  private removeAgent(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    const wasCounted = a.needsAttention;
    // Delete from the map FIRST so the async `proc.onExit` triggered by
    // `a.dispose()` re-enters this function as a no-op.
    this.agents.delete(id);
    this.changeEmitter.fire({ type: 'removed', id });
    if (this.activeId === id) {
      const next = this.agents.keys().next().value ?? null;
      this.setActive(next);
    }
    a.dispose();
    // User-initiated removal: also drop the persisted state file so a future
    // agent with the same id (very unlikely) doesn't pick up stale markers.
    a.purgePersistentState();
    this.persist();
    // Removing an attention-state agent drops the badge by one.
    if (wasCounted) this.emitUnreadCount();
  }

  select(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    this.setActive(id);
    a.reveal();
  }

  /**
   * Set active + show terminal with focus stolen into it. Wired to Enter on
   * a focused card in the webview; arrow navigation uses `select` so the
   * panel keeps keyboard focus.
   */
  focusTerminal(id: string): void {
    const a = this.agents.get(id);
    if (!a) return;
    this.setActive(id);
    a.focusTerminal();
  }

  /** True if the agent's terminal is the currently active VS Code terminal. */
  isAgentTerminalActive(id: string): boolean {
    return !!this.agents.get(id)?.isTerminalActive();
  }

  /**
   * Reveal the active agent's terminal without stealing focus. Used by
   * the provider when the user focuses Glancer — calling `terminal.show()`
   * un-hides the bottom panel if it was Cmd+J'd, so the user lands in a
   * workspace where both panels are visible.
   */
  revealActiveTerminal(): void {
    if (!this.activeId) return;
    this.agents.get(this.activeId)?.reveal();
  }

  /**
   * Total agents currently showing an "attention" or "error" marker.
   * Drives the activity-bar badge — simple state-derived count, no
   * "read/unread" bookkeeping. As soon as Claude clears the attentionReason
   * (e.g. via clearTransient on the next UserPromptSubmit) the count drops.
   */
  unreadCount(): number {
    let n = 0;
    for (const a of this.agents.values()) if (a.needsAttention) n++;
    return n;
  }

  /**
   * Fire `unread` event with the current total. Called whenever an agent's
   * attentionReason/errorReason changes, or an agent is removed.
   */
  private emitUnreadCount(): void {
    this.changeEmitter.fire({ type: 'unread', total: this.unreadCount() });
  }

  rename(id: string, name: string): void {
    this.agents.get(id)?.setManualTitle(name);
  }

  resetTitle(id: string): void {
    this.agents.get(id)?.setManualTitle('');
  }

  /**
   * Rebuild the internal agents Map in the order supplied by the
   * webview after a drag-drop. Map preserves insertion order, so
   * subsequent `list()` / `persist()` calls naturally follow the new
   * sequence. Any agents missing from the input list are appended at
   * the end (defensive — shouldn't happen in practice since the webview
   * sends the full ordering).
   */
  reorder(ids: string[]): void {
    const entries: [string, Agent][] = [];
    for (const id of ids) {
      const a = this.agents.get(id);
      if (a) entries.push([id, a]);
    }
    for (const [id, a] of this.agents) {
      if (!entries.some(([eid]) => eid === id)) entries.push([id, a]);
    }
    this.agents.clear();
    for (const [id, a] of entries) this.agents.set(id, a);
    this.persist();
  }

  private setActive(id: string | null): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.changeEmitter.fire({ type: 'active', id });
  }

  private handleHookEvent(filePath: string): void {
    let payload: unknown;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      payload = JSON.parse(raw);
    } catch (err) {
      console.warn('[glancer] failed to read hook event', filePath, err);
      return;
    } finally {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // ignore
      }
    }
    if (typeof payload !== 'object' || payload === null) return;
    const wrapper = payload as {
      agentId?: string;
      payload?: {
        hook_event_name?: string;
        session_id?: string;
        prompt?: string;
        message?: string;
        // SessionStart hook reports how the session began. Values per
        // Claude Code: 'startup' (fresh), 'resume' (--resume <id>),
        // 'clear' (/clear), 'compact' (/compact).
        source?: 'startup' | 'resume' | 'clear' | 'compact';
      };
    };
    const agentId = wrapper.agentId;
    const hookEvent = wrapper.payload?.hook_event_name;
    const sessionId = wrapper.payload?.session_id;
    console.log('[glancer] hook event:', { agentId, hookEvent, sessionId });
    if (!agentId) return;
    const agent = this.agents.get(agentId);
    if (!agent) {
      console.warn('[glancer] hook event for unknown agent', agentId);
      return;
    }
    if (hookEvent === 'SessionStart') {
      // Capture the Claude session id (if present) so --resume works on
      // next launch. The sessionId can be absent in some SessionStart
      // payloads — that's fine, we don't require it for the reset.
      if (sessionId) agent.setSessionId(sessionId);
      // /clear (and /compact) start a fresh conversation. Any tldr /
      // attention / error / progress from the prior session is stale,
      // and the badge would stay stuck on a now-meaningless "needs
      // input" marker. Wipe it. 'startup' and 'resume' deliberately
      // preserve state.
      const source = wrapper.payload?.source;
      console.log('[glancer] SessionStart source=', source);
      if (source === 'clear' || source === 'compact') {
        agent.resetCardState();
      }
    } else if (hookEvent === 'UserPromptSubmit') {
      // First UserPromptSubmit promotes the agent from "empty session"
      // (won't survive --resume) to "real session" (persisted across
      // launches). Also clears transient marker rows — that wipes
      // attentionReason/errorReason which naturally drops this agent's
      // badge contribution.
      agent.markUserPrompted();
      agent.clearTransient();
    } else if (hookEvent === 'Stop') {
      // Claude's Stop hook fires when a response finishes — the canonical
      // "agent done, ball is in user's court" signal. We bubble this up so
      // the provider can chime + show a VS Code notification.
      agent.notifyTurnComplete();
    } else if (hookEvent === 'Notification') {
      // Notification hook fires for two distinct cases:
      //   1. Real attention required — tool-permission prompts, slash-
      //      command interactive pickers (e.g. /feedback). These fire
      //      mid-turn, while the agent is streaming.
      //   2. Claude Code's 60s idle timeout — fires automatically after
      //      a clean turn already ended. Streaming is already false by
      //      the time this arrives (Stop fired first). Informational
      //      only, not a real attention request.
      // Gate primarily on streaming state: if the turn already ended,
      // ignore the Notification regardless of its wording. Without this
      // every finished green ✓ card flipped to yellow attention after
      // a minute of user idle time. Message-regex kept as a defensive
      // fallback for the rare race where idle fires before Stop is
      // processed.
      if (!agent.streaming) {
        console.log('[glancer] Notification: skipping (turn already ended)');
        return;
      }
      const payload = wrapper.payload as { message?: string } | undefined;
      const raw = typeof payload?.message === 'string' ? payload.message.trim() : '';
      if (/claude is waiting for your input/i.test(raw)) {
        console.log('[glancer] Notification: skipping idle-timeout ping');
        return;
      }
      const message = raw || 'Waiting for input';
      agent.setNeedsAttention(message);
    }
  }

  dispose(): void {
    for (const a of this.agents.values()) a.dispose();
    this.agents.clear();
    this.eventsWatcher.close();
    this.changeEmitter.dispose();
  }
}
