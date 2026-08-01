#!/usr/bin/env node
// B3a second-host proof (spec §24.4).
//
// This file is deliberately plain JavaScript with ZERO Novakai imports. It
// drives the shipped CLIs as a stranger would — which is the only way "an
// external terminal is a first-class controller" can be proven rather than
// asserted. If this passes, Novakai's UI is one client, not the owner.
//
//   node scripts/automation-examples/b3a-second-host.mjs [--port 5191] [--root <dir>]
//
// Exit 0 = every step passed. Any other code = the step that failed is printed.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsx = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runtimeCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-runtime.ts');
const terminalCli = path.join(repoRoot, 'packages', 'server', 'cli', 'nvk-terminal.ts');

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const port = flag('port', '5191');
const root = flag('root', mkdtempSync(path.join(tmpdir(), 'nvk-second-host-')));
const ownsRoot = flag('root') === undefined;

const steps = [];
let failures = 0;

function record(name, passed, detail) {
  steps.push({ name, passed, detail });
  if (!passed) failures += 1;
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}\n`);
}

/** Run a CLI and parse its --json envelope. Nothing else is imported. */
function cli(script, args) {
  const run = spawnSync(process.execPath, [tsx, script, ...args, '--json', '--root', root, '--port', port], {
    cwd: repoRoot, encoding: 'utf8',
  });
  const line = (run.stdout || '').trim().split('\n').filter(Boolean).pop();
  let parsed = null;
  try { parsed = line ? JSON.parse(line) : null; } catch { parsed = null; }
  return { code: run.status, json: parsed, stderr: run.stderr };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // 1. Reach the runtime — starting it if nothing is there, with no UI open.
  const serve = spawn(process.execPath, [tsx, runtimeCli, 'serve', '--root', root, '--port', port], {
    cwd: repoRoot, detached: true, stdio: 'ignore',
  });
  serve.unref();

  let status = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const probe = cli(runtimeCli, ['status']);
    if (probe.json?.ok) { status = probe.json.value; break; }
    await sleep(100);
  }
  record('ensure the background runtime, with no desktop app open',
    status !== null && status.state === 'active',
    status ? `epoch ${status.activeEpochId}` : 'the runtime never became reachable');
  if (status === null) return finish(serve);

  // 2. Open a real terminal from outside the app.
  const opened = cli(terminalCli, ['open', '--cwd', root, '--authority', 'plain-shell']);
  const session = opened.json?.ok ? opened.json.value : null;
  record('open a real terminal from an external process',
    session !== null, session ? session.id : opened.stderr.trim());
  if (!session) return finish(serve);

  // 3. Attach as an external controller.
  const attached = cli(terminalCli, ['attach', session.id]);
  const attachment = attached.json?.ok ? attached.json.value : null;
  record('attach to it as an external controller',
    attachment !== null, attachment ? attachment.id : attached.stderr.trim());
  if (!attachment) return finish(serve);

  // 4. Send input and read the ordered stream back.
  const written = cli(terminalCli, [
    'write', '--session', session.id, '--attachment', attachment.id,
    '--text', 'echo second-host-proof\r',
  ]);
  record('send input under the input lease', written.json?.ok === true,
    written.json?.ok ? `input #${written.json.value.inputSequence}` : written.stderr.trim());

  let sawEcho = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await sleep(100);
    const read = cli(terminalCli, ['read', session.id, '--after', '0']);
    if (!read.json?.ok) continue;
    const text = read.json.value
      .filter((frame) => frame.kind === 'bytes')
      .map((frame) => Buffer.from(frame.base64, 'base64').toString('utf8'))
      .join('');
    if (text.includes('second-host-proof')) { sawEcho = true; break; }
  }
  record('receive ordered terminal output back', sawEcho,
    sawEcho ? '' : 'the shell never echoed the typed line');

  // 5. List and inspect through the machine-readable surface.
  const listed = cli(terminalCli, ['list', '--state', 'live']);
  const found = listed.json?.ok
    && listed.json.value.some((view) => view.session.id === session.id);
  record('list and inspect live terminals', found === true,
    listed.json?.ok ? `${listed.json.value.length} live session(s)` : listed.stderr.trim());

  // 6. THE point of the slice: detaching must not terminate anything.
  const detached = cli(terminalCli, ['detach', attachment.id, '--session', session.id]);
  const afterDetach = cli(terminalCli, ['inspect', session.id]);
  const stillLive = afterDetach.json?.ok && afterDetach.json.value.session.status === 'live';
  record('detach WITHOUT terminating the terminal',
    detached.json?.ok === true && stillLive === true,
    afterDetach.json?.ok ? `status after detach: ${afterDetach.json.value.session.status}` : '');

  // 7. Refusing to stop while something is live is not a failure — it is the
  //    no-surprises rule doing its job.
  const refused = cli(runtimeCli, ['stop', '--live-runs', 'refuse']);
  record('a runtime stop REFUSES while a terminal is still live',
    refused.json?.ok === true && refused.json.value.stopped === false,
    refused.json?.ok ? `${refused.json.value.refusedTerminalSessionIds.length} refused` : refused.stderr.trim());

  // 8. Stopping is a separate, explicit decision.
  const stopped = cli(runtimeCli, ['stop', '--live-runs', 'stop-explicitly']);
  record('an explicit stop stops the runtime and its terminals',
    stopped.json?.ok === true && stopped.json.value.stopped === true,
    stopped.json?.ok ? `stopped ${stopped.json.value.stoppedTerminalSessionIds.length} terminal(s)` : stopped.stderr.trim());

  return finish(serve);
}

function finish(serve) {
  try { process.kill(-serve.pid, 'SIGTERM'); } catch { /* already gone */ }
  try { serve.kill('SIGTERM'); } catch { /* already gone */ }
  if (ownsRoot) rmSync(root, { recursive: true, force: true });
  process.stdout.write(`\n${steps.length - failures}/${steps.length} steps passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
