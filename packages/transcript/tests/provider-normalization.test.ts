import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  AgentId,
} from '@novakai/foundation/dist/contract/brands.js';
import {
  composeHandle,
  listObjects,
} from '@novakai/foundation/dist/contract/index.js';
import {
  composeTranscript,
  createRawTranscriptSource,
} from '../contract/index.js';

const fixtureRoot = fileURLToPath(
  new URL('../../tests/fixtures/', import.meta.url),
);

test('Kimi assistant output omits unresolved provider identity', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-adapter-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'event.jsonl',
  );
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(fixtureRoot, 'kimi', 'event.jsonl'), destination);
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    if (!ingested.ok) return;
    assert.deepEqual(
      {
        added: ingested.value.added,
        duplicates: ingested.value.duplicates,
        skipped: ingested.value.skipped.length,
        diagnostics: ingested.value.diagnostics.map(
          (entry) => entry.diagnostic?.code,
        ),
      },
      {
        added: 1,
        duplicates: 0,
        skipped: 0,
        diagnostics: [
          'session_ref_unresolved',
          'agent_attribution_unavailable',
        ],
      },
    );

    const queried = await transcript.linesByProvider('kimi');
    assert.equal(queried.ok, true);
    const lines = queried.ok ? queried.value : [];
    assert.equal(lines.length, 1);
    assert.match(lines[0]?.turnId ?? '', /^kimi:turn_[a-f0-9]{64}$/u);
    assert.deepEqual(
      lines.map((line) => ({
        role: line.role,
        text: line.text,
        parentTurnId: line.parentTurnId,
        agentId: line.agentId,
        parentAgentId: line.parentAgentId,
        sessionRef: line.sessionRef,
        tokenUsage: line.tokenUsage,
      })),
      [{
        role: 'assistant',
        text: 'synthetic kimi response',
        parentTurnId: undefined,
        agentId: undefined,
        parentAgentId: undefined,
        sessionRef: undefined,
        tokenUsage: { input: 2, output: 3 },
      }],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi tool traffic identities are opaque and roles are typed', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-tool-result-'));
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
      path.join(fixtureRoot, 'kimi', 'subagent-relation.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    const queried = await transcript.linesByProvider('kimi');
    assert.equal(queried.ok, true);
    const lines = queried.ok ? queried.value : [];
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.role),
      ['tool_call', 'tool_result'],
    );
    assert.ok(
      lines.every(
        (line) =>
          /^kimi:turn_[a-f0-9]{64}$/u.test(line.turnId)
          && /^event_[a-f0-9]{64}$/u.test(
            line.sourceAttribution.originalId ?? '',
          ),
      ),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi same-turn tool results remain distinct transcript lines', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-line-identity-'));
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
      path.join(fixtureRoot, 'kimi', 'tool-result-identity.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            duplicates: ingested.value.duplicates,
          }
        : null,
      { added: 2, duplicates: 0 },
    );
    const queried = await transcript.linesByProvider('kimi');
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    assert.equal(queried.value.length, 2);
    assert.deepEqual(
      queried.value.map((line) => line.role),
      ['tool_result', 'tool_result'],
    );
    assert.equal(
      new Set(queried.value.map(
        (line) => line.sourceAttribution.originalId,
      )).size,
      2,
    );
    assert.ok(
      queried.value.every(
        (line) =>
          /^event_[a-f0-9]{64}$/u.test(
            line.sourceAttribution.originalId ?? '',
          ),
      ),
    );
    assert.equal(
      new Set(queried.value.map((line) => line.turnId)).size,
      1,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi equal numeric turns in different sessions have distinct tree identities', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-turn-identity-'));
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
      path.join(fixtureRoot, 'kimi', 'cross-session-turn.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            duplicates: ingested.value.duplicates,
          }
        : null,
      { added: 2, duplicates: 0 },
    );
    const queried = await transcript.linesByProvider('kimi');
    assert.equal(queried.ok, true);
    if (!queried.ok) return;
    assert.equal(
      new Set(queried.value.map((line) => line.turnId)).size,
      2,
    );
    assert.ok(
      queried.value.every(
        (line) => /^kimi:turn_[a-f0-9]{64}$/u.test(line.turnId),
      ),
    );
    assert.equal(
      new Set(queried.value.map(
        (line) => line.sourceAttribution.originalId,
      )).size,
      2,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi sessionless rows preserve the payload turn identity', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-no-session-'));
  const root = path.join(workspace, '.novakai');
  const fixture = path.join(
    fixtureRoot,
    'kimi',
    'sessionless-tool-result.jsonl',
  );
  try {
    for (const sourceName of ['source-alpha', 'source-beta']) {
      const destination = path.join(
        root,
        'transcripts',
        'kimi',
        sourceName,
        'events.jsonl',
      );
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(fixture, destination);
    }
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            duplicates: ingested.value.duplicates,
          }
        : null,
      { added: 2, duplicates: 0 },
    );
    const lines = await transcript.linesByProvider('kimi');
    assert.equal(lines.ok, true);
    if (!lines.ok) return;
    assert.equal(lines.value.length, 2);
    assert.ok(
      lines.value.every(
        (line) =>
          line.sourceAttribution.originalId === undefined
          && line.turnId === 'kimi:900',
      ),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('irrelevant Kimi tool calls keep relation persistence bounded at 100 and 200 rows', async () => {
  const inspect = async (rowCount: number): Promise<{
    checkpointBytes: number;
    checkpointHasRelations: boolean;
    relationJournalCount: number;
  }> => {
    const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-scale-'));
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
      const rows = Array.from({ length: rowCount }, (_, index) =>
        JSON.stringify({
          kind: 'event',
          envelope: {
            seq: index,
            type: 'tool.call.started',
            payload: {
              agentId: 'scale-agent-redacted',
              args: {},
              description: 'synthetic irrelevant tool call',
              display: {},
              name: 'Bash',
              sessionId: 'scale-session-redacted',
              toolCallId: `scale-tool-${index}`,
              turnId: index,
              type: 'tool.call.started',
            },
          },
        })
      );
      writeFileSync(destination, `${rows.join('\n')}\n`);
      const transcript = composeTranscript({
        root,
        source: createRawTranscriptSource({ root }),
      });
      const ingested = await transcript.ingest();
      assert.deepEqual(
        ingested.ok
          ? {
              added: ingested.value.added,
              skipped: ingested.value.skipped.length,
            }
          : null,
        { added: rowCount, skipped: 0 },
      );

      const handle = composeHandle({
        root,
        dataRoot: path.join(root, 'stores'),
        capability: 'transcript',
        allowedKinds: ['transcriptCheckpoint', 'transcriptJournal'],
        principal: 'sys_ingester',
      });
      const checkpoints = await listObjects<Record<string, unknown>>(
        handle,
        'transcriptCheckpoint',
      );
      const relations = await listObjects(
        handle,
        'transcriptJournal',
        { outcome: 'relation' },
      );
      assert.equal(checkpoints.ok, true);
      assert.equal(relations.ok, true);
      const checkpoint = checkpoints.ok
        ? checkpoints.value.items[0]?.object
        : undefined;
      return {
        checkpointBytes: JSON.stringify(checkpoint).length,
        checkpointHasRelations: (
          checkpoint !== undefined
          && 'relationState' in checkpoint
        ),
        relationJournalCount: relations.ok
          ? relations.value.items.length
          : -1,
      };
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  };

  const oneHundred = await inspect(100);
  const twoHundred = await inspect(200);
  assert.deepEqual(
    {
      oneHundredHasRelations: oneHundred.checkpointHasRelations,
      twoHundredHasRelations: twoHundred.checkpointHasRelations,
      oneHundredJournal: oneHundred.relationJournalCount,
      twoHundredJournal: twoHundred.relationJournalCount,
    },
    {
      oneHundredHasRelations: false,
      twoHundredHasRelations: false,
      oneHundredJournal: 0,
      twoHundredJournal: 0,
    },
  );
  assert.ok(oneHundred.checkpointBytes < 1_024);
  assert.ok(twoHundred.checkpointBytes < 1_024);
  assert.ok(
    Math.abs(
      twoHundred.checkpointBytes - oneHundred.checkpointBytes,
    ) <= 64,
  );
});

test('Kimi AgentSwarm persists one bounded relation per spawned child and then prunes its parent', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-swarm-'));
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
      path.join(fixtureRoot, 'kimi', 'subagent-swarm.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.deepEqual(
      ingested.ok
        ? {
            added: ingested.value.added,
            skipped: ingested.value.skipped.length,
          }
        : null,
      { added: 4, skipped: 0 },
    );
    const lines = await transcript.linesByProvider('kimi');
    assert.equal(lines.ok, true);
    if (!lines.ok) return;
    assert.equal(lines.value.length, 4);
    const childLines = lines.value.filter((line) => line.parentTurnId);
    const parentTurns = new Set(
      childLines.map((line) => line.parentTurnId),
    );
    assert.equal(parentTurns.size, 1);
    const parentTurnId = childLines[0]?.parentTurnId ?? '';
    assert.match(parentTurnId, /^kimi:turn_[a-f0-9]{64}$/u);
    const tree = await transcript.subagentTree(parentTurnId);
    assert.equal(tree.ok ? tree.value.length : null, 3);

    const handle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptCheckpoint', 'transcriptJournal'],
      principal: 'sys_ingester',
    });
    const relations = await listObjects(
      handle,
      'transcriptJournal',
      { outcome: 'relation' },
    );
    const skips = await listObjects(
      handle,
      'transcriptJournal',
      { outcome: 'skipped' },
    );
    assert.equal(relations.ok ? relations.value.items.length : null, 4);
    assert.equal(skips.ok ? skips.value.items.length : null, 0);
    const checkpoints = await listObjects<Record<string, unknown>>(
      handle,
      'transcriptCheckpoint',
    );
    assert.ok(
      checkpoints.ok
      && checkpoints.value.items.every(
        (item) => !('relationState' in item.object),
      ),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi relation context survives checkpoint restart without rescanning metadata', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-relation-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  const rows = readFileSync(
    path.join(fixtureRoot, 'kimi', 'subagent-relation.jsonl'),
    'utf8',
  ).trimEnd().split('\n');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${rows.slice(0, 2).join('\n')}\n`);
    const first = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const relationPass = await first.ingest();
    assert.deepEqual(
      relationPass.ok
        ? {
            added: relationPass.value.added,
            skipped: relationPass.value.skipped.length,
            diagnostics: relationPass.value.diagnostics.length,
          }
        : null,
      { added: 1, skipped: 0, diagnostics: 2 },
    );

    appendFileSync(destination, `${rows[2]}\n`);
    process.env.NVK_FAILPOINT = 'transcript.beforeLineAppend';
    const crashing = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    await assert.rejects(
      crashing.ingest(),
      /transcript\.beforeLineAppend/u,
    );
    delete process.env.NVK_FAILPOINT;
    const restarted = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const childPass = await restarted.ingest();
    assert.deepEqual(
      childPass.ok
        ? {
            added: childPass.value.added,
            skipped: childPass.value.skipped.length,
          }
        : null,
      { added: 1, skipped: 0 },
    );

    const providerLines = await restarted.linesByProvider('kimi');
    assert.equal(providerLines.ok, true);
    const childLine = providerLines.ok
      ? providerLines.value.find((line) => line.parentTurnId)
      : undefined;
    const parentTurnId = childLine?.parentTurnId;
    assert.match(parentTurnId ?? '', /^kimi:turn_[a-f0-9]{64}$/u);
    const tree = await restarted.subagentTree(parentTurnId ?? '');
    assert.deepEqual(
      tree.ok
        ? tree.value.map((line) => ({
            role: line.role,
            text: line.text,
            turnId: line.turnId,
            parentTurnId: line.parentTurnId,
          }))
        : null,
      [{
        role: 'tool_result',
        text: 'synthetic child tool result',
        turnId: childLine?.turnId,
        parentTurnId,
      }],
    );

    const zeroPass = await restarted.ingest();
    assert.deepEqual(
      zeroPass.ok
        ? {
            added: zeroPass.value.added,
            duplicates: zeroPass.value.duplicates,
            skipped: zeroPass.value.skipped.length,
          }
        : null,
      { added: 0, duplicates: 0, skipped: 0 },
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi relation fact retry is idempotent when a crash precedes its checkpoint', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-fact-crash-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  const rows = readFileSync(
    path.join(fixtureRoot, 'kimi', 'subagent-relation.jsonl'),
    'utf8',
  ).trimEnd().split('\n');
  const priorFailpoint = process.env.NVK_FAILPOINT;
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${rows[0]}\n`);
    process.env.NVK_FAILPOINT =
      'transcript.afterRelationBeforeCheckpoint';
    const crashing = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    await assert.rejects(
      crashing.ingest(),
      /transcript\.afterRelationBeforeCheckpoint/u,
    );

    delete process.env.NVK_FAILPOINT;
    const restarted = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const retriedParent = await restarted.ingest();
    assert.deepEqual(
      retriedParent.ok
        ? {
            added: retriedParent.value.added,
            skipped: retriedParent.value.skipped.length,
          }
        : null,
      { added: 1, skipped: 0 },
    );

    appendFileSync(destination, `${rows.slice(1).join('\n')}\n`);
    const completed = await restarted.ingest();
    assert.deepEqual(
      completed.ok
        ? {
            added: completed.value.added,
            skipped: completed.value.skipped.length,
          }
        : null,
      { added: 1, skipped: 0 },
    );
    const lines = await restarted.linesByProvider('kimi');
    assert.equal(lines.ok, true);
    const parentTurnId = lines.ok
      ? lines.value.find((line) => line.parentTurnId)?.parentTurnId ?? ''
      : '';
    const tree = await restarted.subagentTree(parentTurnId);
    assert.equal(tree.ok ? tree.value.length : null, 1);

    const handle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptJournal'],
      principal: 'sys_ingester',
    });
    const relations = await listObjects(
      handle,
      'transcriptJournal',
      { outcome: 'relation' },
    );
    assert.equal(relations.ok ? relations.value.items.length : null, 2);
    const zeroPass = await restarted.ingest();
    assert.deepEqual(
      zeroPass.ok
        ? {
            added: zeroPass.value.added,
            duplicates: zeroPass.value.duplicates,
            skipped: zeroPass.value.skipped.length,
          }
        : null,
      { added: 0, duplicates: 0, skipped: 0 },
    );
  } finally {
    if (priorFailpoint === undefined) delete process.env.NVK_FAILPOINT;
    else process.env.NVK_FAILPOINT = priorFailpoint;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi native agent identities remain absent without a resolver', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-agent-trust-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  const nativeIdentitySentinels = [
    'native-parent-agent-redacted',
    'native-child-agent-redacted',
    'native-parent-tool-redacted',
    'native-child-tool-redacted',
  ];
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(
      path.join(fixtureRoot, 'kimi', 'subagent-relation.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    assert.ok(
      ingested.ok
      && ingested.value.diagnostics.some(
        (entry) =>
          entry.diagnostic.code === 'agent_attribution_unavailable',
      ),
    );

    const lines = await transcript.linesByProvider('kimi');
    assert.deepEqual(
      lines.ok
        ? lines.value.map((line) => ({
            agentId: line.agentId,
            parentAgentId: line.parentAgentId,
          }))
        : null,
      [
        { agentId: undefined, parentAgentId: undefined },
        { agentId: undefined, parentAgentId: undefined },
      ],
    );

    const storeRoot = path.join(root, 'stores');
    const persisted = readdirSync(storeRoot)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => readFileSync(path.join(storeRoot, name), 'utf8'))
      .join('');
    assert.ok(
      nativeIdentitySentinels.every(
        (sentinel) => !persisted.includes(sentinel),
      ),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Kimi persists only agent identities returned by the durable resolver', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-kimi-agent-resolver-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'kimi',
    'fixture-session',
    'events.jsonl',
  );
  const durableAgents = new Map<string, AgentId>([
    [
      'native-parent-agent-redacted',
      'agent_durable_parent' as AgentId,
    ],
    [
      'native-child-agent-redacted',
      'agent_durable_child' as AgentId,
    ],
  ]);
  const rows = readFileSync(
    path.join(fixtureRoot, 'kimi', 'subagent-relation.jsonl'),
    'utf8',
  ).trimEnd().split('\n');
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, `${rows.slice(0, 2).join('\n')}\n`);
    const relationPass = composeTranscript({
      root,
      source: createRawTranscriptSource({
        root,
        resolveAgentId: (provider, nativeId) =>
          provider === 'kimi'
            ? durableAgents.get(nativeId)
            : undefined,
      }),
    });
    const contextResult = await relationPass.ingest();
    assert.deepEqual(
      contextResult.ok
        ? {
            added: contextResult.value.added,
            skipped: contextResult.value.skipped.length,
          }
        : null,
      { added: 1, skipped: 0 },
    );

    appendFileSync(destination, `${rows[2]}\n`);
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });
    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    assert.ok(
      ingested.ok
      && ingested.value.diagnostics.every(
        (entry) =>
          entry.diagnostic.code !== 'agent_attribution_unavailable',
      ),
    );

    const providerLines = await transcript.linesByProvider('kimi');
    assert.equal(providerLines.ok, true);
    const parentTurnId = providerLines.ok
      ? providerLines.value.find((line) => line.parentTurnId)?.parentTurnId
      : undefined;
    assert.match(parentTurnId ?? '', /^kimi:turn_[a-f0-9]{64}$/u);
    const tree = await transcript.subagentTree(parentTurnId ?? '');
    assert.deepEqual(
      tree.ok
        ? tree.value.map((line) => ({
            agentId: line.agentId,
            parentAgentId: line.parentAgentId,
            parentTurnId: line.parentTurnId,
          }))
        : null,
      [{
        agentId: 'agent_durable_child',
        parentAgentId: 'agent_durable_parent',
        parentTurnId,
      }],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('TRN-002 Claude raw-copy subagent parentUuid is provider-scoped and queryable as a child turn', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-claude-adapter-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'claude',
    'fixture-session',
  );
  try {
    mkdirSync(destination, { recursive: true });
    cpSync(path.join(fixtureRoot, 'claude'), destination, {
      recursive: true,
    });
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
    assert.equal(ingested.ok, true);
    assert.equal(ingested.ok ? ingested.value.added : null, 3);

    const tree = await transcript.subagentTree(
      'claude:claude_parent_fixture',
    );
    assert.equal(tree.ok, true);
    assert.deepEqual(
      tree.ok
        ? tree.value.map((line) => ({
            text: line.text,
            turnId: line.turnId,
            parentTurnId: line.parentTurnId,
            agentId: line.agentId,
            sessionRef: line.sessionRef,
            tokenUsage: line.tokenUsage,
          }))
        : null,
      [{
        text: 'synthetic claude child',
        turnId: 'claude:claude_child_fixture',
        parentTurnId: 'claude:claude_parent_fixture',
        agentId: undefined,
        sessionRef: undefined,
        tokenUsage: { input_tokens: 6, output_tokens: 7 },
      }],
    );
    assert.ok(
      ingested.ok
      && ingested.value.diagnostics.some(
        (entry) =>
          entry.diagnostic.code === 'agent_attribution_unavailable',
      ),
    );
    const claudeLines = await transcript.linesByProvider('claude');
    const linear = claudeLines.ok
      ? claudeLines.value.find(
          (line) => line.text === 'synthetic claude linear continuation',
        )
      : undefined;
    assert.equal(linear?.turnIndex, 1);
    assert.ok((linear?.sourceOffset ?? 0) > 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Codex raw-copy adapter normalizes response items and events without inferring thread ids as attribution', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-codex-adapter-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'codex',
    'fixture-rollout',
    'rollout.jsonl',
  );
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(
      path.join(fixtureRoot, 'codex', 'rollout.jsonl'),
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
            diagnostics: ingested.value.diagnostics.map(
              (entry) => entry.diagnostic.code,
            ),
          }
        : null,
      {
        added: 2,
        diagnostics: [
          'agent_attribution_unavailable',
        ],
      },
    );

    const journalHandle = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'transcript',
      allowedKinds: ['transcriptJournal'],
      principal: 'sys_ingester',
    });
    const diagnostics = await listObjects(
      journalHandle,
      'transcriptJournal',
      { outcome: 'diagnostic' },
    );
    assert.equal(
      diagnostics.ok ? diagnostics.value.items.length : null,
      1,
      'the same unavailable attribution state is stored once per source',
    );

    const queried = await transcript.linesByProvider('codex');
    assert.equal(queried.ok, true);
    assert.deepEqual(
      queried.ok
        ? queried.value.map((line) => ({
            role: line.role,
            text: line.text,
            turnId: line.turnId,
            agentId: line.agentId,
            parentAgentId: line.parentAgentId,
            parentTurnId: line.parentTurnId,
            sessionRef: line.sessionRef,
          }))
        : null,
      [
        {
          role: 'assistant',
          text: 'synthetic codex response',
          turnId: 'codex:codex_turn_fixture',
          agentId: undefined,
          parentAgentId: undefined,
          parentTurnId: undefined,
          sessionRef: undefined,
        },
        {
          role: 'assistant',
          text: 'synthetic codex event',
          turnId: 'codex:codex_event_turn_fixture',
          agentId: undefined,
          parentAgentId: undefined,
          parentTurnId: undefined,
          sessionRef: undefined,
        },
      ],
    );
    assert.deepEqual(
      queried.ok ? queried.value.map((line) => line.turnIndex) : null,
      [0, 1],
    );
    assert.ok(
      queried.ok && (queried.value[1]?.sourceOffset ?? 0) > 1,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('Codex id-less rows in one turn remain distinct durable lines', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-codex-idless-'));
  const root = path.join(workspace, '.novakai');
  const destination = path.join(
    root,
    'transcripts',
    'codex',
    'fixture-rollout',
    'rollout.jsonl',
  );
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      [
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'first id-less row' }],
            turn_id: 'shared_codex_turn',
          },
        },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'second id-less row' }],
            turn_id: 'shared_codex_turn',
          },
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
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
      lines.ok ? lines.value.map((line) => line.text) : null,
      ['first id-less row', 'second id-less row'],
    );
    assert.deepEqual(
      lines.ok ? lines.value.map((line) => line.turnIndex) : null,
      [0, 0],
      'multiple rows in one provider turn share its real index',
    );

    appendFileSync(
      destination,
      `${JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'resumed different turn',
          turn_id: 'next_codex_turn',
        },
      })}\n`,
    );
    const resumed = await transcript.ingest();
    assert.equal(resumed.ok ? resumed.value.added : null, 1);
    const afterResume = await transcript.linesByProvider('codex');
    assert.deepEqual(
      afterResume.ok
        ? afterResume.value.map((line) => line.turnIndex)
        : null,
      [0, 0, 1],
      'checkpointed indexing continues on appended turns',
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('well-formed provider tool traffic and attachments are durable while metadata skips never enter quarantine', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-provider-real-shapes-'));
  const root = path.join(workspace, '.novakai');
  try {
    for (const provider of ['claude', 'codex', 'kimi'] as const) {
      const destination = path.join(
        root,
        'transcripts',
        provider,
        'fixture-source',
        'events.jsonl',
      );
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(
        path.join(fixtureRoot, 'real-shapes', `${provider}.jsonl`),
        destination,
      );
    }
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({ root }),
    });

    const ingested = await transcript.ingest();
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
        added: 9,
        skipped: ['non_message', 'non_message', 'non_message'],
      },
    );

    const lines = (
      await Promise.all(
        ['claude', 'codex', 'kimi'].map(
          (provider) => transcript.linesByProvider(provider as never),
        ),
      )
    ).flatMap((result) => result.ok ? result.value : []);
    assert.deepEqual(
      Object.fromEntries(
        ['claude', 'codex', 'kimi'].map((provider) => [
          provider,
          lines
            .filter((line) => line.provider === provider)
            .map((line) => line.role),
        ]),
      ),
      {
        claude: ['tool_call', 'tool_result', 'attachment'],
        codex: ['tool_call', 'tool_result', 'attachment'],
        kimi: ['tool_call', 'tool_result', 'attachment'],
      },
    );
    assert.ok(
      lines.every((line) => line.text.length > 0),
      'content rows retain serialized provider content',
    );

    const foundation = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'foundation',
      allowedKinds: ['quarantine'],
      principal: 'sys_reconciler',
    });
    const quarantine = await listObjects(foundation, 'quarantine');
    assert.equal(quarantine.ok ? quarantine.value.items.length : null, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
