// A5-08: `nvk terminal detach <controllerAttachmentId> --session <terminalSessionId>`.
//
// Unlike A5-03/A5-04/A5-07 this amendment found the product already conformant:
// `detach` has taken the attachment as a positional and the session as
// `--session` since B3c. So this file is not a fix — it is the guard the
// conformance never had, and the reason it is worth having is that the
// encoding is load-bearing and invisible:
//
//   * BOTH ids are required, and they are different kinds. §12.3's
//     `DetachControllerInput` needs the session to find the custody record and
//     the attachment to say WHICH controller is leaving; a detach that guessed
//     either would detach somebody else's window.
//   * which id is positional and which is a flag is exactly the kind of thing
//     a later refactor "tidies", and exactly what a scripted caller — or an
//     exam row — reads. `terminal write` next door takes `--session` as a flag
//     too, so a drifting `detach` would look plausible.
//
// Everything here is hermetic: a data root with no runtime token, so the CLI's
// own refusals are visible as themselves and the accepted form is visible as
// the `RuntimeUnavailable` it can only reach by dispatching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/governed/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../core/runtime-host/host.js';
import { connectRuntime, type RuntimeClient } from '../core/runtime-host/client.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

const NO_RUNTIME_ROOT = path.join(repoRoot, 'packages', 'server', 'tests', '.no-such-root');
const NO_RUNTIME_PORT = '59420';
const HERMETIC = ['--json', '--root', NO_RUNTIME_ROOT, '--port', NO_RUNTIME_PORT] as const;

interface CliRun { readonly code: number | null; readonly out: string }

function runNvkAt(args: readonly string[], where: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args, ...where], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

const runNvk = (args: readonly string[]): Promise<CliRun> => runNvkAt(args, HERMETIC);

interface Envelope {
  readonly command?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

const ATTACHMENT = 'controllerAttachment_019fd400-0000-7000-8000-000000000001';
const SESSION = 'terminal_019fd400-0000-7000-8000-000000000002';

test('detach with no --session is refused, and the usage line names both ids', async () => {
  const run = await runNvk(['terminal', 'detach', ATTACHMENT]);
  const envelope = envelopeOf(run);
  assert.equal(envelope.error?.code, 'ValidationFailed',
    `a detach with no session was dispatched: ${run.out}`);
  assert.equal(run.code, 2, `exit drifted from the ruled table: ${run.out}`);
  assert.equal(envelope.command, 'terminal.detach');
  assert.match(envelope.error?.message ?? '', /--session/,
    `the refusal did not name the flag: ${run.out}`);
});

test('detach with no attachment id is refused — the session alone names no controller', async () => {
  const run = await runNvk(['terminal', 'detach', '--session', SESSION]);
  assert.equal(envelopeOf(run).error?.code, 'ValidationFailed', run.out);
  assert.equal(run.code, 2);
});

test('the ratified pair reaches the Runtime — the CLI raises no objection of its own', async () => {
  const run = await runNvk(['terminal', 'detach', ATTACHMENT, '--session', SESSION]);
  // There is no Runtime under this root, so `RuntimeUnavailable` is the proof
  // that both ids were accepted and the call was dispatched.
  assert.equal(envelopeOf(run).error?.code, 'RuntimeUnavailable',
    `the ratified form was refused before dispatch: ${run.out}`);
  assert.equal(envelopeOf(run).command, 'terminal.detach');
});

test('the POSITIONAL becomes the attachment and --session becomes the session', async () => {
  // The assertion the hermetic rows cannot make. A real session, a real
  // controller, and a detach driven through the CLI: it can only succeed if
  // each id reached the field A5-08 names for it. Swap them — the mirror image
  // a refactor could produce without any test above noticing — and the OWNER
  // refuses, because neither id is of the kind that field expects.
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-detach-'));
  let host: RunningRuntimeHost | null = null;
  let client: RuntimeClient | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    client = await connectRuntime({ root, port: host.port, token: host.token });
    const session = await client.call<{ id: string }>('b3.terminal.open', {
      owner: { kind: 'plain-shell', shellInstanceId: 'detach-selector' },
      launchAuthorityRef: 'plain-shell',
      launchFingerprint: 'plain-shell:/bin/zsh',
      workingDirectory: tmpdir(), columns: 80, rows: 24,
    });
    assert.equal(session.ok, true,
      session.ok ? '' : `${session.error.code}: ${session.error.message}`);
    if (!session.ok) return;
    const attached = await client.call<{ id: string }>('b3.terminal.attach', {
      terminalSessionId: session.value.id,
      controllerKind: 'external-terminal', columns: 80, rows: 24,
    });
    assert.equal(attached.ok, true,
      attached.ok ? '' : `${attached.error.code}: ${attached.error.message}`);
    if (!attached.ok) return;
    const where = ['--json', '--root', root, '--port', String(host.port)];

    const swapped = await runNvkAt(
      ['terminal', 'detach', session.value.id, '--session', attached.value.id], where,
    );
    assert.notEqual(swapped.code, 0,
      `the mirror image was accepted — the two ids are interchangeable: ${swapped.out}`);

    const detached = await runNvkAt(
      ['terminal', 'detach', attached.value.id, '--session', session.value.id], where,
    );
    assert.equal(detached.code, 0, `the ratified pair was refused: ${detached.out}`);
    assert.equal(envelopeOf(detached).command, 'terminal.detach');
  } finally {
    client?.close();
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
