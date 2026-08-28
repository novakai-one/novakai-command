/** Boot steps 8–9 and their never-silent Foundation traces. */

import { randomUUID } from 'node:crypto';
import type { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type { composeShellPersistence } from '../../../shell/contract/persistence.node.js';
import type { composeB2aServerCapabilities } from '../b2a/composition.js';
import type { MessagingRuntimeHost } from '../methods/runtime.js';
import type { BootError, BootNote, BootResult } from './contract.js';

export async function runCapabilityBoot(input: {
  b2a: ReturnType<typeof composeB2aServerCapabilities>;
  transcript: MessagingRuntimeHost;
  stopMessaging: () => Promise<void>;
  persistence: ReturnType<typeof composeShellPersistence>;
  appendSystemAction: typeof recordSystemAction;
  note: BootNote;
}): Promise<BootResult | null> {
  const trace = async (
    capability: 'artifacts' | 'projects',
    target: { kind: 'artifact' | 'project'; id: string },
    meta: Record<string, unknown>,
  ): Promise<BootError | null> => {
    try {
      const traced = await input.appendSystemAction(input.persistence.handle, {
        action: 'hook_log',
        target,
        clientOpId: `op_server_boot_${capability}_${randomUUID()}` as never,
        meta: { event: 'server.boot.capability', capability, ...meta },
      });
      return traced.ok
        ? null
        : {
            code: 'StoreUnavailable',
            message: `${capability} boot trace failed (${traced.error.code}): ${traced.error.message}`,
          };
    } catch (cause) {
      return {
        code: 'StoreUnavailable',
        message: `${capability} boot trace threw: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  };
  const fail = async (error: BootError): Promise<BootResult> => {
    await input.transcript.runtime.stop();
    await input.stopMessaging();
    return { ok: false, error };
  };

  const artifactSweep = await input.b2a.artifacts.boot.sweepOrphans();
  if (!artifactSweep.ok) {
    return fail({
      code: 'StoreUnavailable',
      message: `artifacts boot failed (${artifactSweep.error.code}): ${artifactSweep.error.message}`,
    });
  }
  const artifactError = await trace(
    'artifacts',
    { kind: 'artifact', id: 'server_boot_artifacts' },
    { sweptOrphans: artifactSweep.value.swept.length },
  );
  if (artifactError) return fail(artifactError);
  input.note(8, 'artifacts', `${artifactSweep.value.swept.length} orphan byte file(s) swept`);

  const projectsError = await trace(
    'projects',
    { kind: 'project', id: 'server_boot_projects' },
    {},
  );
  if (projectsError) return fail(projectsError);
  input.note(9, 'projects', 'operations and attachment contract ready');
  return null;
}
