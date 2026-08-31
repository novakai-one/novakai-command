// A Runtime that dies mid-spawn, for real.
//
// This process starts a host on the root it is given, fires a governed spawn
// that nobody will ever answer, and then waits to be killed. The parent
// SIGKILLs it — no shutdown hook, no compensation, no chance to tidy up, which
// is exactly what a crash is and exactly what a graceful `host.close()` can
// never model.
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/governed/contract/index.js';
import { startRuntimeHost } from '../../core/runtime-host/host.js';
import { connectRuntime } from '../../core/runtime-host/client.js';
import { governedRole } from '../governed-role.js';
import { mintClientOpId } from '@novakai/foundation/contract';

const root = process.argv[2]!;
const host = await startRuntimeHost({
  root, port: 0, ptyHost: createFakePtyHost(),
  providers: createFakeProviderAdapters(), gateTimeoutMs: 600_000,
});
const client = await connectRuntime({ root, port: host.port, token: host.token });

const role = await client.call<{ id: string }>(
  'b3.agent.createRole', governedRole('crash-governed'), mintClientOpId(),
);
if (!role.ok) throw new Error(`createRole: ${role.error.message}`);

// Deliberately not awaited: the spawn is still inside its saga when this
// process is killed.
void client.call('b3.agent.spawn', {
  roleProfileId: role.value.id,
  displayName: 'Crashed Mid-Spawn',
  workingDirectory: '/tmp',
  task: { kind: 'supervised', brief: 'nobody will answer this' },
}, mintClientOpId());

// Announced only once the saga is genuinely under way, so the parent's kill
// lands mid-flight rather than before anything durable exists.
setTimeout(() => { process.stdout.write('MID-SPAWN\n'); }, 400);
setInterval(() => undefined, 1_000);
