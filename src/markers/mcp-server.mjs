#!/usr/bin/env node
// Glancer MCP server. Launched as a stdio child by Claude Code (via the
// `mcpServers` block in the settings JSON passed with `--settings`). Exposes
// one tool — `glancer_update_state` — that writes a per-agent JSON file the
// extension host watches with chokidar.
//
// Lifecycle: one process per Claude session. Stdin/stdout speaks JSON-RPC
// (newline-delimited messages). Inherits GLANCER_AGENT_ID and
// GLANCER_STATE_FILE from the parent Claude process, which we set on the PTY
// env in Agent.ts.
//
// Failure mode is silent — never throw on stdin and never block Claude's
// turn. Diagnostics go to a sidecar log file alongside hook.log.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Load the Glancer system instructions once at server start. Path comes from
// the env var set by mcp-config.json. These are returned in the MCP
// `initialize` response's `instructions` field — the official mechanism for
// servers to inject prompt-like guidance into the model's context. No need
// to pass anything via `--append-system-prompt`; Claude Code propagates the
// server's instructions to the model automatically.
function loadInstructions() {
  const p = process.env.GLANCER_INSTRUCTIONS_FILE;
  if (!p) return '';
  try {
    return readFileSync(p, 'utf8');
  } catch (err) {
    return '';
  }
}
const INSTRUCTIONS = loadInstructions();

const PROTOCOL_VERSION = '2024-11-05';
// Short, action-shaped name. Claude Code renders this as
// `glancer - update_state(…)` in tool-call traces, which reads naturally
// as "update state on glancer".
const TOOL_NAME = 'update_state';
const STATE_KEYS = ['title', 'tldr', 'progress', 'needsInput', 'error', 'skill'];

function log(line) {
  try {
    const dir = process.env.GLANCER_EVENTS_DIR;
    if (!dir) return;
    mkdirSync(dirname(dir), { recursive: true });
    appendFileSync(
      join(dirname(dir), 'mcp.log'),
      `${new Date().toISOString()} [${process.env.GLANCER_AGENT_ID ?? '?'}] ${line}\n`,
    );
  } catch {
    /* never throw */
  }
}

const TOOLS = [
  {
    name: TOOL_NAME,
    description:
      "Update the Glance agent card — the small UI panel showing this " +
      "session's title, TL;DR, progress bar, needs-input/error flags, and " +
      'active-skill pill. You MUST call this as the LAST action of EVERY ' +
      'response (short, long, trivial, or mid-tool-chain), with ALL SIX ' +
      'fields populated. Use real values for fields that apply this turn ' +
      'and explicit `null` for fields that do not (e.g. {progress: null} ' +
      "on a trivial greeting, {error: null} when nothing's broken, " +
      "{needsInput: null} when you're not waiting on the user, {skill: " +
      'null} when no Skill is loaded). Never omit a field — omitted ' +
      'fields preserve their prior value, which silently desyncs the card ' +
      "from what's actually happening this turn.",
    inputSchema: {
      type: 'object',
      required: ['title', 'tldr', 'progress', 'needsInput', 'error', 'skill'],
      properties: {
        title: {
          type: 'string',
          description:
            "2-4 word descriptive title derived from the user's first " +
            "prompt, mirroring the user's writing style. Match THEIR " +
            'casing: lowercase prompt → lowercase title; sentence case ' +
            'prompt → sentence case title; Title Case → Title Case. ' +
            'Always preserve proper nouns / acronyms in canonical ' +
            'capitalization (React, OAuth, S3, IPC). Drop emphasis ' +
            'markers (ALL CAPS, "PLEASE", exclamation points). On the ' +
            'first turn, set this via your VERY FIRST call to ' +
            'update_state (before any other tool use), then keep it ' +
            'IDENTICAL on every subsequent call — the title reflects the ' +
            'session, not the current message.',
        },
        tldr: {
          type: 'string',
          description:
            'One short speakable sentence (≤15 spoken seconds) summarizing ' +
            'the latest outcome. Plain prose for the ear; no code, no ' +
            'markdown, no quotes. Write as a direct status line, NOT ' +
            'third-person narration: "Running on Opus 4.7" rather than ' +
            '"Told the user I am running Opus 4.7"; "Refactored the auth ' +
            'flow" rather than "Helped the user refactor the auth flow". ' +
            'The reader IS the user — there is no third party to refer ' +
            'to. Update on every call.',
        },
        progress: {
          oneOf: [
            {
              type: 'object',
              required: ['value', 'label'],
              properties: {
                value: { type: 'number', minimum: 0, maximum: 1 },
                label: { type: 'string' },
              },
            },
            { type: 'null' },
          ],
          description:
            'Set during multi-step or non-trivial work (investigation, ' +
            'refactors, debugging). On the first message of a turn use a ' +
            'low starting value like 0.1; update on each meaningful ' +
            'transition (0.1 → 0.3 → 0.6 → 1). End the turn with ' +
            '{"value": 1, "label": "<terminal label>"}. Pass null on ' +
            'trivial turns (pure greetings, one-line answers).',
        },
        needsInput: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description:
            'Short clause when your response ends awaiting a user reply ' +
            '(a yes/no, value, path, confirmation, pick between options). ' +
            'null otherwise.',
        },
        error: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description:
            'Short clause when a hard failure blocks progress and the user ' +
            'must intervene. null for normal turns.',
        },
        skill: {
          oneOf: [{ type: 'string' }, { type: 'null' }],
          description:
            'Slug of the Skill currently driving this turn, when one is ' +
            'active — e.g. "test-driven-development", "claude-api", ' +
            '"debugging". Set the moment you invoke a Skill, keep it set ' +
            'while operating under that Skill\'s guidance, and pass null ' +
            'once you move on to plain work. Display only — Glance renders ' +
            'it as a small pill on the card so the user can see what kind ' +
            'of work the session is currently doing. Use the bare skill ' +
            'slug (no `superpowers:` prefix).',
        },
      },
    },
  },
];

function send(msg) {
  try {
    process.stdout.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    log(`stdout write failed: ${e?.message ?? e}`);
  }
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleInitialize(req) {
  ok(req.id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: 'glancer', version: '0.0.1' },
    instructions: INSTRUCTIONS,
  });
}

function handleListTools(req) {
  ok(req.id, { tools: TOOLS });
}

function handleCallTool(req) {
  const params = req.params ?? {};
  if (params.name !== TOOL_NAME) {
    rpcError(req.id, -32601, `unknown tool: ${params.name}`);
    return;
  }
  const args = params.arguments ?? {};
  const filePath = process.env.GLANCER_STATE_FILE;
  if (!filePath) {
    rpcError(req.id, -32603, 'GLANCER_STATE_FILE env var not set');
    return;
  }
  // Merge with prior contents so partial updates preserve unmodified fields.
  let prev = {};
  try {
    const raw = readFileSync(filePath, 'utf8').trim();
    if (raw.length > 0) prev = JSON.parse(raw);
  } catch {
    /* file may not exist on first call — that's expected */
  }
  const merged = { ...prev };
  for (const key of STATE_KEYS) {
    if (key in args) merged[key] = args[key];
  }
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(merged, null, 2));
    log(
      `tools/call ${TOOL_NAME} wrote ${filePath} fields=${Object.keys(args).join(',') || '<none>'}`,
    );
  } catch (e) {
    rpcError(req.id, -32603, `state write failed: ${e?.message ?? e}`);
    return;
  }
  ok(req.id, {
    content: [{ type: 'text', text: 'Agent card updated.' }],
  });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      log(`json parse error on line: ${e?.message ?? e}`);
      continue;
    }
    log(`recv method=${req.method ?? '?'} id=${req.id ?? '-'}`);
    if (req.method === 'initialize') handleInitialize(req);
    else if (req.method === 'tools/list') handleListTools(req);
    else if (req.method === 'tools/call') handleCallTool(req);
    else if (req.method === 'notifications/initialized') {
      // No response on notifications.
    } else if (req.method?.startsWith('notifications/')) {
      // Other notifications — ignore.
    } else if (req.id !== undefined) {
      rpcError(req.id, -32601, `method not found: ${req.method}`);
    }
  }
});

process.stdin.on('end', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

log(
  `mcp-server.mjs starting agentId=${process.env.GLANCER_AGENT_ID ?? '<unset>'} stateFile=${process.env.GLANCER_STATE_FILE ?? '<unset>'} instructionsLen=${INSTRUCTIONS.length} pid=${process.pid}`,
);
