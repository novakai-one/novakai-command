/** Boot steps 6–7: holders, legacy-view classification and session sweep. */

import { randomUUID } from 'node:crypto';
import type { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import { createProviderSessionRegistry, osProcessProbe } from '../../../agents/contract/index.js';
import type { composeAgents } from '../../../agents/contract/index.js';
import type * as messaging from '../../../messaging/contract/index.js';
import type { composeShellPersistence } from '../../../shell/contract/persistence.node.js';
import {
  listConversationViews,
  setConversationView,
} from '../../../shell/contract/conversationView.js';
import type { MessageExistenceQuery } from '../../../spine/contract/index.js';
import type { ServerConfig } from '../../contract/config.js';
import { composeB2aServerCapabilities } from '../b2a/composition.js';
import type { composeTranscriptServerHost } from '../b2b/composition.js';
import type { Conversation } from '../methods.js';
import { createSessionHolderFactory } from '../session/holders.js';
import type { BootNote, BootOptions, BootResult } from './contract.js';
import { refuse } from './contract.js';

export async function prepareSessions(input: {
  options: BootOptions;
  note: BootNote;
  config: ServerConfig;
  human: { token: string; personId: string };
  persistence: ReturnType<typeof composeShellPersistence>;
  embedded: messaging.EmbeddedMessaging;
  transcript: ReturnType<typeof composeTranscriptServerHost>;
  conversations: Map<string, Conversation>;
  views: Awaited<ReturnType<typeof listConversationViews>>;
  agentsCtx: ReturnType<typeof composeAgents>;
  appendSystemAction: typeof recordSystemAction;
}) {
  const holders = createSessionHolderFactory({ messaging: input.embedded as never });
  const humanHolder = await holders.holderFor(input.human);
  if (!humanHolder.ok) {
    return {
      ok: false as const,
      result: refuse('MessagingUnavailable', humanHolder.error.message),
    };
  }
  const listedThreads = await humanHolder.value.call((session) => (
    session as { listThreadsForPerson(value: object): Promise<unknown> }
  ).listThreadsForPerson({})) as {
    kind: string;
    value?: { threads: Array<{ id: string; direct?: { pair: string[] }; room?: unknown }> };
    error?: { name?: string; message?: string };
  };
  const configuredPeople = new Set(input.config.principals.map((principal) => principal.personId));
  const resolvableThreads = listedThreads.kind === 'ok' && listedThreads.value
    ? new Set(listedThreads.value.threads
      .filter((thread) => thread.room !== undefined
        || (thread.direct?.pair.every((personId) => configuredPeople.has(personId)) ?? false))
      .map((thread) => thread.id))
    : null;
  if (!resolvableThreads) {
    console.error(
      '[nvk-server] legacy conversation classification could not list messaging threads: '
        + `${listedThreads.error?.name ?? 'Unknown'} ${listedThreads.error?.message ?? ''}`.trim(),
    );
  }

  const unavailableMessage =
    'This legacy conversation has no resolvable person or thread. It was archived; start a new conversation to send a message.';
  let archivedLegacy = 0;
  for (const view of input.views) {
    const hasThreadRef = view.threadRef?.kind === 'thread';
    const address = view.address?.trim();
    const personId = !hasThreadRef && address?.startsWith('person:')
      ? address.slice('person:'.length)
      : null;
    const addressedThreadId = !hasThreadRef && address?.startsWith('thread:')
      ? address.slice('thread:'.length)
      : null;
    const unresolvable = hasThreadRef
      ? (resolvableThreads ? !resolvableThreads.has(view.threadRef!.id) : false)
      : view.address === undefined
        ? false
        : personId !== null
          ? !personId || !configuredPeople.has(personId)
          : addressedThreadId !== null
            ? !addressedThreadId || (resolvableThreads
              ? !resolvableThreads.has(addressedThreadId)
              : false)
            : true;
    if (!unresolvable) continue;

    const conversation = input.conversations.get(view.id)!;
    conversation.archived = true;
    conversation.address = '';
    delete conversation.threadId;
    conversation.unavailable = { code: 'ConversationUnavailable', message: unavailableMessage };
    const migrationClientOpId = `op_conversation_migrate_archive_${view.id}`;
    if (!view.archived) {
      const migrated = await setConversationView(
        input.persistence.conversationViewDriver,
        view.id,
        { archived: true },
        migrationClientOpId,
      );
      if (!migrated.ok) {
        console.error(
          `[nvk-server] legacy conversation migration failed for ${view.id}: `
            + `${migrated.error.code} ${migrated.error.message}`,
        );
        continue;
      }
      archivedLegacy += 1;
    }
    const traced = await input.appendSystemAction(input.persistence.handle, {
      action: 'hook_log',
      target: { kind: 'conversationView', id: view.id },
      clientOpId: `${migrationClientOpId}_trace` as never,
      meta: {
        event: 'conversation.migrate.archive-unresolvable',
        migrationClientOpId,
        previousThreadRef: view.threadRef,
      },
    });
    if (!traced.ok) {
      await input.transcript.topology.stop();
      await input.embedded.close();
      const result: BootResult = refuse(
        'MigrationTraceFailed',
        `legacy conversation migration trace failed for ${view.id} `
          + `(${traced.error.code}): ${traced.error.message}`,
      );
      return { ok: false as const, result };
    }
  }
  input.note(
    6,
    'shell',
    `layout/settings ready, ${input.conversations.size} conversation view(s) hydrated; `
      + `${archivedLegacy} unresolvable legacy view(s) archived`,
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
    `${holders.principals().length} holder(s); ${(await sessions.resumable()).length} resumable session(s); ${sweep.interrupted.length} interrupted, ${sweep.killed.length} orphan(s) reaped`,
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
    messaging: {
      getDelivery: (value) => humanHolder.value.call((session) =>
        (session as MessageExistenceQuery).getDelivery(value)),
    },
  });
  return { ok: true as const, holders, humanHolder: humanHolder.value, sessions, sweep, b2a };
}
