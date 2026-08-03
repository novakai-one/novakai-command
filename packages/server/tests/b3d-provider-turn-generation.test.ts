import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import {
  createFakePtyHost,
  type FakePty,
} from '../../terminal/adapters/pty-host/fake.js';
import { connectRuntime } from '../core/b3/client.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { governedRole, governedTokens } from './governed-role.js';

test('a completed real-composition provider turn advances ActivityGeneration', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-provider-turn-generation-'));
  const ptyHost = createFakePtyHost({ echoInput: false, composer: true });
  const known = new Set<FakePty>();
  let completedProviderTurns = 0;
  const attach = setInterval(() => {
    for (const pty of ptyHost.started) {
      if (known.has(pty)) continue;
      known.add(pty);
      pty.onTurn((turn) => {
        if (!turn.includes('do NOT begin it yet')) return;
        completedProviderTurns += 1;
        pty.emit(`SKILLS-CONFIRMED: ${JSON.stringify(governedTokens())}\n`);
      });
    }
  }, 1);
  attach.unref();

  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers: createFakeProviderAdapters(),
    gateTimeoutMs: 5_000,
  });
  const client = await connectRuntime({ root, port: host.port, token: host.token });

  try {
    const role = await client.call<{ id: string }>(
      'b3.agent.createRole',
      governedRole('provider-turn-generation'),
    );
    assert.equal(role.ok, true, role.ok ? '' : role.error.message);
    if (!role.ok) return;

    const spawned = await client.call<{
      run: { activityGeneration: number };
    }>('b3.agent.spawn', {
      roleProfileId: role.value.id,
      displayName: 'Provider Turn Generation',
      workingDirectory: root,
      task: { kind: 'supervised', brief: 'Wait for one turn.' },
    });
    assert.equal(spawned.ok, true, spawned.ok ? '' : spawned.error.message);
    if (!spawned.ok) return;

    assert.equal(completedProviderTurns, 1);
    assert.ok(
      spawned.value.run.activityGeneration > 1,
      'a completed provider turn did not advance ActivityGeneration',
    );
  } finally {
    clearInterval(attach);
    client.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test.todo('§11.2 raw input starts zero turns and one semantic submit starts one');
test.todo('§11.2 every governed origin enters the same correlation operation');
test.todo('§11.2 exact provider profiles accept terminal framing and reject every mutant');
test.todo('§11.2 provider-native and Runtime namespaces cannot be confused');
test.todo('§11.2 submission and immutable completion replays preserve one identity');
test.todo('§11.2 concurrent completions cannot both advance one active tuple');
test.todo('§11.2 old completion A cannot mutate newer active turn B');
test.todo('§11.2 transient owner prerequisites resume under the same receipt');
test.todo('§11.2 interrupt and completion races preserve the durable barrier winner');
test.todo('§11.2 unproven completion closes only after both liveness owners are final');
