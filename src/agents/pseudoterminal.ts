import * as vscode from 'vscode';
import * as pty from 'node-pty';

export interface ClaudePtyOpts {
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
  /** Initial command to run after the shell starts (the `clear && claude …` line). */
  initialCommand: string;
}

export interface ClaudePty {
  pty: vscode.Pseudoterminal;
  /** Fires for every chunk written by node-pty. */
  onData: vscode.Event<string>;
  /** Fires once when node-pty exits. */
  onExit: vscode.Event<{ exitCode: number; signal?: number }>;
  /**
   * Fires once when Claude's TUI has finished booting (alt-screen entered)
   * or the 2s fallback elapses. Until then the terminal display is held on a
   * "starting session…" placeholder so the user never sees the shell echo of
   * the `claude --append-system-prompt …` invocation.
   */
  onStartupComplete: vscode.Event<void>;
  /**
   * Update the VS Code terminal tab title. The Pseudoterminal API surfaces
   * this via `onDidChangeName`; firing it makes VS Code repaint the tab.
   */
  setName(name: string): void;
  /** Force-kill the underlying process. */
  dispose(): void;
}

// 5s is long enough for a cold-start Claude on a busy machine (the 2nd
// agent in a freshly-opened VS Code window often takes 3-4s to reach
// alt-screen because of CPU/IO contention with the first agent's startup),
// but short enough that a genuinely broken `claude` binary surfaces an
// actionable screen instead of a hung placeholder.
const STARTUP_TIMEOUT_MS = 5000;
const ALT_SCREEN_MARKERS = ['\x1b[?1049h', '\x1b[?1047h', '\x1b[?47h'];
// Clear the entire screen + scrollback and park the cursor at home before we
// hand control to Claude's TUI. Without the scrollback wipe (\x1b[3J) the
// user can scroll up and see the buffered system-prompt invocation.
const SCREEN_RESET = '\x1b[2J\x1b[3J\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// Pacman-style startup placeholder. A bright-white label sits above a
// yellow pacman munching its way across a row of dim grey dots, mouth
// flapping each frame. Loops every ~22 frames.
const LABEL_TEXT = 'Starting Claude session';
const LABEL = `\x1b[1;97m${LABEL_TEXT}\x1b[0m`;
const PACMAN_YELLOW = '\x1b[38;2;255;204;0m';
const DOT_DIM = '\x1b[38;2;110;110;110m';
const RESET = '\x1b[0m';
const MOUTH_OPEN = 'C';
const MOUTH_CLOSED = 'O';
const DOT_CHAR = '.';
// 11 cells (pacman + up to 10 dots), each rendered with one column of
// spacing between, so the visible bar width is `2 * cells - 1 = 21` cols.
const PACMAN_CELLS = 11;
const PACMAN_BAR_WIDTH = PACMAN_CELLS * 2 - 1;
const LABEL_WIDTH = LABEL_TEXT.length;
const FRAME_COUNT = PACMAN_CELLS * 2;
const FRAME_INTERVAL_MS = 120;

function buildPacmanBar(frame: number): string {
  const pos = Math.floor(frame / 2) % PACMAN_CELLS;
  const pacChar = frame % 2 === 0 ? MOUTH_OPEN : MOUTH_CLOSED;
  const cells: string[] = [];
  for (let i = 0; i < PACMAN_CELLS; i++) {
    if (i < pos) cells.push(' ');
    else if (i === pos) cells.push(`${PACMAN_YELLOW}${pacChar}${RESET}`);
    else cells.push(`${DOT_DIM}${DOT_CHAR}${RESET}`);
  }
  return cells.join(' ');
}

function buildPlaceholderFrame(frame: number, cols: number, rows: number): string {
  // Center the label + the pacman bar (one row below) inside the current
  // terminal dimensions. Cursor positioning is 1-based; clamp to 1 so a
  // tiny pane still renders something rather than ANSI errors.
  const row = Math.max(1, Math.floor(rows / 2));
  const labelCol = Math.max(1, Math.floor((cols - LABEL_WIDTH) / 2) + 1);
  const barCol = Math.max(1, Math.floor((cols - PACMAN_BAR_WIDTH) / 2) + 1);
  const labelLine = `\x1b[${row};${labelCol}H${LABEL}`;
  const barLine = `\x1b[${row + 1};${barCol}H${buildPacmanBar(frame)}`;
  return `${SCREEN_RESET}${HIDE_CURSOR}${labelLine}${barLine}`;
}

export function createClaudePty(opts: ClaudePtyOpts): ClaudePty {
  const writeEmitter = new vscode.EventEmitter<string>();
  const closeEmitter = new vscode.EventEmitter<number>();
  const dataEmitter = new vscode.EventEmitter<string>();
  const exitEmitter = new vscode.EventEmitter<{ exitCode: number; signal?: number }>();
  const startupCompleteEmitter = new vscode.EventEmitter<void>();
  const nameEmitter = new vscode.EventEmitter<string>();

  let proc: pty.IPty | null = null;
  let cols = 100;
  let rows = 30;
  let started = false;

  // Phase machine: buffer PTY output until Claude enters alt-screen, then
  // emit only the alt-screen-onward portion to the VS Code terminal. This
  // hides the shell echo of `clear && claude --append-system-prompt …` from
  // the user.
  let phase: 'starting' | 'ready' = 'starting';
  let startupBuf = '';
  let startupTimer: NodeJS.Timeout | null = null;
  let placeholderShown = false;
  let placeholderTimer: NodeJS.Timeout | null = null;
  let placeholderFrame = 0;

  const stopPlaceholderAnimation = () => {
    if (placeholderTimer) {
      clearInterval(placeholderTimer);
      placeholderTimer = null;
    }
  };

  const showPlaceholderOnce = () => {
    if (placeholderShown) return;
    placeholderShown = true;
    writeEmitter.fire(buildPlaceholderFrame(0, cols, rows));
    placeholderTimer = setInterval(() => {
      placeholderFrame = (placeholderFrame + 1) % FRAME_COUNT;
      writeEmitter.fire(buildPlaceholderFrame(placeholderFrame, cols, rows));
    }, FRAME_INTERVAL_MS);
  };

  const completeStartup = (flushFrom: number) => {
    if (phase === 'ready') return;
    phase = 'ready';
    stopPlaceholderAnimation();
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    // Wipe the placeholder, then emit everything from flushFrom onward.
    //
    // - Alt-screen path: flushFrom is the marker index, so the terminal
    //   sees the enter-alt-screen sequence cleanly and Claude paints on a
    //   fresh buffer (anything echoed by the shell before the marker is
    //   discarded).
    // - Timeout path: flushFrom is 0. We flush the whole buffer. With the
    //   variable-expansion trick in Agent.ts, the only thing the shell
    //   echoes is a short one-line command like
    //     `_GP="$(cat '<path>')" && clear && claude --settings '<path>' …`
    //   — no system-prompt content. A brief leak of that line is far
    //   better than a totally blank terminal that hides whatever Claude
    //   was about to paint.
    const tail = startupBuf.slice(flushFrom);
    startupBuf = '';
    // Restore the cursor (the animation hid it) before Claude's TUI takes
    // over; Claude will set its own cursor preference once it boots, but
    // in the timeout path (where Claude hasn't painted yet) we need this
    // so the terminal isn't left without one.
    const cursor = SHOW_CURSOR;
    if (tail.length > 0) writeEmitter.fire(SCREEN_RESET + cursor + tail);
    else writeEmitter.fire(SCREEN_RESET + cursor);
    startupCompleteEmitter.fire();
  };

  const start = () => {
    if (started) return;
    started = true;
    showPlaceholderOnce();
    try {
      proc = pty.spawn(opts.shell, [], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: opts.cwd,
        env: opts.env,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      writeEmitter.fire(
        `\x1b[31m[glancer] pty.spawn failed:\x1b[0m\r\n${msg.replace(/\n/g, '\r\n')}\r\n`,
      );
      console.error('[glancer] pty.spawn failed', err);
      // Spawn failed entirely — we already wrote the error banner above.
      // Flip phase to ready without flushing so the banner stays put.
      phase = 'ready';
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      startupCompleteEmitter.fire();
      return;
    }
    proc.onData((data) => {
      dataEmitter.fire(data);
      if (phase === 'ready') {
        writeEmitter.fire(data);
        return;
      }
      startupBuf += data;
      for (const marker of ALT_SCREEN_MARKERS) {
        const idx = startupBuf.indexOf(marker);
        if (idx >= 0) {
          completeStartup(idx);
          return;
        }
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      exitEmitter.fire({ exitCode, signal });
      closeEmitter.fire(exitCode);
    });
    startupTimer = setTimeout(() => {
      // Deadline reached. Flush whatever's in the buffer (now just a short
      // shell command line, not the system prompt — see Agent.ts for the
      // variable-expansion trick) so the user sees something rather than a
      // hung "Starting…" placeholder. If Claude paints alt-screen shortly
      // after, its content will simply overlay the flushed shell echo.
      completeStartup(0);
    }, STARTUP_TIMEOUT_MS);
    // Give the shell a brief moment to come up before injecting the command.
    setTimeout(() => {
      try {
        proc?.write(opts.initialCommand + '\r');
      } catch (err) {
        console.error('[glancer] failed to write initial command', err);
      }
    }, 50);
  };

  const pseudoterminal: vscode.Pseudoterminal = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    onDidChangeName: nameEmitter.event,
    open(initialDimensions) {
      if (initialDimensions) {
        cols = Math.max(20, initialDimensions.columns);
        rows = Math.max(5, initialDimensions.rows);
      }
      start();
    },
    close() {
      proc?.kill();
      proc = null;
    },
    handleInput(data) {
      proc?.write(data);
    },
    setDimensions(dim) {
      cols = Math.max(20, dim.columns);
      rows = Math.max(5, dim.rows);
      try {
        proc?.resize(cols, rows);
      } catch {
        // proc may have exited
      }
    },
  };

  return {
    pty: pseudoterminal,
    onData: dataEmitter.event,
    onExit: exitEmitter.event,
    onStartupComplete: startupCompleteEmitter.event,
    setName(name: string) {
      nameEmitter.fire(name);
    },
    dispose() {
      stopPlaceholderAnimation();
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      try {
        proc?.kill();
      } catch {
        // ignore
      }
      startupCompleteEmitter.dispose();
      nameEmitter.dispose();
    },
  };
}
