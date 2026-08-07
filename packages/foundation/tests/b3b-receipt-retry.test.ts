// A receipt that recorded a RETRYABLE failure must not replay it forever.
//
// §11: "`retryable: true` means the SAME request and the SAME ClientOpId may be
// retried safely." A receipt that answers a retry with the stored failure makes
// that promise unkeepable — the caller does exactly what it was told to do and
// gets the same stale answer, permanently.
//
// Found by B3b's crash matrix: every crashed spawn returned `StoreUnavailable`,
// the retry replayed it, and nothing was ever recovered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3err, b3fail, b3ok, composeReceiptStore, mintClientOpId, mintTraceCorrelationId,
  type CommandContext, type PublicOperationName,
} from '../contract/index.js';

function contextFor(root: string): CommandContext {
  void root;
  return {
    principal: { id: 'person_chris' as never, kind: 'human', verifiedScopes: [] },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

const descriptor = {
  operation: 'test.operation' as PublicOperationName,
  request: { thing: 1 },
  replaySafe: true,
};

test('a stored RETRYABLE failure is re-executed, not replayed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-receipt-retry-'));
  try {
    const receipts = composeReceiptStore({ root });
    const context = contextFor(root);
    let attempts = 0;

    const first = await receipts.runCommand(context, descriptor, async () => {
      attempts += 1;
      return b3fail(b3err('StoreUnavailable', 'the process died mid-operation',
        { owner: 'agent-runtime', cause: 'crash' }, true));
    });
    assert.equal(first.ok, false);
    assert.equal(attempts, 1);

    // The caller was told it may retry. It retries.
    const second = await receipts.runCommand(context, descriptor, async () => {
      attempts += 1;
      return b3ok({ recovered: true });
    });
    assert.equal(attempts, 2, 'the retry replayed a stale failure instead of running');
    assert.equal(second.ok, true, 'a retryable failure was replayed forever');
    if (second.ok) assert.deepEqual(second.value, { recovered: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stored NON-retryable failure is still replayed', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-receipt-final-'));
  try {
    const receipts = composeReceiptStore({ root });
    const context = contextFor(root);
    let attempts = 0;

    const first = await receipts.runCommand(context, descriptor, async () => {
      attempts += 1;
      return b3fail(b3err('PermissionDenied', 'you may not',
        { operation: 'test.operation' }, false));
    });
    assert.equal(first.ok, false);

    // A settled refusal is a settled refusal. Re-running it would let a caller
    // retry its way past a denial by asking again with the same id.
    const second = await receipts.runCommand(context, descriptor, async () => {
      attempts += 1;
      return b3ok({ shouldNotHappen: true });
    });
    assert.equal(attempts, 1, 'a final refusal was re-executed');
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, 'PermissionDenied');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a succeeded receipt still replays its value rather than re-running', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-receipt-success-'));
  try {
    const receipts = composeReceiptStore({ root });
    const context = contextFor(root);
    let attempts = 0;

    await receipts.runCommand(context, descriptor, async () => {
      attempts += 1;
      return b3ok({ done: attempts });
    });
    const again = await receipts.runCommand(context, descriptor, async () => {
      attempts += 1;
      return b3ok({ done: attempts });
    });
    assert.equal(attempts, 1, 'a completed command ran twice');
    assert.equal(again.ok, true);
    if (again.ok) assert.deepEqual(again.value, { done: 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
