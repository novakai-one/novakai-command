import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId,
  queryTraceBound,
} from '@novakai/foundation/dist/contract/index.js';
import { composeEngine } from '@novakai/foundation/dist/contract/compose.js';
import { composeProjects, createProjectsContract } from '../contract/index.js';

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
