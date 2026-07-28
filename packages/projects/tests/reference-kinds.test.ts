import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  composeHandle,
  createObject,
  mintClientOpId,
  RegisteredObjectKind,
} from '@novakai/foundation/dist/contract/index.js';
import { composeProjects } from '../contract/index.js';

test('message is a registered reference kind without becoming Foundation-writable', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'nvk-message-ref-kind-'));
  const root = path.join(workspace, '.novakai');
  try {
    assert.equal(RegisteredObjectKind.safeParse('message').success, true);

    const illicitWriter = composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      capability: 'foundation',
      allowedKinds: ['message' as never],
      principal: 'person_chris',
    });
    const write = await createObject(illicitWriter, {
      kind: 'message',
      id: 'message_illicit',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team',
      createdBy: 'person_chris',
    }, mintClientOpId());
    assert.equal(write.ok, false);
    assert.equal(write.ok ? null : write.error.code, 'KindUnknown');

    const projects = composeProjects({
      root,
      principal: 'sys_spine',
    });
    const project = await projects.operations.createProject(
      { title: 'Message references' },
      mintClientOpId(),
    );
    assert.equal(project.ok, true);
    if (!project.ok) return;

    const attached = await projects.spine.attach(
      project.value.id,
      {
        itemRef: {
          kind: 'message',
          id: 'message_intentionally_dangling',
        },
      },
      mintClientOpId(),
    );
    assert.equal(attached.ok, true);
    assert.equal(existsSync(path.join(root, 'stores', 'messages.jsonl')), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
