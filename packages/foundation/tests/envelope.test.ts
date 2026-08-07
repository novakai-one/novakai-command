// FND-001: every persisted object carries the full envelope; create missing any
// of the 6 required fields → InvalidEnvelope naming the missing fields.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle, createObject, mintClientOpId,
} from '../contract/index.js';

function freshRoot(): string {
  return mkdtempSync(path.join(tmpdir(), 'nvk-fnd-'));
}

const handle = (root: string) => composeHandle({
  root,
  capability: 'shell',
  allowedKinds: ['settings'],
  principal: 'person_test',
});

const validSettings = () => ({
  kind: 'settings',
  id: 'settings_theme',
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  permissionLevel: 'private',
  createdBy: 'caller_claimed_anyone', // must be overridden by system-derived principal
  key: 'theme',
  value: 'dark',
});

test('createObject accepts a full enveloped object and stamps system-derived createdBy', async () => {
  const root = freshRoot();
  try {
    const h = handle(root);
    const res = await createObject(h, validSettings(), mintClientOpId());
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.object.key, 'theme');
      assert.equal(res.value.object.createdBy, 'person_test'); // red gate 4: caller value overridden
      assert.equal(res.value.version, 1);
      assert.equal(res.value.incomplete, false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const field of ['kind', 'id', 'schemaVersion', 'createdAt', 'permissionLevel', 'createdBy']) {
  test(`createObject missing required envelope field ${field} → InvalidEnvelope naming it`, async () => {
    const root = freshRoot();
    try {
      const h = handle(root);
      const payload = validSettings() as Record<string, unknown>;
      delete payload[field];
      const res = await createObject(h, payload, mintClientOpId());
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.equal(res.error.code, 'InvalidEnvelope');
        const missing = (res.error.details as { missingFields: string[] }).missingFields;
        assert.ok(missing.includes(field), `missingFields should name ${field}, got ${JSON.stringify(missing)}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
