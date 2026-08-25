// The cutover as a BOOT GATE — §18.1, §20, §25-B3c, AMD-001 A-01.
//
// The helper shipped tested and unreachable. Neither `startRuntimeHost` nor
// `composeB3Runtime` called `checkMessagingStoreRoute` or `runMessagingCutover`,
// so canonical dispatch could open and write beside a legacy journal — which is
// the exact two-writers-one-invisible case §18.1's conflict rule exists to
// prevent. The only CLI reference was a read-only doctor pointed at a filename
// the product never writes (`messaging-store.jsonl`; the real legacy route is
// `messaging.jsonl`, `packages/server/core/boot.ts:146`).
//
// Everything here drives BOOT. Nothing calls the helper directly: a gate that
// is only reachable from its own unit test is not a gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import { LEGACY_MESSAGING_STORE } from '../../core/store-route-report.js';

/** One legacy `store-jsonl` line: a bare StoreOp, the historic acceptance shape. */
function legacyAcceptance(ordinal: number): string {
  const messageId = `message_${String(ordinal).padStart(32, '0')}`;
  return JSON.stringify({
    op: 'acceptance',
    thread: {
      id: 'thread_legacy0000000000000000000000', kind: 'thread', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', threadKind: 'room',
      room: { authority: 'legacy', externalId: 'room-1' },
    },
    acceptance: {
      id: `acceptance_${String(ordinal)}`, kind: 'acceptance', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      senderId: 'person_chris',
      clientMessageId: `cmid-${String(ordinal)}`,
      requestHash: `hash-${String(ordinal)}`,
      messageId,
    },
    message: {
      id: messageId, kind: 'message', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      threadId: 'thread_legacy0000000000000000000000',
      senderId: 'person_chris',
      clientMessageId: `cmid-${String(ordinal)}`,
      sequence: ordinal, priority: 'normal', body: { text: `legacy ${String(ordinal)}` },
    },
    snapshot: {
      id: `snapshot_${String(ordinal)}`, kind: 'recipient-snapshot', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', messageId, recipients: ['person_other'],
    },
    deliveries: [{
      id: `delivery_${String(ordinal)}`, kind: 'delivery', schemaVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      messageId, threadId: 'thread_legacy0000000000000000000000',
      recipientId: 'person_other', state: 'pending',
    }],
    // The historic SINGLETON journal shape, which §8.1 says must be accepted
    // and canonically normalised rather than rejected.
    journal: {
      sequence: ordinal, kind: 'accepted', messageId,
      at: '2026-01-01T00:00:00.000Z',
    },
  });
}

function legacyFile(root: string, lines: readonly string[]): string {
  const file = path.join(root, LEGACY_MESSAGING_STORE);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

const boot = async (root: string): ReturnType<typeof startRuntimeHost> =>
  startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });

test('boot MIGRATES a legacy Messaging journal and records the receipt', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-cutover-'));
  try {
    const legacy = legacyFile(root, [legacyAcceptance(1), legacyAcceptance(2)]);
    const legacyBefore = readFileSync(legacy, 'utf8');

    const host = await boot(root);
    await host.close();

    // The canonical journal now holds both operations...
    const canonical = path.join(root, 'stores', 'messagingStoreOps.jsonl');
    const lines = readFileSync(canonical, 'utf8').split('\n').filter((line) => line !== '');
    assert.equal(lines.length >= 2, true,
      `boot left ${String(lines.length)} canonical lines; the legacy journal had 2`);

    // ...and the receipt says so, durably.
    const receipts = readFileSync(
      path.join(root, 'stores', 'storeRouteCutovers.jsonl'), 'utf8',
    ).split('\n').filter((line) => line !== '');
    assert.equal(receipts.length >= 1, true, 'boot migrated with no cutover receipt');
    const receipt = JSON.parse(receipts[receipts.length - 1]!) as {
      payload: { sourceLineCount: number; replayEqual: boolean; traceComplete: boolean };
    };
    assert.equal(receipt.payload.sourceLineCount, 2);
    assert.equal(receipt.payload.replayEqual, true);
    assert.equal(receipt.payload.traceComplete, true,
      'the PERSISTED receipt still says traceComplete: false — dispatch waits on '
      + 'this value, so an in-memory true is a claim nothing can check after restart');

    // §27: the provider's own evidence is never touched.
    assert.equal(readFileSync(legacy, 'utf8'), legacyBefore,
      'the legacy journal was modified; it is read-only evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('boot BLOCKS on a route conflict, and writes neither file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-conflict-'));
  try {
    const legacy = legacyFile(root, [legacyAcceptance(1)]);
    // A canonical journal that exists with no receipt: two routes, one of them
    // invisible. §18.1 makes this a hard block, not a preference.
    mkdirSync(path.join(root, 'stores'), { recursive: true });
    const canonical = path.join(root, 'stores', 'messagingStoreOps.jsonl');
    writeFileSync(canonical, '', 'utf8');

    const legacyBefore = statSync(legacy);
    const canonicalBefore = statSync(canonical);

    let blocked: Error | null = null;
    try {
      const host = await boot(root);
      await host.close();
    } catch (cause) {
      blocked = cause as Error;
    }
    assert.notEqual(blocked, null,
      'boot came up beside a legacy journal with no cutover receipt');
    assert.equal(blocked?.message.includes('StoreRouteConflict'), true,
      `boot failed with "${blocked?.message ?? ''}" rather than a typed StoreRouteConflict`);

    assert.equal(statSync(legacy).size, legacyBefore.size, 'the legacy file was written');
    assert.equal(statSync(canonical).size, canonicalBefore.size,
      'the canonical file was written while the route was in conflict');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the second boot is a no-op: the receipt makes the route clear', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-idempotent-'));
  try {
    legacyFile(root, [legacyAcceptance(1)]);
    const first = await boot(root);
    await first.close();
    const canonical = path.join(root, 'stores', 'messagingStoreOps.jsonl');
    const afterFirst = readFileSync(canonical, 'utf8');

    const second = await boot(root);
    await second.close();
    assert.equal(readFileSync(canonical, 'utf8'), afterFirst,
      'the second boot migrated the same legacy journal again');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the doctor looks at the file the product actually writes', async () => {
  // Exam J3/J4/J6 failed on exactly this: the doctor reported `clear` because
  // it was looking for `messaging-store.jsonl` while the product writes
  // `messaging.jsonl` (packages/server/core/boot.ts:146).
  assert.equal(LEGACY_MESSAGING_STORE, 'messaging.jsonl');

  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-doctor-'));
  try {
    legacyFile(root, [legacyAcceptance(1)]);
  const { buildCutoverReport } = await import('../../core/store-route-report.js');
    const report = await buildCutoverReport({
      root,
      dataRoot: path.join(root, 'stores'),
      legacySources: { messagingStoreOp: path.join(root, LEGACY_MESSAGING_STORE) },
    });
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.equal(report.value.verdict, 'cutover-required',
      'a legacy journal sitting there unmigrated reported as clear');
    assert.equal(report.value.perKind[0]?.legacyExists, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
