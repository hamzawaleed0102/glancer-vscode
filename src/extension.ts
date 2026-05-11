import * as vscode from 'vscode';
import { AgentManager } from './agents/AgentManager';
import { AgentPanelProvider } from './view/AgentPanelProvider';

let manager: AgentManager | null = null;
const WALKTHROUGH_ID = 'hamzawaleed.glance-claude-code#glancer.welcome';
const WALKTHROUGH_SEEN_KEY = 'glancer.walkthrough.seen';

export function activate(context: vscode.ExtensionContext): void {
  console.log('[glancer] activate() begin');
  try {
    // Sanity-check node-pty can load in this Electron runtime.
    const pty = require('node-pty') as { spawn: unknown };
    console.log('[glancer] node-pty loaded, spawn type=', typeof pty.spawn);
  } catch (err) {
    console.error('[glancer] node-pty failed to load', err);
    vscode.window.showErrorMessage(
      `Glance: failed to load node-pty — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  manager = new AgentManager({ context });
  const provider = new AgentPanelProvider(context, manager);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentPanelProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('glancer.focusPanel', async () => {
      await vscode.commands.executeCommand(`${AgentPanelProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('glancer.newAgent', () => {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!cwd) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      manager?.newAgent({ cwd });
    }),
    vscode.commands.registerCommand('glancer.killActive', () => {
      const id = manager?.getActiveId();
      if (id) manager?.kill(id);
    }),
    { dispose: () => manager?.dispose() },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('glancer.showWalkthrough', () =>
      vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH_ID, false),
    ),
  );

  if (!context.globalState.get<boolean>(WALKTHROUGH_SEEN_KEY)) {
    // Defer one tick so the activity bar paints before the walkthrough
    // opens. The third arg `toSide=false` opens it as a full editor tab.
    setTimeout(() => {
      void vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        WALKTHROUGH_ID,
        false,
      );
      void context.globalState.update(WALKTHROUGH_SEEN_KEY, true);
    }, 0);
  }
}

export function deactivate(): void {
  manager?.dispose();
  manager = null;
}
