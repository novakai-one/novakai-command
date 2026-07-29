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
    assert.deepEqual(
      queried.ok
        ? queried.value.map((line) => ({
            role: line.role,
            text: line.text,
            turnId: line.turnId,
            parentTurnId: line.parentTurnId,
            agentId: line.agentId,
            parentAgentId: line.parentAgentId,
            sessionRef: line.sessionRef,
            tokenUsage: line.tokenUsage,
          }))
        : null,
      [{
        role: 'assistant',
        text: 'synthetic kimi response',
        turnId: 'kimi:turn_child_fixture',
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

test('Kimi numeric tool.result identity is canonical and role is tool', async () => {
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
    assert.deepEqual(
      queried.ok
        ? queried.value.map((line) => ({
            role: line.role,
            turnId: line.turnId,
            originalId: line.sourceAttribution.originalId,
          }))
        : null,
      [{
        role: 'tool',
        turnId: 'kimi:411',
        originalId: '411',
      }],
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
      { added: 0, skipped: 0, diagnostics: 0 },
    );

    appendFileSync(destination, `${rows[2]}\n`);
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

    const tree = await restarted.subagentTree('kimi:410');
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
        role: 'tool',
        text: 'synthetic child tool result',
        turnId: 'kimi:411',
        parentTurnId: 'kimi:410',
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
      [{ agentId: undefined, parentAgentId: undefined }],
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
  try {
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(
      path.join(fixtureRoot, 'kimi', 'subagent-relation.jsonl'),
      destination,
    );
    const transcript = composeTranscript({
      root,
      source: createRawTranscriptSource({
        root,
        resolveAgentId: (provider, nativeId) =>
          provider === 'kimi'
            ? durableAgents.get(nativeId)
            : undefined,
      }),
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

    const tree = await transcript.subagentTree('kimi:410');
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
        parentTurnId: 'kimi:410',
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
    assert.equal(ingested.ok ? ingested.value.added : null, 2);

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
          'agent_attribution_unavailable',
        ],
      },
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
