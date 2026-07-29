import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mintClientOpId } from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore } from '../contract/index.js';
import { bootServer } from '../core/boot.js';
import { fakeKimi } from './fakeKimi.js';

const workspace = () =>
  mkdtempSync(path.join(tmpdir(), 'nvk-b2b-topology-'));

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
    kimiCliPath: fakeKimi(),
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
