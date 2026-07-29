import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore } from '../contract/index.js';
import { bootServer } from '../core/boot.js';
import { fakeKimi } from './fakeKimi.js';

const workspace = () =>
  mkdtempSync(path.join(tmpdir(), 'nvk-b2b-topology-'));
const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
const terminalLifecycleFixture = fileURLToPath(new URL(
  './fixtures/transcript-terminal-lifecycle.mts',
  import.meta.url,
));
const activeIngestCrashFixture = fileURLToPath(new URL(
  './fixtures/transcript-active-ingest-crash.mts',
  import.meta.url,
));

async function configureServer(
  root: string,
  ingest: boolean,
): Promise<void> {
  const opened = await openConfigStore({
    root,
    principal: 'sys_spine',
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const token = opened.value.mintPrincipalToken({
    personId: 'person_chris',
    roles: ['Human'],
    grants: ['layout', 'settings', 'conversationView'],
  });
  await opened.value.set({
    configKind: 'principal',
    personId: 'person_chris',
    roles: ['Human'],
    tokenId: token.id,
  }, mintClientOpId());
  await opened.value.set({
    configKind: 'transcript',
    ingest,
  }, mintClientOpId());
}

async function eventually(
  predicate: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

test('terminal watcher failure is truthful and sticky, and concurrent topology stops resolve within 500ms', () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, terminalLifecycleFixture],
    {
      encoding: 'utf8',
      timeout: 2_000,
    },
  );
  assert.equal(
    result.status,
    0,
    result.error
      ? `${result.error.message}\n${result.stderr}`
      : result.stderr,
  );
  const proof = JSON.parse(result.stdout) as {
    stopMs: number;
    status: {
      running: boolean;
      watcherReady: boolean;
      ingesting: boolean;
      lastError?: string;
    };
  };
  assert.ok(proof.stopMs < 500);
  assert.equal(proof.status.running, false);
  assert.equal(proof.status.watcherReady, false);
  assert.equal(proof.status.ingesting, false);
  assert.match(
    proof.status.lastError ?? '',
    /EEXIST|ENOTDIR|checkpoint|state/u,
  );
});

test('worker death during active ingest immediately clears the terminal ingesting status', () => {
  const result = spawnSync(
    process.execPath,
    [tsxCli, activeIngestCrashFixture],
    {
      encoding: 'utf8',
      timeout: 3_000,
    },
  );
  assert.equal(
    result.status,
    0,
    result.error
      ? `${result.error.message}\n${result.stderr}`
      : result.stderr,
  );
  const status = JSON.parse(result.stdout) as {
    running: boolean;
    watcherReady: boolean;
    ingesting: boolean;
    lastError?: string;
  };
  assert.equal(status.running, false);
  assert.equal(status.watcherReady, false);
  assert.equal(status.ingesting, false);
  assert.match(status.lastError ?? '', /EEXIST|checkpoint|state/u);
});

test('transcript.ingest=true starts copy custody and authoritative ingestion', async (t) => {
  const base = workspace();
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'provider-home');
  const sourceDir = path.join(providerHome, '.kimi-code', 'events');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, 'session.jsonl'), `${JSON.stringify({
    kind: 'event',
    envelope: {
      seq: 1,
      session_id: 'native-session',
      timestamp: '2026-07-29T01:02:03.000Z',
      type: 'assistant_output',
      payload: {
        agentId: 'agent_topology',
        turnId: 'turn_topology',
        output: 'synthetic topology line',
      },
    },
  })}\n`);
  await configureServer(root, true);

  const booted = await bootServer({
    root,
    port: 0,
    cwd: base,
    providerHome,
    watchdogDir: base,
    kimiCliPath: fakeKimi().cliPath,
    supervisionTimers: false,
  });
  assert.equal(booted.ok, true);
  if (!booted.ok) return;
  t.after(() => booted.value.close());

  await eventually(async () => {
    const lines = await booted.value.runtime.transcript.operations
      .linesByProvider('kimi');
    return lines.ok && lines.value.length === 1;
  });
  const lines = await booted.value.runtime.transcript.operations
    .linesByProvider('kimi');
  assert.deepEqual(
    lines.ok ? lines.value.map(({ text }) => text) : null,
    ['synthetic topology line'],
  );
  assert.equal(
    booted.value.runtime.transcript.topology.status().watcherReady,
    true,
  );
});

test('transcript.ingest=false starts neither watcher nor ingester even when the legacy dev flag is true', async (t) => {
  const base = workspace();
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'provider-home');
  const sourceDir = path.join(providerHome, '.kimi-code', 'events');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(path.join(sourceDir, 'disabled.jsonl'), `${JSON.stringify({
    kind: 'event',
    envelope: {
      seq: 1,
      timestamp: '2026-07-29T01:02:03.000Z',
      type: 'assistant_output',
      payload: {
        turnId: 'turn_disabled',
        output: 'must remain outside custody',
      },
    },
  })}\n`);
  await configureServer(root, false);
  const opened = await openConfigStore({
    root,
    principal: 'sys_spine',
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  await opened.value.set({
    configKind: 'dev',
    allowMock: false,
    watchTranscripts: true,
  }, mintClientOpId());

  const booted = await bootServer({
    root,
    port: 0,
    cwd: base,
    providerHome,
    watchdogDir: base,
    kimiCliPath: fakeKimi().cliPath,
    supervisionTimers: false,
  });
  assert.equal(booted.ok, true);
  if (!booted.ok) return;
  t.after(() => booted.value.close());

  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(
    booted.value.runtime.transcript.topology.status(),
    {
      running: false,
      watcherReady: false,
      ingesting: false,
      runs: 0,
    },
  );
  assert.equal(
    existsSync(path.join(
      root,
      'transcripts',
      'kimi',
      'events',
      'disabled.jsonl',
    )),
    false,
    'copy custody never started',
  );
  const lines = await booted.value.runtime.transcript.operations
    .linesByProvider('kimi');
  assert.deepEqual(lines.ok ? lines.value : null, []);
});

test('HTTP responds within 500ms while a chunked transcript first scan is still ingesting', async (t) => {
  const base = workspace();
  const root = path.join(base, '.novakai');
  const providerHome = path.join(base, 'empty-provider-home');
  const custody = path.join(root, 'transcripts', 'kimi');
  mkdirSync(custody, { recursive: true });
  mkdirSync(providerHome, { recursive: true });
  const lineCount = 160;
  const rows = Array.from({ length: lineCount }, (_, index) =>
    JSON.stringify({
      kind: 'event',
      envelope: {
        seq: index,
        timestamp: '2026-07-29T01:02:03.000Z',
        type: 'assistant_output',
        payload: {
          agentId: 'agent_responsiveness',
          turnId: `turn_responsiveness_${index}`,
          output: `synthetic responsiveness line ${index}`,
        },
      },
    }))
    .join('\n');
  writeFileSync(path.join(custody, 'big-first-scan.jsonl'), `${rows}\n`);
  await configureServer(root, true);

  const booted = await bootServer({
    root,
    port: 0,
    cwd: base,
    providerHome,
    watchdogDir: base,
    kimiCliPath: fakeKimi().cliPath,
    supervisionTimers: false,
  });
  assert.equal(booted.ok, true);
  if (!booted.ok) return;
  t.after(() => booted.value.close());

  await eventually(async () =>
    booted.value.runtime.transcript.topology.status().ingesting);
  const startedAt = performance.now();
  const response = await fetch(`${booted.value.url}/bootstrap.json`);
  const elapsedMs = performance.now() - startedAt;
  assert.equal(response.status, 200);
  assert.ok(
    elapsedMs < 500,
    `HTTP response took ${elapsedMs.toFixed(1)}ms; budget is 500ms`,
  );
  t.diagnostic(
    `bootstrap HTTP ${elapsedMs.toFixed(1)}ms during active ingestion `
    + '(budget 500ms)',
  );
  assert.equal(
    booted.value.runtime.transcript.topology.status().ingesting,
    true,
    'synchronization proves the request completed before ingestion did',
  );

  await eventually(async () => {
    const status = booted.value.runtime.transcript.topology.status();
    return status.runs >= 1 && !status.ingesting;
  }, 10_000);
  const lines = await booted.value.runtime.transcript.operations
    .linesByProvider('kimi');
  assert.equal(lines.ok ? lines.value.length : null, lineCount);
});
