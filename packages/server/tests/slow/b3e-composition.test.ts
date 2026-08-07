// A4 / T-02: ONE composition serves both the Shell's boot methods and `b3.*`.
//
// The Shell is served BY the Novakai server and takes its connection facts from
// the same origin (`GET /bootstrap.json` → wsUrl + token). Every screen it then
// draws of an Agent Run goes through FZ-VIEW-001's one door, which is
// `b3.agent.*` on that same socket. Until this slice the product had two
// composition roots and neither served both halves:
//
//   * `bootServer` (the `nvk-server` production root) wired NO B3 runtime, so
//     `b3.agent.listRuns` came back `unknown method` — the Runs screen, the
//     watchers screen and the usage table all fail on the real server;
//   * `startRuntimeHost` serves `b3.*` and none of the Shell's boot methods.
//
// So a backed Shell was unreachable by construction (T-02/T-03, entry list
// A-10, and Lane B's L-04 blocked behind it). These tests state the law the
// other way round: whatever server served the page answers BOTH vocabularies on
// ONE socket, and the Run rows it hands back are the real Runtime's.
//
// The Shell's own call sites are driven rather than re-spelled — `listFilterForState`
// is imported from the app and put on a live wire, for the reason A5-05 taught
// the hard way: a payload the Shell alone knows how to build is a payload no
// mocked test can prove.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { mintClientOpId } from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { listFilterForState } from '../../../shell/app/agentRuns.js';
import { bootServer, type NovakaiServer } from '../../core/boot.js';
import { openConfigStore } from '../../core/config/store.js';
import { chatRole } from '../governed-role.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

/** The §13 disposition 4 cold-start runbook — `bootServer` refuses without it. */
async function mintChris(dir: string): Promise<void> {
  const opened = await openConfigStore({ root: dir, principal: 'sys_spine' });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const token = opened.value.mintPrincipalToken({
    personId: 'person_chris', roles: ['Human'], grants: ['layout', 'settings', 'conversationView'],
  });
  await opened.value.set(
    { configKind: 'principal', personId: 'person_chris', roles: ['Human'], tokenId: token.id },
    mintClientOpId(),
  );
}

interface Booted {
  readonly server: NovakaiServer;
  readonly root: string;
  readonly staticDir: string;
}

/**
 * The production root, on a throwaway data root, with the two seams every B3
 * suite uses so no real PTY or provider CLI is touched.
 */
async function boot(options: { readonly serveBundle?: boolean } = {}): Promise<Booted> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-composition-'));
  const staticDir = path.join(root, 'bundle');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
  await mintChris(root);
  const booted = await bootServer({
    root,
    port: 0,
    cwd: root,
    watchdogDir: root,
    ...(options.serveBundle === false ? {} : { staticDir }),
    b3: { ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters() },
  });
  if (!booted.ok) throw new Error(`boot failed: ${booted.error.code} ${booted.error.message}`);
  return { server: booted.value, root, staticDir };
}

async function shutdown(booted: Booted): Promise<void> {
  await booted.server.close();
  rmSync(booted.root, { recursive: true, force: true });
}

interface Frame { readonly ok?: boolean; readonly value?: unknown; readonly error?: unknown }

/** One socket, opened the way the page opens it: bootstrap document, then WS. */
async function openShellSocket(server: NovakaiServer): Promise<{
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
}> {
  const bootstrap = await (await fetch(`${server.url}/bootstrap.json`)).json() as
    { wsUrl: string; token: string; protocolVersion: number };
  const ws = new WebSocket(`${bootstrap.wsUrl}?token=${encodeURIComponent(bootstrap.token)}`);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  let seq = 0;
  const call = (method: string, params: unknown = {}): Promise<unknown> => {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const handler = (raw: unknown): void => {
        const frame = JSON.parse(String(raw)) as
          { id?: number; type?: string; result?: unknown; error?: unknown };
        if (frame.type === 'event' || frame.id !== id) return;
        ws.off('message', handler);
        if (frame.error !== undefined) { reject(new Error(String(frame.error))); return; }
        resolve(frame.result);
      };
      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params, v: 1 }));
    });
  };
  return { call, close: () => ws.close() };
}

interface CliRun { readonly code: number | null; readonly out: string }

function runNvk(args: readonly string[]): Promise<CliRun> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => { child.on('close', (code) => { resolve({ code, out }); }); });
}

test('the server that serves the Shell answers b3.agent.listRuns on the same socket', async () => {
  const booted = await boot();
  const socket = await openShellSocket(booted.server);
  try {
    // A Shell boot method — the vocabulary `bootServer` has always had.
    const layout = await socket.call('getLayout');
    assert.notEqual(layout, undefined, 'the Shell boot method answered nothing');

    // FZ-VIEW-001's door, on the SAME socket, with the payload the Shell's own
    // call site builds.
    const runs = await socket.call('b3.agent.listRuns', {
      contractVersion: 1, payload: listFilterForState({ state: 'all' }),
    }) as Frame;
    assert.equal(runs.ok, true, `the Runs door was refused: ${JSON.stringify(runs.error)}`);
    const page = runs.value as { items?: unknown; omissions?: unknown };
    assert.ok(Array.isArray(page.items), `not a Page of Runs: ${JSON.stringify(runs.value)}`);
    assert.ok(Array.isArray(page.omissions), 'a Page states what it omitted (FZ-VIEW-010)');
  } finally {
    socket.close();
    await shutdown(booted);
  }
});

test('the watchers screen reaches Supervision through the server that served the page', async () => {
  const booted = await boot();
  const socket = await openShellSocket(booted.server);
  try {
    // Exactly what `ShellServices.listWatchers` sends (serverClient.ts).
    const watchers = await socket.call('b3.supervision.listWatchers', {
      contractVersion: 1, payload: { limit: 500 },
    }) as Frame;
    assert.equal(watchers.ok, true,
      `the watchers door was refused: ${JSON.stringify(watchers.error)}`);
    const listing = watchers.value as { rules?: unknown; deadlines?: unknown };
    assert.ok(Array.isArray(listing.rules), `not a watcher listing: ${JSON.stringify(watchers.value)}`);
    assert.ok(Array.isArray(listing.deadlines), 'the listing carries its deadlines');
  } finally {
    socket.close();
    await shutdown(booted);
  }
});

test('a Run spawned against this server is a real row on the Shell socket', async () => {
  const booted = await boot();
  const where = ['--root', booted.root, '--port', String(booted.server.port), '--json'];
  const roleFile = path.join(booted.root, 'role.json');
  writeFileSync(roleFile, JSON.stringify(chatRole('composition-builder')), 'utf8');
  const socket = await openShellSocket(booted.server);
  try {
    const defined = await runNvk(['agent', 'define-role', '--file', roleFile, ...where]);
    assert.equal(defined.code, 0, `define-role failed: ${defined.out}`);
    const spawned = await runNvk(['agent', 'spawn', '--role', 'composition-builder',
      '--name', 'Composer', '--cwd', booted.root, ...where]);
    assert.equal(spawned.code, 0, `spawn failed: ${spawned.out}`);
    const runId = /agentRun_[0-9a-f-]{36}/u.exec(spawned.out)?.[0] ?? '';
    assert.notEqual(runId, '', `no AgentRunId in ${spawned.out}`);

    const runs = await socket.call('b3.agent.listRuns', {
      contractVersion: 1, payload: listFilterForState({ state: 'all' }),
    }) as Frame;
    assert.equal(runs.ok, true, `the Runs door was refused: ${JSON.stringify(runs.error)}`);
    const items = (runs.value as { items: Array<{ run: { id: string }; agent: { displayName: string };
      controllers?: unknown }> }).items;
    const row = items.find((item) => item.run.id === runId);
    assert.notEqual(row, undefined,
      `the Run the operator just spawned is not on the Shell's page: ${JSON.stringify(items)}`);
    assert.equal(row!.agent.displayName, 'Composer');
    // A7-03 item 5: the row the screen draws carries current attachment truth.
    assert.notEqual(row!.controllers, undefined, 'the row lost its controllers section');
  } finally {
    socket.close();
    await shutdown(booted);
  }
});

test('/bootstrap.json is the bootstrap document, not the bundle it serves', async () => {
  const booted = await boot();
  try {
    // A-10 said the static handler swallows the bootstrap path, so the page
    // JSON-parses HTML and never mounts. Asserted first-hand rather than
    // inherited: the document is served as JSON WHILE a bundle is mounted…
    const bootstrap = await fetch(`${booted.server.url}/bootstrap.json`);
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.headers.get('content-type') ?? '', /application\/json/u);
    const doc = await bootstrap.json() as { wsUrl?: string; protocolVersion?: number };
    assert.equal(doc.protocolVersion, 1);
    assert.ok(String(doc.wsUrl).startsWith('ws://127.0.0.1:'), 'the socket is loopback-only');

    // …and the SPA fallback still answers every other path with the page.
    const deep = await fetch(`${booted.server.url}/agents/some-run`);
    assert.equal(deep.status, 200);
    assert.match(await deep.text(), /id="root"/u);
  } finally {
    await shutdown(booted);
  }
});
