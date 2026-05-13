import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

/**
 * Shape Claude is instructed (via the system prompt) to write to its
 * per-agent status JSON file. All fields are optional so partial writes are
 * permitted; absent fields mean "leave the current value alone", explicit
 * `null` means "clear it".
 */
export interface AgentState {
  title?: string | null;
  tldr?: string | null;
  progress?: { value: number; label: string } | null;
  needsInput?: string | null;
  error?: string | null;
  skill?: string | null;
}

export interface StateWatcher {
  dispose(): void;
}

/**
 * Watches a single per-agent JSON state file. The file may not exist at
 * watch start — chokidar polls the file path with `usePolling: true` so the
 * `add` event fires as soon as Claude's first Write tool call lands.
 *
 * The directory is created if missing so chokidar can attach a polling
 * watcher to it.
 */
export function watchState(
  filePath: string,
  onState: (s: AgentState) => void,
): StateWatcher {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const watcher: FSWatcher = chokidar.watch(filePath, {
    persistent: true,
    usePolling: true,
    interval: 250,
    ignoreInitial: false,
  });

  const read = (label: string) => {
    try {
      const raw = fs.readFileSync(filePath, 'utf8').trim();
      if (raw.length === 0) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return;
      onState(parsed as AgentState);
    } catch (err) {
      // Partial writes (Claude is mid-write) produce invalid JSON. Swallow
      // — the next polling tick will see the complete file.
      console.warn(`[glancer] stateWatcher: ${label} read failed`, err);
    }
  };

  watcher.on('add', () => read('add'));
  watcher.on('change', () => read('change'));
  watcher.on('error', (err) => console.error('[glancer] stateWatcher error', err));

  return {
    dispose() {
      watcher.close();
    },
  };
}
