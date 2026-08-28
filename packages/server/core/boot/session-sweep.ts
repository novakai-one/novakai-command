/** Boot steps 6–7: provider-session sweep and the B2a capability composition. */

import { randomUUID } from 'node:crypto';
import type { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import { createProviderSessionRegistry, osProcessProbe } from '../../../agents/contract/index.js';
import type { composeAgents } from '../../../agents/contract/index.js';
import type { composeShellPersistence } from '../../../shell/contract/persistence.node.js';
import type { ServerConfig } from '../../contract/config.js';
import { composeB2aServerCapabilities } from '../b2a/composition.js';
import type { BootNote, BootOptions } from './contract.js';

export async function prepareSessions(input: {
  options: BootOptions;
  note: BootNote;
  config: ServerConfig;
  human: { token: string; personId: string };
  persistence: ReturnType<typeof composeShellPersistence>;
  conversationCount: number;
  agentsCtx: ReturnType<typeof composeAgents>;
  appendSystemAction: typeof recordSystemAction;
}) {
  input.note(
    6,
    'shell',
    `layout/settings ready, ${input.conversationCount} conversation view(s) hydrated`,
  );

  const sessions = createProviderSessionRegistry(
    input.agentsCtx,
    input.options.processProbe ?? osProcessProbe,
  );
  const sweep = await sessions.sweepOrphans();
  for (const error of sweep.errors) {
    console.error(`[nvk-server] orphan sweep registry patch failed (${error.code}): ${error.message}`);
  }
  input.note(
    7,
    'sessions',
    `${(await sessions.resumable()).length} resumable session(s); ${sweep.interrupted.length} interrupted, ${sweep.killed.length} orphan(s) reaped`,
  );
  for (const interruption of sweep.interrupted) {
    const traced = await input.appendSystemAction(input.persistence.handle, {
      action: 'hook_log',
      target: { kind: 'providerSession', id: interruption.sessionId },
      clientOpId: `op_${randomUUID()}` as never,
      meta: { event: 'ReplyInterrupted', clientOpId: interruption.clientOpId },
    });
    if (!traced.ok) {
      console.error(
        `[nvk-server] ReplyInterrupted trace failed (${traced.error.code}): ${traced.error.message}`,
      );
    }
  }
  const b2a = composeB2aServerCapabilities({
    root: input.options.root,
    principal: input.human.personId,
  });
  return { sessions, sweep, b2a };
}
