// The mirror as a LIVE pipeline — §13.9, §13.5 row 9, §8.2.
//
// `b3c-live-event-stream.test.ts` proves the mirror works when somebody calls
// `b3.transcript.ingest`. It cannot prove anybody does. Exam rows C1/C3 (claude
// and kimi) typed a real human turn into a real PTY and found `count: 0` and
// `mirrored: []`, and L1 saw seven of §15's eight kinds with only
// `transcript.line.committed` missing — one fact seen three ways: nothing
// DRIVES the mirror.
//
// So this test never calls ingest. It spawns through the wire, lets the
// transcript source produce a turn the way a provider does, and then only
// waits. If the product needs a human to ask before a terminal turn becomes a
// Message, every assertion below fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import type {
  SourcePrefixOutcome, SourceReadOutcome, TranscriptSourcePort,
} from '../../transcript/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';
import { governedRole } from './governed-role.js';

const HUMAN_TURN = 'what did you change in the runtime?';

/**
 * A provider file that gains one human turn the moment the test says so — the
 * shape of a real transcript, without a real provider's four-minute latency.
 * Nothing in production reads this port differently.
 */
function scriptedSource(): TranscriptSourcePort & { produce(): void } {
  let live = false;
  const position = '0000000000';
  const digest = createHash('sha256').update(HUMAN_TURN, 'utf8').digest('hex');
  return {
    produce() { live = true; },
    async read(_binding, fromPosition, maxLines): Promise<SourceReadOutcome> {
      if (!live) return { kind: 'missing' };
      if (fromPosition !== undefined && position < fromPosition) {
        return { kind: 'lines', lines: [], more: false };
      }
      return {
        kind: 'lines',
        more: false,
        lines: maxLines < 1 ? [] : [{ position, role: 'user', text: HUMAN_TURN, digest }],
      };
    },
    async readPrefixDigests(_binding, throughPosition): Promise<SourcePrefixOutcome> {
      if (!live) return { kind: 'missing' };
      return {
        kind: 'digests',
        digests: position <= throughPosition ? [{ position, digest }] : [],
      };
    },
  };
}

/** Poll a wire read until it answers, or give up and let the assertion speak. */
async function until<T>(
  attempt: () => Promise<T | null>, budgetMs: number,
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = await attempt();
    if (found !== null) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('a bound Run mirrors its terminal turn with nobody asking it to', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-unprompted-'));
  const source = scriptedSource();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
    transcriptSource: source,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('unprompted-role'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
    });
    assert.equal(role.ok, true);
    if (!role.ok) return;
    const spawned = await chris.call<{
      agent: { agentId: string }; run: { id: string };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id, displayName: 'Unprompted', workingDirectory: tmpdir(),
    });
    assert.equal(spawned.ok, true,
      spawned.ok ? '' : `${spawned.error.code}: ${spawned.error.message}`);
    if (!spawned.ok) return;

    // The turn appears in the provider's transcript. That is the ONLY stimulus
    // — no ingest call, no watermark promotion, no CLI verb.
    source.produce();

    const row = await until(async () => {
      const seen = await chris.call<{
        items: readonly { messageId: string; textPreview: string }[];
      }>('b3.messaging.listAgentCommunications', {
        agentIds: [spawned.value.agent.agentId],
      });
      if (!seen.ok) return null;
      return seen.value.items.find((item) => item.textPreview.includes(HUMAN_TURN)) ?? null;
    }, 15_000);

    assert.notEqual(row, undefined);
    assert.notEqual(row, null,
      'a human turn sat in the bound Run\'s transcript and never became a Message: '
      + 'nothing in production drives the mirror');

    // §15's eighth kind, on the same stream as the other seven. L1 asked this
    // exact question after a real exchange and got `missing: [...]`.
    const page = await chris.call<{ events: readonly { kind: string }[] }>(
      'b3.agent.subscribeEvents', { limit: 500 },
    );
    assert.equal(page.ok, true, page.ok ? '' : `${page.error.code}: ${page.error.message}`);
    if (!page.ok) return;
    const kinds = new Set(page.value.events.map((event) => event.kind));
    assert.equal(kinds.has('transcript.line.committed'), true,
      `transcript.line.committed never reached the stream; saw ${[...kinds].sort().join(', ')}`);
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
