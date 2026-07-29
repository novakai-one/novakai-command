import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeTranscript,
  createRawTranscriptSource,
  type TranscriptSource,
  type TranscriptSourceAdapter,
  type TranscriptSourceItem,
} from '../contract/index.js';

test('checkpoint updates do not emit retired relation state fields', () => {
  const ingestionModule = readFileSync(
    fileURLToPath(new URL('../core/ingestion.js', import.meta.url)),
    'utf8',
  );
  assert.doesNotMatch(
    ingestionModule,
    /relationState\s*:\s*undefined/u,
  );
});

class RegressionSource implements TranscriptSourceAdapter {
  constructor(
    private readonly entries: ReadonlyMap<
      string,
      readonly TranscriptSourceItem[]
    >,
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
    for (
      const entry of this.entries.get(
        `${source.provider}:${source.sourceId}`,
      ) ?? []
    ) {
      if (entry.nextOffset > fromOffset) yield entry;
    }
  }
}

test('turnId-only provider-native identity deduplicates and attributes the line', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-turn-id-dedup-'));
  const root = path.join(workspace, '.novakai');
  const source = new RegressionSource(new Map([
    ['claude:first', [{
      kind: 'candidate',
      offset: 0,
      nextOffset: 20,
      content: '{"text":"first source shape"}',
      line: {
        turnId: 'provider-turn-only',
        turnIndex: 0,
        role: 'assistant',
        text: 'first normalized line',
      },
    }]],
    ['claude:second', [{
      kind: 'candidate',
      offset: 90,
      nextOffset: 120,
      content: '{"different":"second source shape"}',
      line: {
        turnId: 'provider-turn-only',
        turnIndex: 0,
        role: 'assistant',
        text: 'second normalized line',
      },
    }]],
  ]));

  try {
    const transcript = composeTranscript({ root, source });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            duplicates: ingested.value.duplicates,
          }
        : null,
      { added: 1, duplicates: 1 },
    );

    const lines = await transcript.linesByProvider('claude');
    assert.equal(lines.ok, true);
    assert.equal(lines.ok ? lines.value.length : null, 1);
    assert.equal(
      lines.ok ? lines.value[0]?.sourceAttribution.originalId : null,
      'provider-turn-only',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('fallback dedup uses collision-safe canonical tuple encoding', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-fallback-tuple-'));
  const root = path.join(workspace, '.novakai');
  const source = new RegressionSource(new Map([
    ['codex:first', [{
      kind: 'candidate',
      offset: 2,
      nextOffset: 3,
      content: 'x1',
      line: {
        turnIndex: 0,
        role: 'assistant',
        text: 'tuple one',
        parentTurnId: '3',
      },
    }]],
    ['codex:second', [{
      kind: 'candidate',
      offset: 12,
      nextOffset: 13,
      content: 'x',
      line: {
        turnIndex: 1,
        role: 'assistant',
        text: 'tuple two',
        parentTurnId: '3',
      },
    }]],
  ]));

  try {
    const transcript = composeTranscript({ root, source });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            duplicates: ingested.value.duplicates,
          }
        : null,
      { added: 2, duplicates: 0 },
    );
    const lines = await transcript.linesByProvider('codex');
    assert.deepEqual(
      lines.ok
        ? lines.value.map((line) => line.text).sort()
        : null,
      ['tuple one', 'tuple two'],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function withOffset(instantMs: number, offsetHours: number): string {
  const shifted = new Date(
    instantMs + offsetHours * 60 * 60 * 1_000,
  ).toISOString().replace('Z', '');
  const sign = offsetHours >= 0 ? '+' : '-';
  return `${shifted}${sign}${String(Math.abs(offsetHours)).padStart(2, '0')}:00`;
}

test('linesByProvider since compares parsed instants across offsets', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-since-instant-'));
  const root = path.join(workspace, '.novakai');
  const source = new RegressionSource(new Map([
    ['kimi:one', [{
      kind: 'candidate',
      offset: 0,
      nextOffset: 10,
      content: 'one',
      line: {
        nativeId: 'since-line',
        turnIndex: 0,
        role: 'assistant',
        text: 'instant comparison',
      },
    }]],
  ]));

  try {
    const transcript = composeTranscript({ root, source });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    const all = await transcript.linesByProvider('kimi');
    assert.equal(all.ok, true);
    if (!all.ok || !all.value[0]) return;
    const createdMs = Date.parse(all.value[0].createdAt);

    const equivalentOffset = withOffset(createdMs, 14);
    const equivalent = await transcript.linesByProvider(
      'kimi',
      equivalentOffset,
    );
    assert.deepEqual(
      equivalent.ok ? equivalent.value.map((line) => line.text) : null,
      ['instant comparison'],
    );

    const actuallyAfterButLexicallyEarlier = withOffset(createdMs + 1, -12);
    const after = await transcript.linesByProvider(
      'kimi',
      actuallyAfterButLexicallyEarlier,
    );
    assert.deepEqual(after.ok ? after.value : null, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('provider-scoped stored turn IDs keep equal native trees isolated', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-scoped-turn-id-'));
  const root = path.join(workspace, '.novakai');
  const source = new RegressionSource(new Map([
    ['claude:tree', [{
      kind: 'candidate',
      offset: 0,
      nextOffset: 10,
      content: 'claude parent',
      line: {
        nativeId: 'claude-parent-line',
        turnId: 'shared-native-turn',
        turnIndex: 0,
        role: 'assistant',
        text: 'claude parent',
      },
    }, {
      kind: 'candidate',
      offset: 10,
      nextOffset: 20,
      content: 'claude child',
      line: {
        nativeId: 'claude-child-line',
        turnId: 'claude-child-turn',
        turnIndex: 1,
        role: 'assistant',
        text: 'claude child',
        parentTurnId: 'shared-native-turn',
      },
    }]],
    ['codex:tree', [{
      kind: 'candidate',
      offset: 0,
      nextOffset: 10,
      content: 'codex parent',
      line: {
        nativeId: 'codex-parent-line',
        turnId: 'shared-native-turn',
        turnIndex: 0,
        role: 'assistant',
        text: 'codex parent',
      },
    }, {
      kind: 'candidate',
      offset: 10,
      nextOffset: 20,
      content: 'codex child',
      line: {
        nativeId: 'codex-child-line',
        turnId: 'codex-child-turn',
        turnIndex: 1,
        role: 'assistant',
        text: 'codex child',
        parentTurnId: 'shared-native-turn',
      },
    }]],
  ]));

  try {
    const transcript = composeTranscript({ root, source });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok && ingested.value.added, 4);

    const claude = await transcript.linesByProvider('claude');
    const codex = await transcript.linesByProvider('codex');
    assert.equal(claude.ok && codex.ok, true);
    if (!claude.ok || !codex.ok) return;
    const claudeParent = claude.value.find(
      (line) => line.text === 'claude parent',
    );
    const codexParent = codex.value.find(
      (line) => line.text === 'codex parent',
    );
    assert.ok(claudeParent);
    assert.ok(codexParent);
    assert.notEqual(claudeParent.turnId, codexParent.turnId);

    const claudeTree = await transcript.subagentTree(claudeParent.turnId);
    const codexTree = await transcript.subagentTree(codexParent.turnId);
    assert.deepEqual(
      claudeTree.ok ? claudeTree.value.map((line) => line.text) : null,
      ['claude child'],
    );
    assert.deepEqual(
      codexTree.ok ? 'supported' : codexTree.error.code,
      'TranscriptTreeUnsupported',
    );
    const unscoped = await transcript.subagentTree('shared-native-turn');
    assert.deepEqual(unscoped.ok ? unscoped.value : null, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('ingestion begins reading the first source before discovery completes', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-stream-sources-'));
  const root = path.join(workspace, '.novakai');
  let releaseDiscovery!: () => void;
  let markFirstRead!: () => void;
  const discoveryGate = new Promise<void>((resolve) => {
    releaseDiscovery = resolve;
  });
  const firstRead = new Promise<void>((resolve) => {
    markFirstRead = resolve;
  });
  const firstSource = {
    provider: 'kimi' as const,
    sourceId: `source_${'1'.repeat(64)}`,
  };
  const secondSource = {
    provider: 'kimi' as const,
    sourceId: `source_${'2'.repeat(64)}`,
  };
  const source = {
    async *sources(): AsyncIterable<TranscriptSource> {
      yield firstSource;
      await discoveryGate;
      yield secondSource;
    },
    async *read(
      candidate: TranscriptSource,
    ): AsyncIterable<TranscriptSourceItem> {
      if (candidate.sourceId === firstSource.sourceId) markFirstRead();
      yield {
        kind: 'candidate',
        offset: 0,
        nextOffset: 20,
        content: `content:${candidate.sourceId}`,
        line: {
          nativeId: candidate.sourceId,
          turnId: candidate.sourceId,
          turnIndex: 0,
          role: 'assistant',
          text: `line:${candidate.sourceId}`,
        },
      };
    },
  } as unknown as TranscriptSourceAdapter;

  try {
    const transcript = composeTranscript({ root, source });
    const ingesting = transcript.ingest();
    const beganBeforeDiscoveryCompleted = await Promise.race([
      firstRead.then(() => true),
      ingesting.then(() => false),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 100);
      }),
    ]);
    assert.equal(beganBeforeDiscoveryCompleted, true);

    releaseDiscovery();
    const result = await ingesting;
    assert.deepEqual(
      result.ok
        ? {
            added: result.value.added,
            duplicates: result.value.duplicates,
          }
        : null,
      { added: 2, duplicates: 0 },
    );
  } finally {
    releaseDiscovery();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('raw source handles expire when discovery advances or completes', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-source-expiry-'));
  const root = path.join(workspace, '.novakai');
  const providerRoot = path.join(root, 'transcripts', 'kimi');
  const row = `${JSON.stringify({
    kind: 'event',
    envelope: {
      seq: 1,
      timestamp: '2026-07-29T06:07:08.000Z',
      type: 'assistant_output',
      payload: {
        agentId: 'agent_source_expiry',
        turnId: 'turn_source_expiry',
        output: 'synthetic source expiry',
      },
    },
  })}\n`;
  const consume = async (
    source: TranscriptSourceAdapter,
    candidate: TranscriptSource,
  ): Promise<void> => {
    for await (const _item of source.read(candidate, 0)) {
      // Consumption is the public observation; item content is irrelevant.
    }
  };

  try {
    mkdirSync(path.join(providerRoot, 'a'), { recursive: true });
    mkdirSync(path.join(providerRoot, 'b'), { recursive: true });
    mkdirSync(path.join(providerRoot, 'c'), { recursive: true });
    writeFileSync(path.join(providerRoot, 'a', 'events.jsonl'), row);
    writeFileSync(path.join(providerRoot, 'b', 'events.jsonl'), row);
    writeFileSync(path.join(providerRoot, 'c', 'events.jsonl'), row);
    const source = createRawTranscriptSource({ root });
    const discovery = source.sources()[Symbol.asyncIterator]();

    const first = await discovery.next();
    assert.equal(first.done, false);
    const second = await discovery.next();
    assert.equal(second.done, false);
    if (first.done || second.done) return;

    await assert.rejects(
      consume(source, first.value),
      /transcript source is not discovered/u,
    );

    await consume(source, second.value);
    await assert.rejects(
      consume(source, second.value),
      /transcript source is not discovered/u,
    );
    const third = await discovery.next();
    assert.equal(third.done, false);
    if (third.done) return;

    const completed = await discovery.next();
    assert.equal(completed.done, true);
    await assert.rejects(
      consume(source, third.value),
      /transcript source is not discovered/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
