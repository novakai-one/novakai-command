import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  listObjects,
  type QuarantineTombstone,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeTranscript,
  createRawTranscriptSource,
  type TranscriptSource,
  type TranscriptSourceAdapter,
  type TranscriptSourceItem,
} from '../contract/index.js';

const fixtureRoot = fileURLToPath(
  new URL('../../tests/fixtures/', import.meta.url),
);

test('ingestion errors expose only the opaque source reference', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-source-error-'));
  const root = path.join(workspace, '.novakai');
  const sourceId = `source_${'a'.repeat(64)}`;
  const secretPath = path.join(
    workspace,
    'SECRET_PROJECT_NAME',
    'events.jsonl',
  );
  const source: TranscriptSourceAdapter = {
    async *sources(): AsyncIterable<TranscriptSource> {
      yield { provider: 'kimi', sourceId };
    },
    async *read(): AsyncIterable<TranscriptSourceItem> {
      throw new Error(`EACCES: permission denied, open '${secretPath}'`);
    },
  };
  try {
    const result = await composeTranscript({ root, source }).ingest();
    assert.deepEqual(
      result.ok ? null : result.error,
      {
        code: 'TranscriptSourceFailed',
        message: `transcript source "${sourceId}" failed`,
        details: {
          sourceId,
          cause: 'provider source unavailable',
        },
        retryable: true,
      },
    );
    assert.equal(JSON.stringify(result).includes(secretPath), false);
    assert.equal(JSON.stringify(result).includes('SECRET_PROJECT_NAME'), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('TRN-004 rejected raw rows request Foundation quarantine and later valid rows continue', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-trn-004-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(
      path.join(fixtureRoot, 'kimi', 'failures-then-valid.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            skipped: ingested.value.skipped.map(
              (entry) => entry.skip.code,
            ),
          }
        : null,
      {
        added: 1,
        skipped: ['malformed_json', 'non_message'],
      },
    );

    const queryHandle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptLine'],
      principal: 'sys_ingester',
    });
    const quarantined = await listObjects<QuarantineTombstone>(
      queryHandle,
      'quarantine',
      undefined,
      { limit: 10 },
    );
    assert.equal(quarantined.ok, true);
    assert.deepEqual(
      quarantined.ok
        // Q10: Foundation CONSTRUCTS the tombstone; Transcript is recorded as
        // the requester, never as the writer.
        ? quarantined.value.items.map(({ object }) => ({
            createdBy: object.createdBy,
            requestedByPrincipal: object.requestedBy?.principalId,
            targetKind: object.quarantinedRef.kind,
            reason: object.reason,
          }))
        : null,
      [
        {
          createdBy: 'sys_foundation',
          requestedByPrincipal: 'sys_ingester',
          targetKind: 'transcriptLine',
          reason: 'corrupt_record',
        },
      ],
    );

    const lines = await transcript.linesByProvider('kimi');
    assert.deepEqual(
      lines.ok ? lines.value.map((line) => line.text) : null,
      ['synthetic valid line after failures'],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('NVK_FAILPOINT transcript.beforeLineAppend leaves no line or checkpoint and retry adds once', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-fail-before-line-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'event.jsonl',
  );
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(fixtureRoot, 'kimi', 'event.jsonl'), destination);
    process.env.NVK_FAILPOINT = 'transcript.beforeLineAppend';
    const crashing = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    await assert.rejects(
      crashing.ingest(),
      /transcript\.beforeLineAppend/u,
    );

    const queryHandle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptLine', 'transcriptCheckpoint'],
      principal: 'sys_ingester',
    });
    const beforeRetryLines = await listObjects(
      queryHandle,
      'transcriptLine',
    );
    const beforeRetryCheckpoints = await listObjects(
      queryHandle,
      'transcriptCheckpoint',
    );
    assert.equal(
      beforeRetryLines.ok ? beforeRetryLines.value.items.length : null,
      0,
    );
    assert.equal(
      beforeRetryCheckpoints.ok
        ? beforeRetryCheckpoints.value.items.length
        : null,
      0,
    );

    delete process.env.NVK_FAILPOINT;
    const retrying = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const retry = await retrying.ingest();
    assert.deepEqual(
      retry.ok
        ? {
            added: retry.value.added,
            duplicates: retry.value.duplicates,
          }
        : null,
      { added: 1, duplicates: 0 },
    );
    const afterRetryLines = await retrying.linesByProvider('kimi');
    assert.equal(
      afterRetryLines.ok ? afterRetryLines.value.length : null,
      1,
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('NVK_FAILPOINT transcript.afterLineAppendBeforeCheckpoint deduplicates the durable line and advances on retry', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-fail-after-line-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'event.jsonl',
  );
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(fixtureRoot, 'kimi', 'event.jsonl'), destination);
    process.env.NVK_FAILPOINT =
      'transcript.afterLineAppendBeforeCheckpoint';
    const crashing = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    await assert.rejects(
      crashing.ingest(),
      /transcript\.afterLineAppendBeforeCheckpoint/u,
    );

    const queryHandle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptLine', 'transcriptCheckpoint'],
      principal: 'sys_ingester',
    });
    const afterCrashLines = await listObjects(
      queryHandle,
      'transcriptLine',
    );
    const afterCrashCheckpoints = await listObjects(
      queryHandle,
      'transcriptCheckpoint',
    );
    assert.equal(
      afterCrashLines.ok ? afterCrashLines.value.items.length : null,
      1,
    );
    assert.equal(
      afterCrashCheckpoints.ok
        ? afterCrashCheckpoints.value.items.length
        : null,
      0,
    );

    delete process.env.NVK_FAILPOINT;
    const retrying = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const retry = await retrying.ingest();
    assert.deepEqual(
      retry.ok
        ? {
            added: retry.value.added,
            duplicates: retry.value.duplicates,
          }
        : null,
      { added: 0, duplicates: 1 },
    );
    const afterRetryLines = await retrying.linesByProvider('kimi');
    const afterRetryCheckpoints = await listObjects(
      queryHandle,
      'transcriptCheckpoint',
    );
    assert.equal(
      afterRetryLines.ok ? afterRetryLines.value.length : null,
      1,
    );
    assert.equal(
      afterRetryCheckpoints.ok
        ? afterRetryCheckpoints.value.items.length
        : null,
      1,
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('NVK_FAILPOINT transcript.afterQuarantineBeforeSkip reuses one tombstone then skips and continues on retry', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-fail-quarantine-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(
      path.join(fixtureRoot, 'kimi', 'quarantine-then-valid.jsonl'),
      destination,
    );
    process.env.NVK_FAILPOINT =
      'transcript.afterQuarantineBeforeSkip';
    const crashing = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    await assert.rejects(
      crashing.ingest(),
      /transcript\.afterQuarantineBeforeSkip/u,
    );

    const queryHandle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: [
        'transcriptLine',
        'transcriptJournal',
        'transcriptCheckpoint',
      ],
      principal: 'sys_ingester',
    });
    const afterCrashQuarantine = await listObjects(
      queryHandle,
      'quarantine',
    );
    const afterCrashJournal = await listObjects(
      queryHandle,
      'transcriptJournal',
    );
    const afterCrashCheckpoints = await listObjects(
      queryHandle,
      'transcriptCheckpoint',
    );
    assert.equal(
      afterCrashQuarantine.ok
        ? afterCrashQuarantine.value.items.length
        : null,
      1,
    );
    assert.equal(
      afterCrashJournal.ok ? afterCrashJournal.value.items.length : null,
      0,
    );
    assert.equal(
      afterCrashCheckpoints.ok
        ? afterCrashCheckpoints.value.items.length
        : null,
      0,
    );

    delete process.env.NVK_FAILPOINT;
    const retrying = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const retry = await retrying.ingest();
    assert.deepEqual(
      retry.ok
        ? {
            added: retry.value.added,
            skipped: retry.value.skipped.map(
              (entry) => entry.skip.code,
            ),
          }
        : null,
      { added: 1, skipped: ['malformed_json'] },
    );
    const afterRetryQuarantine = await listObjects(
      queryHandle,
      'quarantine',
    );
    const afterRetryJournal = await listObjects(
      queryHandle,
      'transcriptJournal',
      { outcome: 'skipped' },
    );
    const afterRetryCheckpoints = await listObjects(
      queryHandle,
      'transcriptCheckpoint',
    );
    assert.equal(
      afterRetryQuarantine.ok
        ? afterRetryQuarantine.value.items.length
        : null,
      1,
    );
    assert.equal(
      afterRetryJournal.ok ? afterRetryJournal.value.items.length : null,
      1,
    );
    assert.equal(
      afterRetryCheckpoints.ok
        ? afterRetryCheckpoints.value.items.length
        : null,
      1,
    );
    const lines = await retrying.linesByProvider('kimi');
    assert.deepEqual(
      lines.ok ? lines.value.map((line) => line.text) : null,
      ['synthetic valid line after quarantine crash'],
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    point: 'transcript.afterSkipJournalBeforeCheckpoint',
    provider: 'claude',
    row: JSON.stringify({
      type: 'queue-operation',
      operation: 'dequeue',
    }),
    afterCrash: { lines: 0, journal: 1, checkpoints: 0 },
    afterRetry: { lines: 0, journal: 1, checkpoints: 1 },
  },
  {
    point: 'transcript.afterDiagnosticJournalBeforeCheckpoint',
    provider: 'kimi',
    row: readFileSync(
      path.join(fixtureRoot, 'kimi', 'event.jsonl'),
      'utf8',
    ).trimEnd(),
    afterCrash: { lines: 1, journal: 1, checkpoints: 0 },
    afterRetry: { lines: 1, journal: 2, checkpoints: 1 },
  },
  {
    point: 'transcript.beforeCheckpointAppend',
    provider: 'kimi',
    row: readFileSync(
      path.join(fixtureRoot, 'kimi', 'event.jsonl'),
      'utf8',
    ).trimEnd(),
    afterCrash: { lines: 1, journal: 2, checkpoints: 0 },
    afterRetry: { lines: 1, journal: 2, checkpoints: 1 },
  },
] as const) {
  test(`NVK_FAILPOINT ${scenario.point} preserves effects and retries once`, async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-fail-effect-'));
    const root = path.join(workspace, '.novakai');
    const destination = path.join(
      root,
      'transcripts',
      scenario.provider,
      'fixture-source',
      'events.jsonl',
    );
    const priorFailpoint = process.env.NVK_FAILPOINT;
    const counts = async () => {
      const queryHandle = composeHandle({
        root,
        dataRoot: path.join(root, 'stores'),
        capability: 'transcript',
        allowedKinds: [
          'transcriptLine',
          'transcriptJournal',
          'transcriptCheckpoint',
        ],
        principal: 'sys_ingester',
      });
      const [lines, journal, checkpoints] = await Promise.all([
        listObjects(queryHandle, 'transcriptLine'),
        listObjects(queryHandle, 'transcriptJournal'),
        listObjects(queryHandle, 'transcriptCheckpoint'),
      ]);
      return {
        lines: lines.ok ? lines.value.items.length : -1,
        journal: journal.ok ? journal.value.items.length : -1,
        checkpoints: checkpoints.ok
          ? checkpoints.value.items.length
          : -1,
      };
    };
    try {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, `${scenario.row}\n`);
      process.env.NVK_FAILPOINT = scenario.point;
      const crashing = composeTranscript({
        root,
        source: createRawTranscriptSource({ root }),
      });
      await assert.rejects(crashing.ingest(), new RegExp(scenario.point));
      assert.deepEqual(await counts(), scenario.afterCrash);

      delete process.env.NVK_FAILPOINT;
      const retrying = composeTranscript({
        root,
        source: createRawTranscriptSource({ root }),
      });
      assert.equal((await retrying.ingest()).ok, true);
      assert.deepEqual(await counts(), scenario.afterRetry);
    } finally {
      if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
      else process.env.NVK_FAILPOINT = priorFailpoint;
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test('provider path identity is persisted only as one deterministic opaque source reference', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-source-privacy-'));
  const root = path.join(workspace, '.novakai');
  const pathSentinel = 'provider_path_identity_must_not_persist';
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    pathSentinel,
    'nested-session',
    'events.jsonl',
  );
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(
      path.join(fixtureRoot, 'kimi', 'failures-then-valid.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    const lines = await transcript.linesByProvider('kimi');
    assert.equal(lines.ok, true);
    if (!lines.ok) return;

    const persistedSourceIds = [
      ...ingested.value.skipped.map((entry) => entry.sourceId),
      ...ingested.value.diagnostics.map((entry) => entry.sourceId),
      ...lines.value.map((line) => line.sourceId),
    ];
    assert.ok(persistedSourceIds.length > 0);
    assert.equal(new Set(persistedSourceIds).size, 1);
    assert.match(persistedSourceIds[0]!, /^source_[a-f0-9]{64}$/u);
    assert.ok(
      persistedSourceIds.every((sourceId) => !sourceId.includes(pathSentinel)),
    );
    assert.ok(
      lines.value.every(
        (line) => !line.sourceAttribution.origin.includes(pathSentinel),
      ),
    );

    const queryHandle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptCheckpoint'],
      principal: 'sys_ingester',
    });
    const checkpoints = await listObjects<{
      sourceId: string;
    }>(queryHandle, 'transcriptCheckpoint');
    assert.equal(checkpoints.ok, true);
    assert.deepEqual(
      checkpoints.ok
        ? checkpoints.value.items.map((item) => item.object.sourceId)
        : null,
      [persistedSourceIds[0]],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('symlinked provider roots are rejected without reading outside transcript custody', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-source-symlink-'));
  const root = path.join(workspace, '.novakai');
  const outside = path.join(workspace, 'outside-custody');
  const outsideFile = path.join(outside, 'external.jsonl');
  try {
    mkdirSync(outside, { recursive: true });
    copyFileSync(path.join(fixtureRoot, 'kimi', 'event.jsonl'), outsideFile);
    mkdirSync(path.join(root, 'transcripts'), { recursive: true });
    symlinkSync(outside, path.join(root, 'transcripts', 'kimi'), 'dir');

    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, false);
    assert.equal(
      ingested.ok ? null : ingested.error.code,
      'TranscriptSourceFailed',
    );
    assert.match(
      ingested.ok ? '' : ingested.error.message,
      /transcript source discovery failed/u,
    );

    const lines = await transcript.linesByProvider('kimi');
    assert.deepEqual(lines.ok ? lines.value : null, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('unterminated EOF tails wait for newline completion without skip or quarantine', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-partial-tail-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  const completedRow = JSON.stringify({
    kind: 'event',
    envelope: {
      seq: 11,
      timestamp: '2026-07-29T05:06:07.000Z',
      type: 'assistant_output',
      payload: {
        agentId: 'agent_partial_fixture',
        turnId: 'turn_partial_fixture',
        output: 'synthetic completed partial row',
      },
    },
  });
  const splitAt = Math.floor(completedRow.length / 2);
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, completedRow.slice(0, splitAt));
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const partialPass = await transcript.ingest();
    assert.deepEqual(
      partialPass.ok
        ? {
            added: partialPass.value.added,
            skipped: partialPass.value.skipped.length,
          }
        : null,
      { added: 0, skipped: 0 },
    );

    appendFileSync(destination, `${completedRow.slice(splitAt)}\n`);
    const completedPass = await transcript.ingest();
    assert.deepEqual(
      completedPass.ok
        ? {
            added: completedPass.value.added,
            skipped: completedPass.value.skipped.length,
          }
        : null,
      { added: 1, skipped: 0 },
    );
    const lines = await transcript.linesByProvider('kimi');
    assert.deepEqual(
      lines.ok ? lines.value.map((line) => line.text) : null,
      ['synthetic completed partial row'],
    );

    const queryHandle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptJournal', 'transcriptCheckpoint'],
      principal: 'sys_ingester',
    });
    const skips = await listObjects(
      queryHandle,
      'transcriptJournal',
      { outcome: 'skipped' },
    );
    const quarantine = await listObjects(queryHandle, 'quarantine');
    assert.equal(skips.ok ? skips.value.items.length : null, 0);
    assert.equal(
      quarantine.ok ? quarantine.value.items.length : null,
      0,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
