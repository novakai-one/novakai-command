// Slice 5 — CLI parity (DEC-F11): nvk-agent verbs call the SAME contract
// functions over the SAME store; outcomes match the in-process path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mintClientOpId, type AgentId } from '@novakai/foundation/dist/contract/brands.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import { composeAgents } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';

const run = promisify(execFile);
const CLI = path.resolve('dist/cli/nvk-agent.js');

async function cli(root: string, ...args: string[]): Promise<unknown> {
  const { stdout } = await run(process.execPath, [CLI, ...args], {
    env: { ...process.env, NOVAKAI_ROOT: root, NOVAKAI_PRINCIPAL: 'person_chris' },
  });
  const text = stdout.trim();
  return text ? JSON.parse(text) : null;
}

test('CLI define → in-process list sees it (same store, same contract)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-cli-'));
  const defined = await cli(root, 'define', '--display-name', 'CliBorn', '--provider', 'mock', '--model', 'm1') as { id: string; createdBy: string };
  assert.match(defined.id, /^agent_/);
  assert.equal(defined.createdBy, 'person_chris'); // principal stamped on the CLI path too
  const agents = createAgentsContract(composeAgents({ root, principal: 'person_chris' }));
  const listed = await agents.listAgents();
  assert.equal(listed.ok && listed.value.items.some((a) => a.id === defined.id), true);
});

test('in-process define → CLI list/get sees it; CLI set-model → in-process get reflects it', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-cli-'));
  const agents = createAgentsContract(composeAgents({ root, principal: 'person_chris' }));
  const created = await agents.defineAgent(
    { displayName: 'ProcBorn', provider: 'kimi', model: 'old', permissionLevel: 'private', hooks: [], status: 'defined' },
    mintClientOpId());
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const listed = await cli(root, 'list') as { items: Array<{ id: string }> };
  assert.equal(listed.items.some((a) => a.id === created.value.id), true);
  const updated = await cli(root, 'set-model', '--agent', created.value.id, '--model', 'new') as { model: string };
  assert.equal(updated.model, 'new');
  const read = await agents.getAgent(created.value.id as AgentId);
  assert.equal(read.ok && !isAbsent(read.value) && read.value.model, 'new');
});

test('CLI spawn returns a SpawnResponse-shaped session (mock adapter); events verb runs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-cli-'));
  const defined = await cli(root, 'define', '--display-name', 'Spawnee', '--provider', 'mock', '--model', 'm1') as { id: string };
  const spawned = await cli(root, 'spawn', '--agent', defined.id, '--model', 'at-spawn') as {
    sessionId: string; agentId: string; provider: string; model: string;
  };
  assert.match(spawned.sessionId, /^sess_/);
  assert.equal(spawned.agentId, defined.id);
  assert.equal(spawned.provider, 'mock');
  assert.equal(spawned.model, 'at-spawn');
  await cli(root, 'events', '--ms', '50'); // subscribes and exits cleanly
});

test('CLI get on an unknown id prints typed Absent (absence is data, A §11)', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-cli-'));
  const got = await cli(root, 'get', '--agent', 'agent_ghost') as { absent: boolean; ref: { id: string } };
  assert.equal(got.absent, true);
  assert.equal(got.ref.id, 'agent_ghost');
});

test('CLI failure path: spawn unknown agent exits non-zero with the typed error', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-agents-cli-'));
  await assert.rejects(
    run(process.execPath, [CLI, 'spawn', '--agent', 'agent_ghost'], {
      env: { ...process.env, NOVAKAI_ROOT: root },
    }),
    (e: unknown) => {
      const err = e as { code: number; stderr: string };
      assert.equal(err.code, 1);
      assert.match(err.stderr, /"NotFound"/);
      return true;
    });
});
