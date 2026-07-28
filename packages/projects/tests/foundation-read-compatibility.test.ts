import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as foundation from '@novakai/foundation/dist/contract/index.js';
import { composeProjects } from '../contract/index.js';

test('legacy Foundation reads stay infallible while Projects opts into typed read failures', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-read-compat-'));
  try {
    const lockDir = path.join(root, 'lock');
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'read-compat-holder' })}\n`,
    );
    const handle = foundation.composeHandle({
      root,
      capability: 'projects',
      allowedKinds: ['project', 'projectItem'],
      principal: 'person_reader',
      lockTimeoutMs: 50,
    });

    const legacyGet = await foundation.getObject(
      handle,
      'project',
      'proj_unreadable' as never,
    );
    assert.equal(legacyGet.ok, true);
    assert.equal(
      legacyGet.ok && foundation.isAbsent(legacyGet.value),
      true,
    );
    const legacyResolve = await foundation.resolveRef(handle, {
      kind: 'project',
      id: 'proj_unreadable',
    });
    assert.equal(legacyResolve.ok, true);
    assert.equal(
      legacyResolve.ok && foundation.isAbsent(legacyResolve.value),
      true,
    );

    const failureAwareQuery = (
      foundation as unknown as Record<string, unknown>
    ).getObjectWithReadFailure;
    assert.equal(typeof failureAwareQuery, 'function');
    const checked = await (failureAwareQuery as (
      ...args: Parameters<typeof foundation.getObject>
    ) => Promise<
      | { ok: true; value: unknown }
      | { ok: false; error: { code: string } }
    >)(
      handle,
      'project',
      'proj_unreadable' as never,
    );
    assert.equal(checked.ok, false);
    assert.equal(checked.ok ? null : checked.error.code, 'LockBusy');

    const projects = composeProjects({
      root,
      principal: 'person_reader',
      lockTimeoutMs: 50,
    }).operations;
    const items = await projects.getProjectItems('proj_unreadable' as never);
    assert.equal(items.ok, false);
    assert.equal(items.ok ? null : items.error.code, 'LockBusy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
