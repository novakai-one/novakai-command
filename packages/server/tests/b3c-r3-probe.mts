// SCRATCH probe (NVK-KIMI-040 R3) — not a test, not committed.
//
// Reproduces the exam's D2/E2 conditions with the REAL provider adapters and a
// REAL node-pty host, then dumps every gate the inbox-delivery pump reads.
//
//   npx tsx packages/server/tests/b3c-r3-probe.mts --port 5197 --provider claude
import { mkdirSync, mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startRuntimeHost } from '../core/runtime-host/host.js';
import { connectRuntime } from '../core/runtime-host/client.js';
import { governedRole } from './governed-role.js';

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const port = Number(arg('port', '5197'));
const provider = arg('provider', 'claude');
const cwd = arg('cwd', mkdtempSync(path.join(tmpdir(), 'nvk-r3-probe-')));
mkdirSync(cwd, { recursive: true });
const root = path.join(cwd, '.novakai');
mkdirSync(root, { recursive: true });

const log = (...p: unknown[]): void => console.log('[probe]', ...p);
const dump = (label: string, value: unknown): void =>
  console.log(`[probe] ${label} ${JSON.stringify(value)}`);

const host = await startRuntimeHost({ root, port, cwd });
log('host up', host.httpUrl);
const chris = await connectRuntime({ root, port: host.port, token: host.token });

const role = await chris.call<{ id: string }>('b3.agent.createRole', {
  ...governedRole('r3-probe-role'),
  skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
});
dump('createRole', role);
if (!role.ok) process.exit(1);

const spawned = await chris.call<{
  agent: { agentId: string }; run: { id: string; lifecycle?: string };
}>('b3.agent.spawn', {
  roleProfileId: role.value.id,
  displayName: 'R3Probe',
  workingDirectory: cwd,
  provider,
});
dump('spawn', spawned);
if (!spawned.ok) { await host.close(); process.exit(1); }
const agentId = spawned.value.agent.agentId;
const runId = spawned.value.run.id;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function snapshot(label: string): Promise<void> {
  const run = await chris.call('b3.agent.getRun', { agentRunId: runId });
  dump(`${label} run`, run);
  const endpoint = await chris.call('b3.messaging.getAgentEndpoint', { agentId });
  dump(`${label} endpoint`, endpoint);
  const inbox = await chris.call('b3.messaging.listAgentInbox', { agentId });
  dump(`${label} inbox`, inbox);
}

// The exam types into the PTY first; give the run its warm-up before sending.
await sleep(Number(arg('warmup', '20000')));
await snapshot('pre-send');

const sent = await chris.call<{ messageId: string; state: string; inboxItemId?: string }>(
  'b3.messaging.sendAgent', {
    target: { kind: 'agent', agentId },
    text: 'NVKR3PROBE please reply with the token NVKR3PROBEOK',
    clientMessageId: 'cmid-r3-probe-1',
  },
);
dump('sendAgent', sent);

for (const wait of [1000, 2000, 4000, 8000]) {
  await sleep(wait);
  await snapshot(`t+${String(wait)}`);
}

// Durable truth on disk, in case a wire read is filtering.
const storeDir = path.join(root, 'stores');
if (existsSync(storeDir)) {
  for (const file of readdirSync(storeDir)) {
    if (!/agentInbox|agentEndpoint|terminalInputAttempt/i.test(file)) continue;
    const lines = readFileSync(path.join(storeDir, file), 'utf8').trim().split('\n').filter(Boolean);
    log(`store ${file}: ${String(lines.length)} lines`);
    for (const line of lines.slice(-6)) log(`  ${line.slice(0, 400)}`);
  }
}

chris.close();
await host.close();
log('done; cwd', cwd);
process.exit(0);
