// B3a — command receipt / idempotency proof (B3V4-P2 §4.5, DEC-B3V4-30).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  canonicalJson, commandReceiptId, composeReceiptStore, isValidId, mintClientOpId,
  b3err, b3fail, b3ok, mintTraceCorrelationId,
  type CommandContext, type PublicOperationName, type ReceiptStore,
} from '../contract/index.js';

function ctxFor(clientOpId = mintClientOpId()): CommandContext {
  return {
    principal: { id: 'sys_terminal', kind: 'system', verifiedScopes: [] },
    clientOpId,
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

const OPEN = 'terminal.openManagedTerminal' as PublicOperationName;

function freshStore(): { store: ReceiptStore; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-receipt-'));
  return { store: composeReceiptStore({ root }), root };
}

test('the receipt id is deterministic from {principal, operation, clientOpId}', () => {
  const clientOpId = mintClientOpId();
  const a = commandReceiptId('sys_terminal', OPEN, clientOpId);
  const b = commandReceiptId('sys_terminal', OPEN, clientOpId);
  assert.equal(a, b);
  assert.notEqual(a, commandReceiptId('sys_shell', OPEN, clientOpId));
  assert.notEqual(a, commandReceiptId('sys_terminal', 'terminal.write' as PublicOperationName, clientOpId));
  assert.equal(isValidId(a, 'receipt', 'base32sha256'), true);
  // A well-formed body under the wrong prefix is still invalid (red gate 3).
  assert.equal(isValidId(a.replace('receipt_', 'runOperation_'), 'receipt', 'base32sha256'), false);
});

test('canonical JSON ignores key order so an identical request hashes identically', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 4, c: [3, { f: 6, e: 5 }] } }),
    canonicalJson({ a: { c: [3, { e: 5, f: 6 }], d: 4 }, b: 1 }),
  );
  // ...and an absent field is not the same request as a present one.
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 1, b: null }));
});

test('same key + same request returns the stored outcome without re-running', async () => {
  const { store, root } = freshStore();
  try {
    const ctx = ctxFor();
    let runs = 0;
    const request = { terminalSessionId: 'terminal_x', columns: 80 };
    const execute = async () => { runs += 1; return b3ok({ sequence: runs }); };

    const first = await store.runCommand(ctx, { operation: OPEN, request, replaySafe: false }, execute);
    const second = await store.runCommand(ctx, { operation: OPEN, request, replaySafe: false }, execute);

    assert.equal(runs, 1, 'the command ran twice');
    assert.deepEqual(first, second);
    assert.equal(first.ok && (first.value as { sequence: number }).sequence, 1);

    const stored = await store.readReceipt(commandReceiptId(ctx.principal.id, OPEN, ctx.clientOpId));
    assert.equal(stored?.state, 'succeeded');
    assert.equal(stored?.outcome?.succeeded, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('same key + a DIFFERENT request is IdempotencyConflict, never a second run', async () => {
  const { store, root } = freshStore();
  try {
    const ctx = ctxFor();
    let runs = 0;
    const execute = async () => { runs += 1; return b3ok({ ok: true }); };

    await store.runCommand(ctx, { operation: OPEN, request: { columns: 80 }, replaySafe: false }, execute);
    const clash = await store.runCommand(ctx, { operation: OPEN, request: { columns: 120 }, replaySafe: false }, execute);

    assert.equal(runs, 1);
    assert.equal(clash.ok, false);
    if (clash.ok) return;
    assert.equal(clash.error.code, 'IdempotencyConflict');
    assert.equal(clash.error.retryable, false);
    const details = clash.error.details as { originalHash: string; receivedHash: string };
    assert.notEqual(details.originalHash, details.receivedHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a recorded failure replays as the same failure', async () => {
  const { store, root } = freshStore();
  try {
    const ctx = ctxFor();
    let runs = 0;
    const execute = async () => {
      runs += 1;
      return b3fail(b3err('TerminalNotLive', 'gone', { terminalSessionId: 'terminal_x', status: 'exited' }, false));
    };
    const first = await store.runCommand(ctx, { operation: OPEN, request: {}, replaySafe: false }, execute);
    const second = await store.runCommand(ctx, { operation: OPEN, request: {}, replaySafe: false }, execute);
    assert.equal(runs, 1);
    assert.equal(first.ok, false);
    assert.deepEqual(first, second);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted non-replay-safe command reports RecoveryRequired, not a repeat', async () => {
  const { store, root } = freshStore();
  try {
    const ctx = ctxFor();
    // Simulate a crash between "receipt opened" and "outcome settled": the
    // command throws, so settle() never runs and the receipt stays `running`.
    await assert.rejects(store.runCommand(ctx, { operation: OPEN, request: {}, replaySafe: false }, async () => {
      throw new Error('process died mid-effect');
    }));

    let reran = false;
    const retry = await store.runCommand(ctx, { operation: OPEN, request: {}, replaySafe: false }, async () => {
      reran = true;
      return b3ok({});
    });
    assert.equal(reran, false, 'an uncertain PTY/provider effect was repeated');
    assert.equal(retry.ok, false);
    if (retry.ok) return;
    assert.equal(retry.error.code, 'RecoveryRequired');
    assert.equal((retry.error.details as { stage: string }).stage, 'running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an interrupted replay-safe command re-runs instead of blocking', async () => {
  const { store, root } = freshStore();
  try {
    const ctx = ctxFor();
    await assert.rejects(store.runCommand(ctx, { operation: OPEN, request: {}, replaySafe: true }, async () => {
      throw new Error('crash before settle');
    }));
    const retry = await store.runCommand(ctx, { operation: OPEN, request: {}, replaySafe: true }, async () => b3ok({ resumed: true }));
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.deepEqual(retry.value, { resumed: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
