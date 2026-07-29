import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeTranscript,
  type TranscriptSource,
  type TranscriptSourceAdapter,
  type TranscriptSourceItem,
} from '../contract/index.js';

class RegressionSource implements TranscriptSourceAdapter {
  constructor(
    private readonly entries: ReadonlyMap<
      string,
      readonly TranscriptSourceItem[]
    >,
  ) {}

  async sources(): Promise<readonly TranscriptSource[]> {
    return [...this.entries.keys()].map((key) => {
      const separator = key.indexOf(':');
      return {
        provider: key.slice(0, separator) as TranscriptSource['provider'],
        sourceId: key.slice(separator + 1),
      };
    });
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
