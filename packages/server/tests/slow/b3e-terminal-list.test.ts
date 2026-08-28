// B3e lane A — A5-05: `nvk terminal list` answers `Page<TerminalSessionView>`.
//
// The hermetic no-token harness proves which `command` a call emits and can
// say nothing about the VALUE — every call there fails `RuntimeUnavailable`
// before a value exists — and the value type is the whole of A5-05. So this
// suite drives a real Runtime with real (fake-PTY) sessions, exactly as an
// operator drives it.
//
// It also holds the CL-P line on `--state`: §17.1 never ratified that flag, so
// it stays as the out-of-B3e extra it already was — but it may not carry a
// vocabulary of its own. It maps onto the status lists Terminal publishes, so
// the CLI and the capability cannot draw two different sets of "still going".
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { B3Result } from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { UNFINISHED_TERMINAL_SESSION_STATUSES } from '../../../terminal/contract/index.js';
import { createFakeProviderAdapters } from '../../../agents/governed/contract/index.js';
import { startRuntimeHost, type RunningRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime } from '../../core/runtime-host/client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

interface Envelope {
  readonly command?: string;
  readonly value?: Record<string, unknown>;
  readonly error?: { readonly code?: string; readonly issues?: readonly { path: string }[] };
}

const envelopeOf = (run: CliRun): Envelope =>
  JSON.parse(run.out.split('\n').find((line) => line.startsWith('{'))!) as Envelope;

interface LiveTerminals { readonly where: readonly string[]; readonly sessionIds: readonly string[] }

/** A live Runtime with three plain-shell sessions opened through the CLI. */
async function withSessions(
  count: number, work: (live: LiveTerminals) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-termlist-'));
  let host: RunningRuntimeHost | null = null;
  try {
    host = await startRuntimeHost({
      root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    });
    const where = ['--root', root, '--port', String(host.port), '--json'];
    const sessionIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const opened = await runNvk(['terminal', 'open', '--cwd', root,
        '--shell-instance', `shell_${index}`, ...where]);
      assert.equal(opened.code, 0, `terminal open failed: ${opened.out}`);
      const id = /terminal_[0-9a-f-]{36}/u.exec(opened.out)?.[0] ?? '';
      assert.notEqual(id, '', `no TerminalSessionId in ${opened.out}`);
      sessionIds.push(id);
    }
    await work({ where, sessionIds });
  } finally {
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('A5-05: `nvk terminal list --json` value is a Page, not an array', async () => {
  await withSessions(2, async ({ where, sessionIds }) => {
    const run = await runNvk(['terminal', 'list', ...where]);
    assert.equal(run.code, 0, `terminal list exited ${String(run.code)}: ${run.out}`);
    const envelope = envelopeOf(run);
    assert.equal(envelope.command, 'terminal.list');
    const value = envelope.value ?? {};
    assert.ok(Array.isArray(value['items']), `no items[]: ${JSON.stringify(value)}`);
    assert.ok(Array.isArray(value['omissions']), `no omissions[]: ${JSON.stringify(value)}`);
    assert.equal(Array.isArray(envelope.value), false, 'the bare array is what A5-05 replaced');
    const listed = (value['items'] as { session: { id: string } }[])
      .map((item) => item.session.id);
    assert.deepEqual([...listed].sort(), [...sessionIds].sort());
  });
});

test('A5-01: `--limit` and `--cursor` page `terminal list` end to end', async () => {
  await withSessions(3, async ({ where, sessionIds }) => {
    const first = await runNvk(['terminal', 'list', '--limit', '2', ...where]);
    assert.equal(first.code, 0, first.out);
    const firstPage = envelopeOf(first).value ?? {};
    assert.equal((firstPage['items'] as unknown[]).length, 2);
    const cursor = firstPage['nextCursor'];
    assert.equal(typeof cursor, 'string', `a cut page must mint a cursor: ${JSON.stringify(firstPage)}`);

    const second = await runNvk([
      'terminal', 'list', '--limit', '2', '--cursor', String(cursor), ...where,
    ]);
    assert.equal(second.code, 0, second.out);
    const secondPage = envelopeOf(second).value ?? {};
    assert.equal((secondPage['items'] as unknown[]).length, 1);
    assert.equal(secondPage['nextCursor'], undefined);

    const seen = [...firstPage['items'] as { session: { id: string } }[],
      ...secondPage['items'] as { session: { id: string } }[]].map((item) => item.session.id);
    assert.deepEqual([...seen].sort(), [...sessionIds].sort());
  });
});

test('A5-01: a malformed `--limit` is refused before the runtime is touched', async () => {
  // No host, and a data root with no runtime token: every call that reaches
  // dispatch fails `RuntimeUnavailable` before a socket opens. So a
  // `ValidationFailed` here can only have come from `pageFlags`, which is the
  // claim — the CLI's own encoding check, made before it asks for anything.
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-nolimit-'));
  try {
    const run = await runNvk(['terminal', 'list', '--limit', 'abc', '--root', root, '--json']);
    assert.equal(run.code, 2, `expected exit 2, got ${String(run.code)}: ${run.out}`);
    const envelope = envelopeOf(run);
    assert.equal(envelope.command, 'terminal.list');
    assert.equal(envelope.error?.code, 'ValidationFailed');

    // The control: the same invocation with a lawful limit gets as far as
    // needing a runtime, which is exactly how far the refusal above stopped it.
    const reached = await runNvk(['terminal', 'list', '--limit', '5', '--root', root, '--json']);
    assert.equal(envelopeOf(reached).error?.code, 'RuntimeUnavailable', reached.out);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CL-P: `--state` spends the status lists Terminal publishes, not its own', async () => {
  await withSessions(2, async ({ where, sessionIds }) => {
    // Every session the fake host opens is `live`, so "not finished" is all of
    // them and "finished" is none — the two answers a CLI-invented vocabulary
    // would be free to get wrong in either direction.
    const live = await runNvk(['terminal', 'list', '--state', 'live', ...where]);
    assert.equal(live.code, 0, live.out);
    const listed = ((envelopeOf(live).value ?? {})['items'] as { session: { id: string } }[])
      .map((item) => item.session.id);
    assert.deepEqual([...listed].sort(), [...sessionIds].sort());

    const final = await runNvk(['terminal', 'list', '--state', 'final', ...where]);
    assert.equal(final.code, 0, final.out);
    assert.deepEqual((envelopeOf(final).value ?? {})['items'], []);
  });
});

/**
 * T-07's residual, made construction rather than folklore. The Shell shares no
 * code with the CLI by design, so it is the one caller that can drift silently:
 * it speaks `b3.terminal.list` directly and its own tests mock the wire, so a
 * filter the wire stopped accepting would break only in a real browser.
 *
 * A5-05 already did that once — `{ state: 'live' }` is now a `ValidationFailed`
 * — and nothing in the suite noticed. This is what notices.
 */
test('CL-P: the Shell sends A5-05\'s filter, and the wire accepts exactly it', async () => {
  const clientSource = readFileSync(
    path.join(repoRoot, 'packages', 'shell', 'app', 'terminalClient.ts'), 'utf8',
  );
  const listCall = /'b3\.terminal\.list',\s*(\{[^}]*\})/u.exec(clientSource)?.[1] ?? '';
  assert.notEqual(listCall, '', 'the Shell no longer calls b3.terminal.list — retarget this guard');
  assert.match(listCall, /limit/u, `A5-05 requires a limit; the Shell sends ${listCall}`);
  assert.doesNotMatch(listCall, /\bstate\s*:/u, `\`state\` is not A5-05's filter: ${listCall}`);

  // And the filter it sends is one the live wire actually answers.
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-shellfilter-'));
  const host = await startRuntimeHost({ root, port: 0, ptyHost: createFakePtyHost() });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const page = await client.call('b3.terminal.list', {
      status: UNFINISHED_TERMINAL_SESSION_STATUSES, limit: 200,
    }) as B3Result<{ items: unknown[]; omissions: unknown[] }>;
    assert.equal(page.ok, true, `the Shell's filter was refused: ${JSON.stringify(page)}`);
    assert.ok(page.ok && Array.isArray(page.value.items));
  } finally {
    client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A5-05: the wire refuses a filter with no limit', async () => {
  // `limit` is required by the ratified filter, not defaulted by the owner: a
  // listing that picks a page size decides for its caller how much of the
  // truth it wanted. The CLI supplies 200 (A5-01); a raw caller must state one.
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-termlimit-'));
  const host = await startRuntimeHost({ root, port: 0, ptyHost: createFakePtyHost() });
  const client = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const refused = await client.call('b3.terminal.list', {}) as
      B3Result<unknown> & { error?: { code: string; details: { issues?: { path: string }[] } } };
    assert.equal(refused.ok, false, 'a filter with no limit must be refused');
    assert.equal(refused.error?.code, 'ValidationFailed');
    assert.ok(
      refused.error?.details.issues?.some((issue) => issue.path === 'limit'),
      `expected a limit issue: ${JSON.stringify(refused.error)}`,
    );
  } finally {
    client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
