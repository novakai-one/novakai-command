import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TranscriptJournalEntry,
  TranscriptLine,
  composeTranscript,
  type SessionRef,
  type TranscriptSource,
  type TranscriptSourceAdapter,
  type TranscriptSourceItem,
} from '../contract/index.js';

class MemoryTranscriptSource implements TranscriptSourceAdapter {
  readonly reads: Array<{ sourceId: string; fromOffset: number }> = [];

  constructor(
    private readonly entries: ReadonlyMap<string, readonly TranscriptSourceItem[]>,
  ) {}

  async *sources(): AsyncIterable<TranscriptSource> {
    for (const key of this.entries.keys()) {
      const separator = key.indexOf(':');
      yield {
        provider: key.slice(0, separator) as TranscriptSource['provider'],
        sourceId: key.slice(separator + 1),
      };
    }
  }

  async *read(
    source: TranscriptSource,
    fromOffset: number,
  ): AsyncIterable<TranscriptSourceItem> {
    this.reads.push({ sourceId: source.sourceId, fromOffset });
    const key = `${source.provider}:${source.sourceId}`;
    for (const entry of this.entries.get(key) ?? []) {
      if (entry.nextOffset > fromOffset) yield entry;
    }
  }
}

const nativeCandidate = {
  kind: 'candidate' as const,
  offset: 0,
  nextOffset: 80,
  content: '{"id":"native-turn","role":"assistant","text":"native"}',
  line: {
    nativeId: 'native-turn',
    turnId: 'native-turn',
    turnIndex: 0,
    role: 'assistant' as const,
    text: 'native',
    sessionRef: 'providerSession_claude_1' as SessionRef,
    tokenUsage: { input: 2, output: 3 },
  },
};

const fallbackCandidate = {
  kind: 'candidate' as const,
  offset: 100,
  nextOffset: 180,
  content: '{"role":"assistant","text":"fallback"}',
  line: {
    turnIndex: 1,
    role: 'assistant' as const,
    text: 'fallback',
    parentTurnId: 'parent-turn',
  },
};

function contractEntries(): Map<string, readonly TranscriptSourceItem[]> {
  return new Map([
    ['claude:native-a', [nativeCandidate]],
    ['claude:native-b', [{ ...nativeCandidate, offset: 90, nextOffset: 170 }]],
    ['claude:fallback-a', [fallbackCandidate]],
    ['claude:fallback-b', [fallbackCandidate]],
    ['codex:unsupported', [{
      kind: 'skip',
      offset: 0,
      nextOffset: 41,
      reason: {
        code: 'unsupported_shape',
        message: 'fixture has no normalized transcript line',
      },
    }]],
  ]);
}

test('Transcript authority deduplicates native/fallback identities and stamps valid records', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-transcript-records-'));
  const root = path.join(workspace, '.novakai');
  try {
    const transcript = composeTranscript({
      root,
      source: new MemoryTranscriptSource(contractEntries()),
    });
    assert.deepEqual(
      Object.keys(transcript).sort(),
      ['ingest', 'linesByProvider', 'linesBySession', 'subagentTree'],
    );
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            duplicates: ingested.value.duplicates,
          }
        : null,
      { added: 2, duplicates: 2 },
    );
    const byProvider = await transcript.linesByProvider('claude');
    assert.equal(byProvider.ok, true);
    if (!byProvider.ok) return;
    assert.equal(byProvider.value.length, 2);
    for (const line of byProvider.value) {
      assert.equal(TranscriptLine.safeParse(line).success, true);
      assert.equal(line.kind, 'transcriptLine');
      assert.equal(line.schemaVersion, 1);
      assert.equal(line.permissionLevel, 'private');
      assert.equal(line.createdBy, 'sys_ingester');
      assert.ok(!Number.isNaN(Date.parse(line.createdAt)));
      assert.ok(!Number.isNaN(Date.parse(line.sourceAttribution.ingestedAt)));
    }
    const native = byProvider.value.find((line) => line.text === 'native');
    assert.deepEqual(native?.sourceAttribution, {
      origin: 'claude:native-a',
      originalId: 'native-turn',
      ingestedAt: native?.createdAt,
    });
    assert.deepEqual(native?.tokenUsage, { input: 2, output: 3 });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('typed source skips return runtime-valid Transcript journal entries', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-transcript-skip-'));
  const root = path.join(workspace, '.novakai');
  const entries = new Map<string, readonly TranscriptSourceItem[]>([
    ['codex:unsupported', contractEntries().get('codex:unsupported') ?? []],
  ]);
  try {
    const transcript = composeTranscript({
      root,
      source: new MemoryTranscriptSource(entries),
    });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.equal(ingested.value.added, 0);
    assert.equal(ingested.value.duplicates, 0);
    assert.equal(ingested.value.skipped.length, 1);
    assert.equal(
      ingested.value.skipped[0]?.skip.code,
      'unsupported_shape',
    );
    assert.equal(
      TranscriptJournalEntry.safeParse(ingested.value.skipped[0]).success,
      true,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('durable incremental checkpoints make restart re-ingestion a zero-add result', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-transcript-restart-'));
  const root = path.join(workspace, '.novakai');
  const entries = contractEntries();
  try {
    const first = composeTranscript({
      root,
      source: new MemoryTranscriptSource(entries),
    });
    const initial = await first.ingest();
    assert.equal(initial.ok, true);

    const restartSource = new MemoryTranscriptSource(entries);
    const restarted = composeTranscript({ root, source: restartSource });
    const replay = await restarted.ingest();
    assert.deepEqual(
      replay.ok
        ? {
            added: replay.value.added,
            duplicates: replay.value.duplicates,
            skipped: replay.value.skipped.length,
          }
        : null,
      { added: 0, duplicates: 0, skipped: 0 },
    );
    assert.deepEqual(
      restartSource.reads.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      [
        { sourceId: 'fallback-a', fromOffset: 180 },
        { sourceId: 'fallback-b', fromOffset: 180 },
        { sourceId: 'native-a', fromOffset: 80 },
        { sourceId: 'native-b', fromOffset: 170 },
        { sourceId: 'unsupported', fromOffset: 41 },
      ],
    );
    const afterRestart = await restarted.linesByProvider('claude');
    assert.equal(afterRestart.ok && afterRestart.value.length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('read-only Transcript queries filter by session, provider instant, and scoped tree', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-transcript-queries-'));
  const root = path.join(workspace, '.novakai');
  try {
    const transcript = composeTranscript({
      root,
      source: new MemoryTranscriptSource(contractEntries()),
    });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);

    const bySession = await transcript.linesBySession(
      'providerSession_claude_1' as SessionRef,
    );
    assert.deepEqual(
      bySession.ok ? bySession.value.map((line) => line.text) : null,
      ['native'],
    );
    const sinceFuture = await transcript.linesByProvider(
      'claude',
      '2999-01-01T00:00:00.000Z',
    );
    assert.deepEqual(sinceFuture.ok ? sinceFuture.value : null, []);
    const subagentTree = await transcript.subagentTree(
      'claude:parent-turn',
    );
    assert.deepEqual(
      subagentTree.ok ? subagentTree.value.map((line) => line.text) : null,
      ['fallback'],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
