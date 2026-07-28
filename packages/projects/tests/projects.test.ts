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
import {
  composeHandle,
  createObject,
  mintClientOpId,
  queryTraceBound,
} from '@novakai/foundation/dist/contract/index.js';
import { composeEngine } from '@novakai/foundation/dist/contract/compose.js';
import {
  composeProjects,
  createProjectsContract,
  createSpineProjectsContract,
} from '../contract/index.js';

const freshRoot = () => mkdtempSync(path.join(tmpdir(), 'nvk-projects-'));

test('createProject requires clientOpId and replays one traced result', async () => {
  const root = freshRoot();
  try {
    const projects = createProjectsContract(composeProjects({
      root,
      principal: 'person_chris',
    }));
    const missingOp = await projects.createProject(
      { title: 'Missing op' },
      undefined as never,
    );
    assert.equal(missingOp.ok, false);
    assert.equal(missingOp.ok ? null : missingOp.error.code, 'InvalidEnvelope');

    const clientOpId = mintClientOpId();
    const first = await projects.createProject({ title: 'Novakai Command' }, clientOpId);
    const retry = await projects.createProject({ title: 'Novakai Command' }, clientOpId);
    assert.equal(first.ok && retry.ok, true);
    if (!first.ok || !retry.ok) return;
    assert.match(first.value.id, /^proj_/);
    assert.equal(first.value.status, 'active');
    assert.equal(retry.value.id, first.value.id);

    const engine = composeEngine({
      root,
      capability: 'projects',
      allowedKinds: ['project', 'projectItem'],
      principal: 'person_chris',
    });
    const trace = await queryTraceBound(engine, { clientOpId });
    assert.equal(trace.items.length, 1);
    assert.equal(trace.items[0]?.target.id, first.value.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listProjects returns created Projects filtered by lifecycle status', async () => {
  const root = freshRoot();
  try {
    const projects = createProjectsContract(composeProjects({
      root,
      principal: 'person_chris',
    }));
    const first = await projects.createProject({ title: 'One' }, mintClientOpId());
    const second = await projects.createProject({ title: 'Two' }, mintClientOpId());
    assert.equal(first.ok && second.ok, true);

    const active = await projects.listProjects({ status: 'active' });
    assert.equal(active.ok, true);
    assert.deepEqual(
      active.ok ? active.value.items.map(({ title }) => title) : [],
      ['One', 'Two'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveProject requires clientOpId and replays one traced lifecycle change', async () => {
  const root = freshRoot();
  try {
    const projects = createProjectsContract(composeProjects({
      root,
      principal: 'person_chris',
    }));
    const created = await projects.createProject({ title: 'Archive me' }, mintClientOpId());
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const missingOp = await projects.archiveProject(created.value.id, undefined as never);
    assert.equal(missingOp.ok, false);
    assert.equal(missingOp.ok ? null : missingOp.error.code, 'InvalidEnvelope');

    const clientOpId = mintClientOpId();
    const first = await projects.archiveProject(created.value.id, clientOpId);
    const retry = await projects.archiveProject(created.value.id, clientOpId);
    assert.equal(first.ok && retry.ok, true);
    if (!first.ok || !retry.ok) return;
    assert.equal(first.value.status, 'archived');
    assert.equal(retry.value.status, 'archived');

    const archived = await projects.listProjects({ status: 'archived' });
    assert.deepEqual(
      archived.ok ? archived.value.items.map(({ id }) => id) : [],
      [created.value.id],
    );
    const engine = composeEngine({
      root,
      capability: 'projects',
      allowedKinds: ['project', 'projectItem'],
      principal: 'person_chris',
    });
    const trace = await queryTraceBound(engine, { clientOpId });
    assert.equal(trace.items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('getProjectItems requires an existing Project and starts empty', async () => {
  const root = freshRoot();
  try {
    const projects = createProjectsContract(composeProjects({
      root,
      principal: 'person_chris',
    }));
    const missing = await projects.getProjectItems('proj_missing' as never);
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? null : missing.error.code, 'NotFound');

    const created = await projects.createProject({ title: 'Items' }, mintClientOpId());
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const empty = await projects.getProjectItems(created.value.id);
    assert.equal(empty.ok, true);
    assert.deepEqual(empty.ok ? empty.value.items : null, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only the Spine-facing contract can attach items to an active Project', async () => {
  const root = freshRoot();
  try {
    const context = composeProjects({ root, principal: 'sys_spine' });
    const ordinary = createProjectsContract(context);
    assert.equal('attach' in ordinary, false);
    const spine = createSpineProjectsContract(context);

    const missing = await spine.attach(
      'proj_missing' as never,
      { itemRef: { kind: 'trace', id: 'trace_missing_project' } },
      mintClientOpId(),
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.ok ? null : missing.error.code, 'NotFound');

    const created = await ordinary.createProject({ title: 'Spine target' }, mintClientOpId());
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const attached = await spine.attach(
      created.value.id,
      { itemRef: { kind: 'trace', id: 'trace_first' } },
      mintClientOpId(),
    );
    assert.equal(attached.ok, true);

    await ordinary.archiveProject(created.value.id, mintClientOpId());
    const archived = await spine.attach(
      created.value.id,
      { itemRef: { kind: 'trace', id: 'trace_blocked' } },
      mintClientOpId(),
    );
    assert.equal(archived.ok, false);
    assert.equal(archived.ok ? null : archived.error.code, 'InvalidEnvelope');

    const retained = await ordinary.getProjectItems(created.value.id);
    assert.equal(retained.ok && retained.value.items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Spine attach stores only a dangling registered ref and stamps trusted identity', async () => {
  const root = freshRoot();
  try {
    const context = composeProjects({ root, principal: 'person_real' });
    const projects = createProjectsContract(context);
    const spine = createSpineProjectsContract(context);
    const created = await projects.createProject({
      title: 'Reference holder',
      createdBy: 'person_spoofed',
    } as never, mintClientOpId());
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.value.createdBy, 'person_real');

    const unregistered = await spine.attach(
      created.value.id,
      { itemRef: { kind: 'notRegistered', id: 'anything' } as never },
      mintClientOpId(),
    );
    assert.equal(unregistered.ok, false);
    assert.equal(unregistered.ok ? null : unregistered.error.code, 'InvalidEnvelope');

    const attachOp = mintClientOpId();
    const attached = await spine.attach(
      created.value.id,
      {
        itemRef: {
          kind: 'trace',
          id: 'trace_intentionally_dangling',
          copiedSourceContent: 'must not survive',
        } as never,
        note: 'Evidence link',
      },
      attachOp,
    );
    assert.equal(attached.ok, true);
    if (!attached.ok) return;
    assert.deepEqual(attached.value.itemRef, {
      kind: 'trace',
      id: 'trace_intentionally_dangling',
    });
    assert.equal(attached.value.createdBy, 'person_real');
    assert.equal(attached.value.addedBy, 'person_real');
    assert.equal(attached.value.addedVia, 'spine');

    const items = await projects.getProjectItems(created.value.id);
    assert.equal(items.ok && items.value.items.length, 1);
    const engine = composeEngine({
      root,
      capability: 'projects',
      allowedKinds: ['project', 'projectItem'],
      principal: 'person_real',
    });
    const trace = await queryTraceBound(engine, { clientOpId: attachOp });
    assert.equal(trace.items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attach replay returns its original result after the Project is archived', async () => {
  const root = freshRoot();
  try {
    const context = composeProjects({ root, principal: 'sys_spine' });
    const projects = createProjectsContract(context);
    const spine = createSpineProjectsContract(context);
    const created = await projects.createProject({ title: 'Replay target' }, mintClientOpId());
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const attachOp = mintClientOpId();
    const first = await spine.attach(
      created.value.id,
      { itemRef: { kind: 'trace', id: 'trace_replay_target' } },
      attachOp,
    );
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const archived = await projects.archiveProject(created.value.id, mintClientOpId());
    assert.equal(archived.ok, true);

    const retry = await spine.attach(
      created.value.id,
      { itemRef: { kind: 'trace', id: 'trace_replay_target' } },
      attachOp,
    );
    assert.equal(retry.ok, true);
    if (!retry.ok) return;
    assert.equal(retry.value.id, first.value.id);

    const items = await projects.getProjectItems(created.value.id);
    assert.equal(items.ok && items.value.items.length, 1);
    const engine = composeEngine({
      root,
      capability: 'projects',
      allowedKinds: ['project', 'projectItem'],
      principal: 'sys_spine',
    });
    const trace = await queryTraceBound(engine, { clientOpId: attachOp });
    assert.equal(trace.items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Project-dependent operations preserve a Foundation LockBusy read failure', async () => {
  const root = freshRoot();
  const lockDir = path.join(root, 'lock');
  try {
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'projects-read-test' })}\n`,
    );
    const context = composeProjects({
      root,
      principal: 'sys_spine',
      lockTimeoutMs: 50,
    });
    const projects = createProjectsContract(context);
    const spine = createSpineProjectsContract(context);
    const projectId = 'proj_unreadable' as never;
    const results = [
      await projects.archiveProject(projectId, mintClientOpId()),
      await projects.getProjectItems(projectId),
      await spine.attach(
        projectId,
        { itemRef: { kind: 'trace', id: 'trace_unreadable' } },
        mintClientOpId(),
      ),
    ];
    for (const result of results) {
      assert.equal(result.ok, false);
      assert.equal(result.ok ? null : result.error.code, 'LockBusy');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listProjects returns a typed corruption error for a malformed durable Project', async () => {
  const root = freshRoot();
  try {
    const handle = composeHandle({
      root,
      capability: 'projects',
      allowedKinds: ['project', 'projectItem'],
      principal: 'sys_spine',
    });
    const planted = await createObject(handle, {
      kind: 'project',
      id: 'proj_malformed',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'team',
      createdBy: 'overridden-by-foundation',
      status: 'active',
    }, mintClientOpId());
    assert.equal(planted.ok, true);

    const projects = createProjectsContract(composeProjects({
      root,
      principal: 'person_reader',
    }));
    const listed = await projects.listProjects();
    assert.equal(listed.ok, false);
    assert.equal(listed.ok ? null : listed.error.code, 'StoredRecordInvalid');
    assert.deepEqual(
      listed.ok
        ? null
        : (listed.error.details as { ref?: unknown }).ref,
      { kind: 'project', id: 'proj_malformed' },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
