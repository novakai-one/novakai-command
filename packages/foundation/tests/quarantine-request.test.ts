import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  getObject,
  isAbsent,
  requestQuarantine,
  type ClientOpId,
} from '../contract/index.js';

test('Foundation requestQuarantine is scoped, stamped, and idempotent', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-quarantine-request-'));
  const root = path.join(workspace, '.novakai');
  const target = {
    kind: 'transcriptLine',
    id: `transcriptLine_${'a'.repeat(64)}`,
  };
  const clientOpId = 'op_transcript_quarantine_fixture' as ClientOpId;

  try {
    const transcriptHandle = composeHandle({
      root,
      capability: 'transcript',
      allowedKinds: ['transcriptLine'],
      principal: 'sys_ingester',
    });
    const first = await requestQuarantine(transcriptHandle, {
      target,
      clientOpId,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.value.outcome, 'created');
    // Q10: Foundation is the writer; the requester moved to `requestedBy`.
    assert.equal(first.value.tombstone.createdBy, 'sys_foundation');
    assert.equal(first.value.tombstone.requestedBy?.principalId, 'sys_ingester');
    assert.deepEqual(first.value.tombstone.quarantinedRef, target);
    assert.equal(first.value.tombstone.reason, 'corrupt_record');

    const retry = await requestQuarantine(transcriptHandle, {
      target,
      clientOpId,
    });
    assert.equal(retry.ok, true);
    assert.equal(
      retry.ok ? retry.value.outcome : null,
      'already_requested',
    );
    assert.equal(
      retry.ok ? retry.value.tombstone.id : null,
      first.value.tombstone.id,
    );

    const stored = await getObject(
      transcriptHandle,
      'quarantine',
      first.value.tombstone.id as never,
    );
    assert.equal(stored.ok, true);
    assert.equal(
      stored.ok && !isAbsent(stored.value)
        ? stored.value.object.createdBy
        : null,
      'sys_foundation',
    );

    const wrongScope = composeHandle({
      root,
      capability: 'transcript',
      allowedKinds: ['transcriptJournal'],
      principal: 'sys_ingester',
    });
    const denied = await requestQuarantine(wrongScope, {
      target,
      clientOpId: 'op_wrong_scope_fixture' as ClientOpId,
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.ok ? null : denied.error.code, 'ScopeViolation');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
