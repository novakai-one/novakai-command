// B3a — Foundation public-view amendment (B3V4-P2 §4.3, AMD-001 §4).
//
// Why this exists: a capability adapter must never cast a ServerOpId into a
// TraceId, invent an update time, or throw away operation IDs Foundation
// already knows. The discriminated union makes each of those a type error.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, createObject, getObject, mintClientOpId, queryTraceBound,
  type ObjectId, type ScopedStoreHandle,
} from '../contract/index.js';
import { composeEngine } from '../contract/compose.js';

function terminalHandle(root: string): ScopedStoreHandle {
  return composeHandle({
    root, capability: 'terminal', allowedKinds: ['terminalSession'],
    principal: 'sys_terminal',
  });
}

function sessionPayload(id: string): Record<string, unknown> {
  return {
    kind: 'terminalSession', id, schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: 'private', createdBy: 'caller_is_not_trusted',
    status: 'live',
  };
}

test('a complete mutation reports trace-complete with a real TraceId', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-prov-complete-'));
  try {
    const handle = terminalHandle(root);
    const clientOpId = mintClientOpId();
    const created = await createObject(handle, sessionPayload('terminal_complete'), clientOpId);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const provenance = created.value.lastMutation;
    assert.equal(provenance.state, 'trace-complete');
    if (provenance.state !== 'trace-complete') return;
    assert.equal(provenance.clientOpId, clientOpId);
    assert.match(provenance.serverOpId, /^srv_/);
    // The TraceId is the trace LINE's own id — never the mutation's opId.
    assert.match(provenance.traceId, /^trace_/);
    assert.notEqual(String(provenance.traceId), String(provenance.serverOpId));

    const traces = await queryTraceBound(composeEngine({
      root, capability: 'terminal', allowedKinds: ['terminalSession'],
      principal: 'sys_terminal',
    }), { clientOpId });
    assert.equal(traces.items.length, 1);
    assert.equal(provenance.traceId, traces.items[0]!.id);
    assert.equal(provenance.committedAt, traces.items[0]!.createdAt);
    assert.equal(created.value.incomplete, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an object whose trace append failed keeps the operation IDs Foundation knows', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-prov-incomplete-'));
  try {
    const handle = composeHandle({
      root, capability: 'terminal', allowedKinds: ['terminalSession'],
      principal: 'sys_terminal',
      failNextTraceAppend: { cause: 'injected' },
    });
    const clientOpId = mintClientOpId();
    // The mutation itself reports TraceIncomplete (existing R3-10 behaviour);
    // the object stays readable, and the READ is where provenance is claimed.
    const created = await createObject(handle, sessionPayload('terminal_incomplete'), clientOpId);
    assert.equal(created.ok, false);
    if (created.ok) return;
    assert.equal(created.error.code, 'TraceIncomplete');

    const read = await getObject(
      terminalHandle(root), 'terminalSession', 'terminal_incomplete' as ObjectId,
    );
    assert.equal(read.ok, true);
    if (!read.ok || 'absent' in read.value) assert.fail('incomplete object must stay readable');

    assert.equal(read.value.incomplete, true);
    const provenance = read.value.lastMutation;
    assert.equal(provenance.state, 'object-appended-trace-missing');
    if (provenance.state !== 'object-appended-trace-missing') return;
    // The whole point of the amendment: these are NOT discarded.
    assert.equal(provenance.clientOpId, clientOpId);
    assert.match(provenance.serverOpId, /^srv_/);
    assert.equal(provenance.traceId, undefined);
    assert.equal(provenance.committedAt, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a true legacy flat record reports legacy-no-trace and stays not-incomplete', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-prov-legacy-'));
  try {
    // A pre-wrapper flat line: no {envelope,payload,meta}, so no operation IDs
    // ever existed. Absence here is a different fact from a lost trace.
    writeFileSync(path.join(root, 'terminalSessions.jsonl'), '');
    appendFileSync(path.join(root, 'terminalSessions.jsonl'),
      `${JSON.stringify(sessionPayload('terminal_legacy'))}\n`);

    const read = await getObject(
      terminalHandle(root), 'terminalSession', 'terminal_legacy' as ObjectId,
    );
    assert.equal(read.ok, true);
    if (!read.ok || 'absent' in read.value) {
      assert.fail('legacy flat record was not readable');
    }
    assert.equal(read.value.incomplete, false);
    assert.equal(read.value.lastMutation.state, 'legacy-no-trace');
    assert.equal('serverOpId' in read.value.lastMutation, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
