// Real Claude Code (2.1.219) native row shapes, as written to
// ~/.claude/projects/<slug>/<sessionId>.jsonl.
//
// The distinguishing fact these rows carry, which the synthetic fixture in
// provider-turn-boundary.test.ts did not: Claude Code records TOOL RESULTS as
// user-role rows (`{"type":"user","message":{"role":"user","content":[{"type":
// "tool_result",...}]}}`). A completion scan that treats every user-role row as
// a new human turn therefore aborts the instant the agent calls any tool, and
// no real tool-using turn can ever be proven complete.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  deterministicId, mintProviderSessionId, mintProviderTurnId,
  type TranscriptBindingId,
} from '@novakai/foundation/contract';
import {
  boundaryProfile, observeProviderBoundarySource,
} from '../adapters/providers/turn-boundary.js';
import type {
  ProviderTurnBoundaryInput, ProviderTurnBoundaryObservation,
} from '../contract/providers.js';

const CLAUDE_VERSION = '2.1.219 (Claude Code)';
const SESSION = '5f1c1de1-7a3a-4f6d-9d3f-91f0a37a2c88';
const digestOf = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const prompt = 'read the report and summarise the failure';

const observe = (
  contents: string,
  overrides: Partial<ProviderTurnBoundaryInput> = {},
): ProviderTurnBoundaryObservation => {
  const boundaryInput: ProviderTurnBoundaryInput = {
    providerSessionId: mintProviderSessionId(),
    providerNativeSessionId: SESSION,
    transcriptBindingId: deterministicId(
      'transcriptBinding', ['claude-native-shape-fixture'],
    ) as TranscriptBindingId,
    providerTurnId: mintProviderTurnId(),
    inputDigest: digestOf(prompt),
    startTranscriptWatermark: null,
    currentTranscriptWatermark: '0000000099',
    ...overrides,
  };
  return observeProviderBoundarySource(
    boundaryProfile('claude', CLAUDE_VERSION), boundaryInput, contents,
  );
};

const jsonl = (...rows: readonly unknown[]): string =>
  rows.map((row) => JSON.stringify(row)).join('\n');

const position = (ordinal: number): string => String(ordinal).padStart(10, '0');

/** Fields every Claude Code row carries, elided from the per-row literals below. */
const envelope = {
  isSidechain: false, userType: 'external' as const,
  cwd: '/Users/chris/Programming/Novakai-Command', sessionId: SESSION,
  version: '2.1.219', gitBranch: 'main',
};

const humanRow = (uuid: string, parentUuid: string | null, text = prompt) => ({
  ...envelope, parentUuid, type: 'user',
  message: { role: 'user', content: text },
  uuid, timestamp: '2026-08-04T04:00:00.000Z',
});

const toolUseRow = (uuid: string, parentUuid: string, toolUseId: string) => ({
  ...envelope, parentUuid, type: 'assistant',
  message: {
    id: 'msg_01ToolUse', type: 'message', role: 'assistant',
    model: 'claude-opus-5', stop_reason: 'tool_use', stop_sequence: null,
    content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/x' } }],
    usage: { input_tokens: 12, output_tokens: 34 },
  },
  uuid, timestamp: '2026-08-04T04:00:01.000Z',
});

/** The row that breaks the pre-fix scan: a tool result recorded with role 'user'. */
const toolResultRow = (uuid: string, parentUuid: string, toolUseId: string) => ({
  ...envelope, parentUuid, type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'file contents' }],
  },
  uuid, timestamp: '2026-08-04T04:00:02.000Z',
  toolUseResult: { type: 'text', file: { filePath: '/x' } },
});

const endTurnRow = (uuid: string, parentUuid: string, text = 'summary', at = '2026-08-04T04:00:03.000Z') => ({
  ...envelope, parentUuid, type: 'assistant',
  message: {
    id: `msg_01End${uuid}`, type: 'message', role: 'assistant',
    model: 'claude-opus-5', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'text', text }],
    usage: { input_tokens: 12, output_tokens: 34 },
  },
  uuid, timestamp: at,
});

/** Claude Code attachment row: has a uuid, has parentUuid null, is not a chain link. */
const attachmentRow = (uuid: string) => ({
  ...envelope, parentUuid: null, type: 'attachment',
  attachment: { type: 'todo', content: [{ content: 'ship the fix', status: 'in_progress' }] },
  uuid, timestamp: '2026-08-04T04:00:01.500Z',
});

const proven = (observation: ProviderTurnBoundaryObservation, label: string) => {
  assert.equal(observation.kind, 'proven',
    `${label}: expected proven, got ${observation.kind}/${'reason' in observation ? observation.reason : ''}`);
  assert.ok(observation.kind === 'proven');
  return observation;
};

// ---------------------------------------------------------------------------
// RED 1 — a tool-using turn is provable at all.
// ---------------------------------------------------------------------------
test('a claude turn that called a tool proves complete at its end_turn row', () => {
  const observation = proven(observe(jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
    endTurnRow('a-2', 'r-1'),
  )), 'tool_result user-role row aborted the completion scan');
  assert.equal(observation.submittedInputSourcePosition, position(0));
  assert.equal(observation.completionSourcePosition, position(3));
  assert.equal(observation.providerCorrelationId, 'u-1');
  assert.equal(observation.completionSourceCommittedAt, '2026-08-04T04:00:03.000Z');
  assert.equal(observation.sourceLineIds.length, 4);
});

test('a claude turn that called many tools in sequence still proves complete', () => {
  const observation = proven(observe(jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
    toolUseRow('a-2', 'r-1', 'toolu_01B'),
    toolResultRow('r-2', 'a-2', 'toolu_01B'),
    toolUseRow('a-3', 'r-2', 'toolu_01C'),
    toolResultRow('r-3', 'a-3', 'toolu_01C'),
    endTurnRow('a-4', 'r-3'),
  )), 'multi-tool turn');
  assert.equal(observation.completionSourcePosition, position(7));
});

// ---------------------------------------------------------------------------
// RED 2 — several end_turn rows in one correlated chain resolve to the last.
// ---------------------------------------------------------------------------
test('a claude turn with several end_turn rows resolves to the last one in the chain', () => {
  const observation = proven(observe(jsonl(
    humanRow('u-1', null),
    endTurnRow('a-1', 'u-1', 'first stop', '2026-08-04T04:00:03.000Z'),
    endTurnRow('a-2', 'a-1', 'second stop', '2026-08-04T04:00:04.000Z'),
  )), 'two end_turn rows before the next human prompt');
  assert.equal(observation.completionSourcePosition, position(2));
  assert.equal(observation.completionSourceCommittedAt, '2026-08-04T04:00:04.000Z');
});

test('the last end_turn row wins even across intervening tool work', () => {
  const observation = proven(observe(jsonl(
    humanRow('u-1', null),
    endTurnRow('a-1', 'u-1', 'first stop', '2026-08-04T04:00:03.000Z'),
    toolUseRow('a-2', 'a-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-2', 'toolu_01A'),
    endTurnRow('a-3', 'r-1', 'final stop', '2026-08-04T04:00:06.000Z'),
  )), 'end_turn, tool work, end_turn');
  assert.equal(observation.completionSourcePosition, position(4));
  assert.equal(observation.completionSourceCommittedAt, '2026-08-04T04:00:06.000Z');
});

// ---------------------------------------------------------------------------
// RED 3 — attachment / non-conversation rows are skipped, not corruption.
// ---------------------------------------------------------------------------
test('a claude attachment row inside the window is skipped, not chain corruption', () => {
  const observation = proven(observe(jsonl(
    humanRow('u-1', null),
    attachmentRow('att-1'),
    endTurnRow('a-1', 'u-1'),
  )), 'attachment row (uuid + parentUuid null) forced end-frame-ambiguous');
  assert.equal(observation.completionSourcePosition, position(2));
  assert.equal(observation.sourceLineIds.length, 2, 'the attachment row is not turn evidence');
});

test('non-conversation claude row types inside the window are skipped', () => {
  const observation = proven(observe(jsonl(
    humanRow('u-1', null),
    { ...envelope, parentUuid: null, type: 'system', subtype: 'hook', uuid: 'sys-1', content: 'hook ran', timestamp: '2026-08-04T04:00:00.500Z' },
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    { type: 'file-history-snapshot', messageId: 'msg-x', uuid: 'snap-1', parentUuid: null, snapshot: {} },
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
    { ...envelope, parentUuid: null, type: 'summary', summary: 'earlier work', uuid: 'sum-1' },
    endTurnRow('a-2', 'r-1'),
  )), 'system/snapshot/summary rows forced end-frame-ambiguous');
  assert.equal(observation.completionSourcePosition, position(6));
  assert.equal(observation.sourceLineIds.length, 4, 'only the four conversation rows are evidence');
});

test('a claude row linked to a skipped attachment row is still linked, not corrupt', () => {
  const observation = proven(observe(jsonl(
    humanRow('u-1', null),
    attachmentRow('att-1'),
    endTurnRow('a-1', 'att-1'),
  )), 'row parented to a skipped attachment row');
  assert.equal(observation.completionSourcePosition, position(2));
});

// ---------------------------------------------------------------------------
// RED 4 — the same input text submitted twice in one session proves both turns.
// ---------------------------------------------------------------------------
test('the same claude input text submitted twice proves both turns by source position', () => {
  const source = jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
    endTurnRow('a-2', 'r-1', 'first answer', '2026-08-04T04:00:03.000Z'),
    humanRow('u-2', 'a-2'),
    endTurnRow('a-3', 'u-2', 'second answer', '2026-08-04T04:00:09.000Z'),
  );

  const first = proven(observe(source), 'first of two identical inputs');
  assert.equal(first.submittedInputSourcePosition, position(0));
  assert.equal(first.completionSourcePosition, position(3));
  assert.equal(first.providerCorrelationId, 'u-1');

  const second = proven(
    observe(source, { startTranscriptWatermark: first.resultingWatermark }),
    'second of two identical inputs',
  );
  assert.equal(second.submittedInputSourcePosition, position(4));
  assert.equal(second.completionSourcePosition, position(5));
  assert.equal(second.providerCorrelationId, 'u-2');
  assert.notEqual(second.framingEvidenceDigest, first.framingEvidenceDigest);
});

// ---------------------------------------------------------------------------
// Honesty guards — the discriminators that must survive the four changes.
// ---------------------------------------------------------------------------
test('a genuine second human prompt still terminates the claude window', () => {
  const observation = observe(jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
    humanRow('u-2', 'r-1', 'stop, do something else'),
    endTurnRow('a-2', 'u-2'),
  ));
  assert.notEqual(observation.kind, 'proven',
    'an end_turn belonging to the NEXT human turn completed this one');
});

test('a genuine second human prompt with array content still terminates the window', () => {
  const observation = observe(jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
    {
      ...envelope, parentUuid: 'r-1', type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'different prompt' }] },
      uuid: 'u-2', timestamp: '2026-08-04T04:00:05.000Z',
    },
    endTurnRow('a-2', 'u-2'),
  ));
  assert.notEqual(observation.kind, 'proven');
});

test('a genuine claude chain break is still end-frame-ambiguous', () => {
  const observation = observe(jsonl(
    humanRow('u-1', null),
    endTurnRow('a-1', 'never-seen-parent'),
  ));
  assert.equal(observation.kind, 'uncertain');
  assert.ok(observation.kind === 'uncertain');
  assert.equal(observation.reason, 'end-frame-ambiguous');
});

test('an unmatched claude tool_result is still a source gap', () => {
  const observation = observe(jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_NEVER_CALLED'),
    endTurnRow('a-2', 'r-1'),
  ));
  assert.equal(observation.kind, 'uncertain');
  assert.ok(observation.kind === 'uncertain');
  assert.equal(observation.reason, 'source-gap');
});

test('an unparsable claude row is still a source gap', () => {
  const observation = observe([
    JSON.stringify(humanRow('u-1', null)), '{not-json',
    JSON.stringify(endTurnRow('a-1', 'u-1')),
  ].join('\n'));
  assert.equal(observation.kind, 'uncertain');
  assert.ok(observation.kind === 'uncertain');
  assert.equal(observation.reason, 'source-gap');
});

test('a claude turn with no terminal row is unavailable, not proven', () => {
  const observation = observe(jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
  ));
  assert.equal(observation.kind, 'unavailable');
});

test('a claude turn in another native session is never proven', () => {
  const observation = observe(jsonl(
    humanRow('u-1', null),
    endTurnRow('a-1', 'u-1'),
  ), { providerNativeSessionId: 'a-different-native-session' });
  assert.equal(observation.kind, 'unavailable');
});

test('a tool_result row is never mistaken for the submitted input frame', () => {
  const observation = observe(jsonl(
    humanRow('u-1', null),
    toolUseRow('a-1', 'u-1', 'toolu_01A'),
    toolResultRow('r-1', 'a-1', 'toolu_01A'),
    endTurnRow('a-2', 'r-1'),
  ), { inputDigest: digestOf('') });
  assert.notEqual(observation.kind, 'proven');
});
