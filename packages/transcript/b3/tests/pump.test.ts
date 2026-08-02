// The pump's own rules — §13.9.
//
// The pump exists because a mirror nobody drives is not a pipeline. What it
// must NOT do is turn "runs by itself" into "runs over a quarantine by itself",
// or into two passes racing one another's ledger writes for the same position.
import test from 'node:test';
import assert from 'node:assert/strict';
import { b3err, b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';

import { createMirrorPump } from '../core/pump.js';
import type {
  IngestTranscriptSourceInput, TranscriptIngestOutcome,
} from '../contract/api.js';
import type { TranscriptBinding } from '../contract/records.js';

function bindingOf(
  id: string, sourceDiscoveryState: TranscriptBinding['sourceDiscoveryState'],
): TranscriptBinding {
  return {
    id: id as TranscriptBinding['id'],
    kind: 'transcriptBinding',
    schemaVersion: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    permissionLevel: 'private',
    createdBy: 'sys_agent_runtime',
    recordVersion: 1 as TranscriptBinding['recordVersion'],
    agentId: 'agent_1' as TranscriptBinding['agentId'],
    agentRunId: 'agentRun_1' as TranscriptBinding['agentRunId'],
    provider: 'claude',
    providerSessionId: 'providerSession_1' as TranscriptBinding['providerSessionId'],
    sourceLocatorDigest: 'digest',
    sourceDiscoveryState,
    watcherState: 'live',
    threadId: 'thread_1',
  } as TranscriptBinding;
}

const outcomeOf = (bindingId: string, mirrored: number): TranscriptIngestOutcome => ({
  bindingId: bindingId as TranscriptIngestOutcome['bindingId'],
  discovered: mirrored, filtered: 0, mirrored, quarantined: 0,
});

test('a quarantined binding is left alone, and its neighbours still mirror', async () => {
  const asked: string[] = [];
  const pump = createMirrorPump({
    ports: {
      async listBindings() {
        return b3ok([bindingOf('b_corrupt', 'corrupt'), bindingOf('b_live', 'bound')]);
      },
      async ingest(input: IngestTranscriptSourceInput) {
        asked.push(input.bindingId);
        return b3ok(outcomeOf(input.bindingId, 1));
      },
    },
  });

  const pass = await pump.pumpOnce();

  // §13.9: "a binding already holding a quarantine does not resume by itself."
  assert.deepEqual(asked, ['b_live'],
    `the pump drove a quarantined binding: asked ${JSON.stringify(asked)}`);
  assert.equal(pass.skippedQuarantined, 1);
  assert.equal(pass.mirrored, 1);
  assert.equal(pass.considered, 2);
});

test('one binding failing does not stop the pass, and is reported', async () => {
  const pump = createMirrorPump({
    ports: {
      async listBindings() {
        return b3ok([bindingOf('b_bad', 'bound'), bindingOf('b_good', 'bound')]);
      },
      async ingest(input: IngestTranscriptSourceInput) {
        if (input.bindingId === 'b_bad') {
          return b3fail(b3err('TranscriptSourceUnavailable', 'busy',
            { bindingId: input.bindingId, reason: 'busy' }, true));
        }
        return b3ok(outcomeOf(input.bindingId, 2));
      },
    },
  });

  const pass = await pump.pumpOnce();

  assert.equal(pass.ingested, 1);
  assert.equal(pass.mirrored, 2);
  assert.deepEqual(pass.failures.map((failure) => failure.bindingId), ['b_bad']);
});

test('two passes never overlap on the same binding', async () => {
  let concurrent = 0;
  let peak = 0;
  // Every waiter, not just the last one: a second overlapping ingest must be
  // released too, or this test would detect the race by HANGING rather than by
  // failing — and a hang is not a verdict.
  const waiting: (() => void)[] = [];
  const pump = createMirrorPump({
    ports: {
      async listBindings() { return b3ok([bindingOf('b_slow', 'bound')]); },
      async ingest(input: IngestTranscriptSourceInput): Promise<B3Result<TranscriptIngestOutcome>> {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise<void>((resolve) => { waiting.push(resolve); });
        concurrent -= 1;
        return b3ok(outcomeOf(input.bindingId, 0));
      },
    },
  });

  const first = pump.pumpOnce();
  const second = pump.pumpOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const release of waiting.splice(0)) release();
  await Promise.all([first, second]);

  assert.equal(peak, 1,
    `${String(peak)} ingests of one binding were in flight at once — two passes raced`);
});

test('stop waits for the pass holding durable writes', async () => {
  let finished = false;
  const waiting: (() => void)[] = [];
  const pump = createMirrorPump({
    ports: {
      async listBindings() { return b3ok([bindingOf('b_slow', 'bound')]); },
      async ingest(input: IngestTranscriptSourceInput) {
        await new Promise<void>((resolve) => { waiting.push(resolve); });
        finished = true;
        return b3ok(outcomeOf(input.bindingId, 0));
      },
    },
  });

  const running = pump.pumpOnce();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopping = pump.stop();
  for (const release of waiting.splice(0)) release();
  await stopping;

  assert.equal(finished, true, 'stop() returned while a pass still held writes in flight');
  await running;
});
