/**
 * Q10 — who WRITES a requested quarantine tombstone, and who ASKED for it.
 *
 * §8's grant law: Transcript is never granted quarantine write scope — it
 * REQUESTS, Foundation CONSTRUCTS. `createdBy` records the authoritative
 * writer, so a tombstone reached through `requestQuarantine` is Foundation's;
 * the requester is a separate fact and losing it would lose causal audit truth.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, getObject, isAbsent, requestQuarantine,
  type ClientOpId,
} from '../contract/index.js';

const targetOf = (letter: string) => ({
  kind: 'transcriptLine',
  id: `transcriptLine_${letter.repeat(64)}`,
});

test('a requested tombstone is written by Foundation and names its requester', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-q10-'));
  const root = path.join(workspace, '.novakai');
  const target = targetOf('b');
  const clientOpId = 'op_q10_transcript_request' as ClientOpId;
  const traceId = 'trace_00000000-0000-4000-8000-0000000000q1';

  try {
    const transcript = composeHandle({
      root,
      capability: 'transcript',
      allowedKinds: ['transcriptLine'],
      principal: 'sys_transcript',
    });

    const requested = await requestQuarantine(transcript, {
      target, clientOpId, traceId,
    });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;

    // The writer. `sys_transcript` here would grant Transcript a write it does
    // not hold, which is the §8 boundary this ruling exists to restate.
    assert.equal(requested.value.tombstone.createdBy, 'sys_foundation');

    // The requester, in full — and derived, never accepted from the caller's
    // payload: the capability and principal come off the scoped handle.
    assert.deepEqual(requested.value.tombstone.requestedBy, {
      capability: 'transcript',
      principalId: 'sys_transcript',
      clientOpId,
      traceId,
    });

    // The same two facts survive the durable round trip.
    const stored = await getObject(
      transcript, 'quarantine', requested.value.tombstone.id as never,
    );
    assert.equal(stored.ok && !isAbsent(stored.value), true);
    if (!stored.ok || isAbsent(stored.value)) return;
    const durable = stored.value.object as Record<string, unknown>;
    assert.equal(durable['createdBy'], 'sys_foundation');
    assert.deepEqual(durable['requestedBy'], {
      capability: 'transcript',
      principalId: 'sys_transcript',
      clientOpId,
      traceId,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('the lifecycle trace of a requested quarantine names Foundation too', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-q10-trace-'));
  const root = path.join(workspace, '.novakai');
  const clientOpId = 'op_q10_trace_attribution' as ClientOpId;

  try {
    const transcript = composeHandle({
      root,
      capability: 'transcript',
      allowedKinds: ['transcriptLine'],
      principal: 'sys_transcript',
    });
    const requested = await requestQuarantine(transcript, {
      target: targetOf('f'), clientOpId,
    });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;

    const traces = readFileSync(path.join(root, 'traces.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line['action'] === 'quarantine');
    assert.equal(traces.length, 1);

    // One write, one writer. The trace records the mutation Foundation
    // PERFORMED; saying `sys_transcript` attributes to Transcript a
    // quarantine write §8 never grants it — the same collapse of writer and
    // requester Q10 removes from the tombstone, in the journal of that same
    // operation.
    assert.equal(traces[0]?.['createdBy'], 'sys_foundation');

    // The requester is not lost: the trace and the tombstone's provenance
    // carry the same clientOpId, so the two join without ambiguity.
    assert.equal(traces[0]?.['clientOpId'], clientOpId);
    assert.equal(requested.value.tombstone.requestedBy?.clientOpId, clientOpId);
    assert.equal(requested.value.tombstone.requestedBy?.principalId, 'sys_transcript');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a requester with no trace correlation still gets complete provenance', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-q10-notrace-'));
  const root = path.join(workspace, '.novakai');

  try {
    const transcript = composeHandle({
      root,
      capability: 'transcript',
      allowedKinds: ['transcriptLine'],
      principal: 'sys_transcript',
    });
    const requested = await requestQuarantine(transcript, {
      target: targetOf('c'),
      clientOpId: 'op_q10_no_trace' as ClientOpId,
    });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;

    // `requestedBy` is REQUIRED on every new request-path write. A caller
    // without a command context does not get to omit it — Foundation mints the
    // correlation itself rather than writing a half-provenance.
    const provenance = requested.value.tombstone.requestedBy;
    assert.notEqual(provenance, undefined);
    assert.equal(provenance?.capability, 'transcript');
    assert.equal(provenance?.principalId, 'sys_transcript');
    assert.match(String(provenance?.traceId), /^trace_/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('a tombstone written before Q10 still parses, and is not back-filled', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-q10-legacy-'));
  const root = path.join(workspace, '.novakai');

  try {
    const { QuarantineTombstone } = await import('../contract/schemas.js');
    // Byte-for-byte the shape B3c wrote before this ruling: no `requestedBy`.
    const legacy = QuarantineTombstone.safeParse({
      kind: 'quarantine',
      id: `quarantine_${'d'.repeat(64)}`,
      schemaVersion: 1,
      createdAt: '2026-08-02T18:47:10.412Z',
      permissionLevel: 'private',
      createdBy: 'sys_transcript',
      quarantinedRef: targetOf('e'),
      reason: 'corrupt_record',
      status: 'open',
    });
    assert.equal(legacy.success, true);
    // Absence means `legacy-requester-unknown`, and MUST NOT be inferred from
    // `createdBy` — so nothing invents one on read.
    assert.equal(legacy.success ? legacy.data.requestedBy : 'parsed', undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
