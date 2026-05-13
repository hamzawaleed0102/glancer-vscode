import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { AgentManager } from '../agents/AgentManager';
import type { HostToWebview, WebviewToHost } from '../shared/messages';

export class AgentPanelProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'glancer.agents';

  private view: vscode.WebviewView | null = null;
  /**
   * Becomes true after we've auto-spawned the first agent for this extension
   * activation. Re-mounting the webview (e.g., the user toggles the Glancer
   * activity-bar away and back) shouldn't keep adding agents; if they killed
   * every session deliberately, we respect that and leave the panel empty.
   */
  private autoStarted = false;
  /**
   * Tracks whether the webview iframe currently has focus. Updated from
   * `panelFocus` messages the webview posts on its own window focus/blur.
   * Used to suppress turn-complete toasts when the user is already looking
   * at the panel.
   */
  private panelFocused = false;
  /**
   * Agent id that should grab terminal focus once-only. Set when we
   * auto-spawn the first agent at activation, consumed either by the
   * 120ms timeout or by the first `panelFocus(true)` we receive —
   * whichever fires first. The double path is needed because:
   *   - When the user clicks the Glancer icon, focus is racing with our
   *     timeout; the 120ms delay usually wins.
   *   - When VS Code launches with Glancer already focused (the panel
   *     was the active view when the workspace last closed), launch
   *     is too busy in the first 120ms — the focus call gets lost. The
   *     panelFocus message fires later and re-attempts.
   */
  private pendingFocusTerminalId: string | null = null;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: AgentManager,
  ) {
    manager.onChange((evt) => {
      if (!this.view) return;
      let msg: HostToWebview;
      switch (evt.type) {
        case 'added':
          msg = { type: 'agentAdded', agent: evt.agent };
          break;
        case 'removed':
          msg = { type: 'agentRemoved', id: evt.id };
          break;
        case 'updated':
          msg = { type: 'agentUpdate', id: evt.id, fields: evt.fields };
          break;
        case 'active':
          msg = { type: 'activeChanged', id: evt.id };
          break;
        case 'turnComplete':
          // Toast notification with a "Show" action that jumps to the
          // agent's terminal. The notification body itself isn't clickable
          // in VS Code — the action button is the supported affordance.
          // Also bumps the activity-bar badge if the user wasn't watching.
          this.handleTurnComplete(evt.snapshot);
          return;
        case 'unread':
          this.updateBadge();
          return;
      }
      this.view.webview.postMessage(msg);
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview')],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: WebviewToHost) => this.handle(m));
    // Seed the badge from current state. Agents may have been restored
    // (with persisted attention/error markers) BEFORE this view resolved,
    // so the `unread` events fired during restore would have hit a null
    // view and been dropped.
    this.updateBadge();
  }

  /**
   * Single point that pushes the current attention-count to the
   * activity-bar badge. Called from both the `unread` event handler and
   * `resolveWebviewView` so the badge stays in sync with manager state.
   */
  private updateBadge(): void {
    if (!this.view) return;
    const total = this.manager.unreadCount();
    this.view.badge = total > 0
      ? {
          value: total,
          tooltip: `${total} agent${total === 1 ? '' : 's'} need attention`,
        }
      : undefined;
  }

  /**
   * Toast-only turn-complete handler. The activity-bar badge is driven
   * separately by `unread` events the manager emits whenever any agent's
   * attentionReason/errorReason changes — no explicit mark-as-read
   * bookkeeping here.
   */
  private handleTurnComplete(snapshot: import('../shared/messages').AgentSnapshot): void {
    if (this.userIsWatching(snapshot.id)) return;

    // Prefer attentionReason (Notification hook) over tldr (Stop hook) —
    // an "awaiting input" message is more actionable than a turn summary.
    const detail = snapshot.attentionReason ?? snapshot.tldr;
    const body = detail
      ? `${snapshot.name} — ${detail}`
      : `${snapshot.name} is ready`;
    // Audible cue paired with the toast — useful when the user is in
    // another app or another tab and the toast is off-screen.
    this.view?.webview.postMessage({ type: 'playTone' } satisfies HostToWebview);
    vscode.window.showInformationMessage(body, 'Show').then((picked) => {
      if (picked === 'Show') this.manager.focusTerminal(snapshot.id);
    });
  }

  /**
   * "Is the user actively watching THIS agent right now?" — used to gate
   * both the toast and the unread badge. Strict per-agent check: panel
   * focus alone isn't enough (the user might be looking at a different
   * card), only panel-focused + this-agent-is-active counts. This means
   * an agent finishing in the background still bumps the badge even when
   * you're in Glancer looking at a different session.
   */
  private userIsWatching(id: string): boolean {
    if (!vscode.window.state.focused) return false;
    if (this.manager.isAgentTerminalActive(id)) return true;
    if (this.panelFocused && this.manager.getActiveId() === id) return true;
    return false;
  }

  /**
   * Try to consume the pending focus once. Different from
   * scheduleFocusRetries: this one is the "panelFocus arrived first"
   * code path, single-shot.
   */
  private tryConsumePendingFocus(): void {
    const id = this.pendingFocusTerminalId;
    if (!id) return;
    this.pendingFocusTerminalId = null;
    this.manager.focusTerminal(id);
  }

  /**
   * Fire `focusTerminal` at multiple delays after auto-spawn to win the
   * focus race against VS Code's launch sequence. Each attempt no-ops
   * once the terminal is already the active VS Code terminal — so the
   * extra calls cost nothing once one of them lands.
   */
  private scheduleFocusRetries(id: string): void {
    const delays = [150, 400, 900, 1600];
    for (const delay of delays) {
      setTimeout(() => {
        // Clear the pending flag once any retry runs so the panelFocus
        // backup path doesn't double-trigger.
        if (this.pendingFocusTerminalId === id) {
          this.pendingFocusTerminalId = null;
        }
        if (this.manager.isAgentTerminalActive(id)) return; // already won
        this.manager.focusTerminal(id);
      }, delay);
    }
  }

  focus(): void {
    // `show(true)` here means `preserveFocus = true` for the *view* — i.e.
    // expand & reveal it but don't yank focus to it. Counter-intuitive name,
    // but matches WebviewView.show's signature. We then post `focus` so the
    // webview itself pulls keyboard focus into AgentList's container, where
    // Up/Down/Enter/G are handled.
    this.view?.show(true);
    this.view?.webview.postMessage({ type: 'focus' } satisfies HostToWebview);
  }

  private handle(m: WebviewToHost): void {
    switch (m.type) {
      case 'ready': {
        // Auto-spawn the first agent on initial launch so the user doesn't
        // have to click "New Session" to get started. Send `state` first so
        // the webview clears any stale list, then `newAgent` triggers a
        // separate `agentAdded` postMessage from the manager.
        this.view?.webview.postMessage({
          type: 'state',
          agents: this.manager.list(),
          activeId: this.manager.getActiveId(),
        } satisfies HostToWebview);
        if (!this.autoStarted && this.manager.list().length === 0) {
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (cwd) {
            this.autoStarted = true;
            const id = this.manager.newAgent({ cwd });
            this.pendingFocusTerminalId = id;
            // Multi-shot retry — VS Code launch is busy for the first
            // few hundred ms and a single focus call gets eaten. Each
            // attempt no-ops once the terminal is already active.
            this.scheduleFocusRetries(id);
          }
        }
        break;
      }
      case 'newAgent': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('Open a workspace folder first.');
          return;
        }
        const id = this.manager.newAgent({ cwd, model: m.model });
        // Pull focus into the new agent's terminal so the user can type
        // immediately. Same multi-retry as the auto-spawn path because
        // the PTY needs a beat to attach before show(false) takes effect.
        this.pendingFocusTerminalId = id;
        this.scheduleFocusRetries(id);
        break;
      }
      case 'select':
        this.manager.select(m.id);
        break;
      case 'focusTerminal':
        this.manager.focusTerminal(m.id);
        break;
      case 'panelFocus':
        this.panelFocused = m.focused;
        // Second chance to focus the auto-spawned terminal — fires when
        // VS Code launched with the Glancer panel already focused and
        // the initial 120ms attempt happened too early to win.
        if (m.focused) this.tryConsumePendingFocus();
        break;
      case 'kill':
        this.manager.kill(m.id);
        break;
      case 'rename':
        this.manager.rename(m.id, m.name);
        break;
      case 'resetTitle':
        this.manager.resetTitle(m.id);
        break;
      case 'reorder':
        this.manager.reorder(m.ids);
        break;
      case 'listOldSessions': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          this.view?.webview.postMessage({
            type: 'oldSessions',
            sessions: [],
          } satisfies HostToWebview);
          return;
        }
        this.manager.listOldSessions(cwd).then((sessions) => {
          this.view?.webview.postMessage({
            type: 'oldSessions',
            sessions,
          } satisfies HostToWebview);
        });
        break;
      }
      case 'openOldSession': {
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!cwd) {
          vscode.window.showWarningMessage('Open a workspace folder first.');
          return;
        }
        const id = this.manager.openOldSession({ cwd, sessionId: m.sessionId });
        // Reuse the same focus-race protection as `newAgent` — VS Code
        // launch is busy for a few hundred ms after the PTY attaches.
        this.pendingFocusTerminalId = id;
        this.scheduleFocusRetries(id);
        break;
      }
      case 'toggleMaximizedPanel':
        void vscode.commands.executeCommand('workbench.action.toggleMaximizedPanel');
        break;
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'main.js'),
    );
    const stylesUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'out', 'webview', 'styles.css'),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `img-src ${webview.cspSource} data:`,
    ].join('; ');
    const indexHtmlPath = path.join(
      this.context.extensionPath,
      'out',
      'webview',
      'index.html',
    );
    let template: string;
    try {
      template = fs.readFileSync(indexHtmlPath, 'utf8');
    } catch {
      template = `<!DOCTYPE html>
<html><head><meta http-equiv="Content-Security-Policy" content="__CSP__"><link rel="stylesheet" href="__STYLES__"></head>
<body><div id="root"></div><script src="__SCRIPT__"></script></body></html>`;
    }
    return template
      .replace(/__CSP__/g, csp)
      .replace(/__SCRIPT__/g, scriptUri.toString())
      .replace(/__STYLES__/g, stylesUri.toString());
  }
}
