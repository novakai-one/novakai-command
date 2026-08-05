#!/usr/bin/env -S npx tsx
// b3e-tracer-live.ts — stand up the tracer for a HUMAN to look at.
//
// The deterministic suite already proves the two hosts agree. This exists so
// the claim can be seen rather than believed: one real Runtime, serving the
// real Shell bundle, with a real governed Run in it — then `nvk agent list
// --json` on one side and a browser on the other.
//
//   npx tsx packages/server/tools/b3e-tracer-live.ts --port 5194
//
// It prints the URL and the connection token and stays up until Ctrl-C.
// Never port 5180: that is Chris's live server (B3E-ENTRY-LIST E-02). The data
// root is a fresh throwaway every time, because a reused root refuses its
// second boot (E-01).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePtyHost } from '../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../agents/b3/contract/index.js';
import { startRuntimeHost } from '../core/b3/host.js';
import { connectRuntime } from '../core/b3/client.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const flagValue = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
};

const port = Number(flagValue('port', '5194'));
if (port === 5180) throw new Error('5180 is the LIVE server port; pick another (E-02)');

const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3e-live-'));
const staticDir = path.join(repoRoot, 'packages', 'shell', 'dist');

const role = (name: string): Record<string, unknown> => ({
  name,
  description: `${name} for the B3e tracer`,
  status: 'active',
  providerPolicy: { allowed: ['claude'], defaultProvider: 'claude' },
  modelPolicy: {
    allowedModelIds: ['tracer-default'], defaultModelId: 'tracer-default',
    allowNativeChange: false, allowReplacementChange: true,
  },
  effortPolicy: { allowed: ['default'], defaultEffort: 'default' },
  skillRefs: [], hookRefs: [], instructionRefs: [],
  skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  executionPolicyRef: { id: 'execution-default', version: 1, digest: 'digest' },
  spawnPolicy: { allowedChildRoleIds: [], requireManagedSpawn: true },
  lifecyclePolicy: {
    onTaskComplete: 'keep-running',
    onSupervisorFinal: 'assign-nearest-live-ancestor',
    allowedContinuationModes: ['fresh', 'resume'],
  },
  supervisionPolicy: {
    activityDrift: 'disabled-explicitly',
    requiredWatcherTemplates: [],
    parentNotificationMode: 'queue-only',
  },
  budgetPolicy: { hardStopEnabled: false },
});

const host = await startRuntimeHost({
  root, port, staticDir, ptyHost: createFakePtyHost(), providers: createFakeProviderAdapters(),
});
const chris = await connectRuntime({ root, port: host.port, token: host.token });

for (const [roleName, agentName] of [
  ['tracer-builder', 'Tracer Builder'],
  ['tracer-auditor', 'Tracer Auditor'],
] as const) {
  const defined = await chris.call<{ id: string }>('b3.agent.createRole', role(roleName));
  if (!defined.ok) throw new Error(`role ${roleName}: ${defined.error.message}`);
  const spawned = await chris.call<{ run: { id: string } }>('b3.agent.spawn', {
    roleProfileId: defined.value.id,
    displayName: agentName,
    workingDirectory: root,
  });
  if (!spawned.ok) throw new Error(`spawn ${agentName}: ${spawned.error.message}`);
  process.stdout.write(`spawned ${agentName} as ${spawned.value.run.id}\n`);
}
chris.close();

process.stdout.write(`${JSON.stringify({
  url: `${host.httpUrl}/`, port: host.port, root, token: host.token,
}, null, 2)}\n`);
process.stdout.write('TRACER LIVE — Ctrl-C to stop\n');
