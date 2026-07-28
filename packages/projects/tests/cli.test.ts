import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId,
  mintToken,
} from '@novakai/foundation/dist/contract/index.js';
import { composeProjects } from '../contract/index.js';

const CLI = path.resolve('dist/cli/nvk-project.js');

function invoke(root: string, args: string[], token?: string) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOVAKAI_ROOT: root,
      NOVAKAI_TOKEN: token ?? '',
    },
  });
}

function success<T>(root: string, token: string, args: string[]): T {
  const result = invoke(root, args, token);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as T;
}

test('offline CLI requires a recognized bearer token', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-auth-'));
  try {
    const noToken = invoke(root, ['list']);
    assert.equal(noToken.status, 2);
    assert.match(noToken.stderr, /token/i);

    const wrongToken = invoke(root, ['list'], 'nvk_wrong');
    assert.equal(wrongToken.status, 1);
    assert.equal(JSON.parse(wrongToken.stderr).code, 'AuthFailed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline CLI create preserves the shared Foundation lock failure', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-lock-'));
  const lockDir = path.join(root, 'lock');
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem'],
      'person_local',
    );
    mkdirSync(lockDir);
    writeFileSync(
      path.join(lockDir, 'owner.json'),
      `${JSON.stringify({ pid: process.pid, token: 'cli-test-holder' })}\n`,
    );
    const blocked = invoke(root, [
      'create',
      '--title', 'Blocked by global lock',
      '--client-op-id', mintClientOpId(),
      '--lock-timeout-ms', '50',
    ], token.bearer);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stderr).code, 'LockBusy');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline CLI create has parity with the in-process Projects contract', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-create-'));
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem'],
      'person_local',
    );
    const created = success<{
      id: string;
      createdBy: string;
      permissionLevel: string;
      status: string;
    }>(root, token.bearer, [
      'create',
      '--title', 'CLI Project',
      '--permission-level', 'team',
      '--client-op-id', mintClientOpId(),
    ]);
    assert.match(created.id, /^proj_/);
    assert.equal(created.createdBy, 'person_cli');
    assert.equal(created.permissionLevel, 'team');
    assert.equal(created.status, 'active');

    const projects = composeProjects({
      root,
      principal: 'person_cli',
    }).operations;
    const listed = await projects.listProjects();
    assert.equal(
      listed.ok && listed.value.items.some(({ id }) => id === created.id),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline CLI lists Projects through the shared contract', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-list-'));
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem'],
      'person_local',
    );
    const projects = composeProjects({
      root,
      principal: 'person_cli',
    }).operations;
    const created = await projects.createProject(
      { title: 'Listed by CLI' },
      mintClientOpId(),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const listed = success<{ items: Array<{ id: string }> }>(
      root,
      token.bearer,
      ['list', '--status', 'active'],
    );
    assert.deepEqual(listed.items.map(({ id }) => id), [created.value.id]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline CLI lists Project items through the shared contract', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-items-'));
  try {
    const token = mintToken(
      root,
      'sys_spine',
      ['project', 'projectItem'],
      'person_local',
    );
    const host = composeProjects({ root, principal: 'sys_spine' });
    const projects = host.operations;
    const spine = host.spine;
    const created = await projects.createProject(
      { title: 'CLI item holder' },
      mintClientOpId(),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const attached = await spine.attach(
      created.value.id,
      { itemRef: { kind: 'trace', id: 'trace_cli_dangling' } },
      mintClientOpId(),
    );
    assert.equal(attached.ok, true);

    const items = success<{
      items: Array<{ itemRef: { kind: string; id: string } }>;
    }>(root, token.bearer, ['items', '--project', created.value.id]);
    assert.deepEqual(items.items.map(({ itemRef }) => itemRef), [
      { kind: 'trace', id: 'trace_cli_dangling' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline CLI archives a Project through the shared contract', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-archive-'));
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem'],
      'person_local',
    );
    const projects = composeProjects({
      root,
      principal: 'person_cli',
    }).operations;
    const created = await projects.createProject(
      { title: 'Archived by CLI' },
      mintClientOpId(),
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const archived = success<{ id: string; status: string }>(
      root,
      token.bearer,
      [
        'archive',
        '--project', created.value.id,
        '--client-op-id', mintClientOpId(),
      ],
    );
    assert.equal(archived.id, created.value.id);
    assert.equal(archived.status, 'archived');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('offline CLI rejects direct attach because attachment belongs to Spine', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-projects-cli-attach-'));
  try {
    const token = mintToken(
      root,
      'person_cli',
      ['project', 'projectItem'],
      'person_local',
    );
    const bypass = invoke(root, [
      'attach',
      '--project', 'proj_bypass',
      '--kind', 'trace',
      '--id', 'trace_bypass',
      '--client-op-id', mintClientOpId(),
    ], token.bearer);
    assert.equal(bypass.status, 1);
    assert.equal(JSON.parse(bypass.stderr).code, 'Usage');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
