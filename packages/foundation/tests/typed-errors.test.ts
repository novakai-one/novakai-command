// M4 — the typed-error law: failures across contract seams are typed Result
// values, never raw throws a consumer must catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeHandle, createObject, updateObject, mintClientOpId, type ObjectId } from '../contract/index.js';

const freshRoot = () => mkdtempSync(path.join(tmpdir(), 'nvk-fnd-typed-'));

const payload = (id: string) => ({
  kind: 'settings', id, schemaVersion: 1, createdAt: new Date().toISOString(),
  permissionLevel: 'private', createdBy: 'person_chris', key: id, value: 1,
});

test('M4: object-append failure inside appendMutation → typed ObjectWriteFailed, never a raw throw', async () => {
  const root = freshRoot();
  try {
    const h = composeHandle({
      root, capability: 'shell', allowedKinds: ['settings'],
      principal: 'person_chris', failNextObjectAppend: { cause: 'ENOSPC: no space left on device' },
    });
    const res = await createObject(h, payload('settings_disk'), mintClientOpId());
    assert.equal(res.ok, false, 'must return a typed Result, not reject');
    if (!res.ok) {
      assert.equal(res.error.code, 'ObjectWriteFailed');
      assert.equal(res.error.retryable, true);
      assert.match(res.error.details.cause, /ENOSPC/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M4: updateObject surfaces the same typed ObjectWriteFailed', async () => {
  const root = freshRoot();
  try {
    const setup = composeHandle({ root, capability: 'shell', allowedKinds: ['settings'], principal: 'person_chris' });
    const created = await createObject(setup, payload('settings_upd'), mintClientOpId());
    assert.equal(created.ok, true);
    const h = composeHandle({
      root, capability: 'shell', allowedKinds: ['settings'],
      principal: 'person_chris', failNextObjectAppend: { cause: 'EIO: i/o error' },
    });
    const res = await updateObject(h, 'settings_upd' as ObjectId, { value: 2 }, 1, mintClientOpId());
    assert.equal(res.ok, false, 'must return a typed Result, not reject');
    if (!res.ok) assert.equal(res.error.code, 'ObjectWriteFailed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
