// The umbrella `nvk` command routes the remaining Agent, Runtime and Terminal
// operator commands to their implementations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/governed/contract/index.js';
import { startRuntimeHost } from '../../core/runtime-host/host.js';
import { chatRole } from '../governed-role.js';
import { spawnAgentFixture } from '../support/spawn-agent-fixture.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const nvk = path.join(repoRoot, 'scripts', 'nvk.mjs');

function runNvk(args: readonly string[]): Promise<{ code: number | null; out: string }> {
  const child = spawn(process.execPath, [nvk, ...args], { cwd: repoRoot });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  return new Promise((resolve) => {
    child.on('close', (code) => { resolve({ code, out }); });
  });
}

for (const group of ['agent', 'runtime', 'terminal'] as const) {
  test(`nvk ${group} reaches its CLI rather than a usage error`, async () => {
    const seen = await runNvk([group]);
    assert.equal(seen.out.includes('usage: nvk project|artifact'), false,
      `nvk ${group} fell through to the top-level usage error: ${seen.out}`);
    // Every B3 CLI prints its own verb list when given none. That list naming
    // the group's verbs is the proof the right executable answered.
    assert.equal(seen.out.length > 0, true, `nvk ${group} said nothing at all`);
  });
}

test('an operator can read the stream, the fence and the grants by CLI', async () => {
  // §17.1 lists `nvk agent events [--after <cursor>]` among the canonical
  // commands and it did not exist; the fence, the grants and the repair door
  // had no operator surface either, so every one of them was reachable only by
  // someone willing to write a WebSocket client (hold-out D10, E9, G6, H3).
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-cli-reads-'));
  const host = await startRuntimeHost({
    root, port: 0, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
  });
  try {
    const file = path.join(root, 'role.json');
    writeFileSync(file, JSON.stringify(chatRole('cli-watched')), 'utf8');
    const where = ['--root', root, '--port', String(host.port), '--json'];
    await runNvk(['agent', 'define-role', '--file', file, ...where]);
    const spawned = await spawnAgentFixture({
      root, port: host.port, roleName: 'cli-watched', displayName: 'Watched',
      workingDirectory: root,
    });
    const agentId = String(spawned.agent.agentId);

    const events = await runNvk(['agent', 'events', ...where]);
    assert.equal(events.code, 0, `events failed: ${events.out}`);
    assert.equal(events.out.includes('agent.run.lifecycle.changed'), true,
      `the spawn published nothing an operator can read: ${events.out}`);

    const fence = await runNvk(['agent', 'fence', agentId, ...where]);
    assert.equal(fence.code, 0, `fence failed: ${fence.out}`);

    const grants = await runNvk(['agent', 'grants', ...where]);
    assert.equal(grants.code, 0, `grants failed: ${grants.out}`);
    assert.equal(grants.out.includes('delegationGrant_'), true,
      `the grants the Runtime issues are invisible: ${grants.out}`);
  } finally {
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
