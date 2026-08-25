/** Novakai Server composition root: the same 13 ordered boot steps. */

import { randomUUID } from 'node:crypto';
import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type { FocusSnapshot } from '../../shell/contract/context.js';
import { startTransport, type RunningTransport } from './transport/server.js';
import { buildMethods, restoreLiveSessions, type ServerRuntime } from './methods.js';
import { handleDoorHttpRequest } from './door/routes.js';
import { composeB3Wire } from './b3/runtime-wire.js';
import { composePrincipals } from './boot/principals.js';
import { composeCapabilities } from './boot/capabilities.js';
import { hydrateConversations } from './boot/conversation-hydration.js';
import { prepareSessions } from './boot/session-sweep.js';
import { runCapabilityBoot } from './boot/boot-traces.js';
import { composeSupervision } from './boot/supervision-wire.js';
import { wireTurnAccounting } from './boot/turn-accounting.js';
import { wireTranscriptEvents } from './boot/transcript-events.js';
import type { BootOptions, BootResult, BootStep } from './boot/contract.js';
import { refuse } from './boot/contract.js';

export type {
  BootError,
  BootOptions,
  BootResult,
  BootStep,
  MessagingSessionHolder,
  NovakaiServer,
} from './boot/contract.js';

export async function bootServer(options: BootOptions): Promise<BootResult> {
  const steps: BootStep[] = [];
  const note = (step: number, name: string, detail: string): void => {
    steps.push({ step, name, detail });
    console.log(`[nvk-server] ${step}/13 ${name}: ${detail}`);
  };
  const cwd = options.cwd ?? process.cwd();

  const principals = await composePrincipals(options, note);
  if (!principals.ok) return principals.result;
  const { configStore, human, persistence } = principals;
  let config = principals.config;

  const capabilities = await composeCapabilities({
    options,
    note,
    configStore,
    humanPersonId: human.personId,
    cwd,
  });
  const {
    embedded,
    agentsCtx,
    agents,
    kimiRuntime,
    providerRuntimes,
    transcript,
    adoptedConversations,
  } = capabilities;
  const hydrated = await hydrateConversations(persistence.conversationViewDriver);
  const appendSystemAction = options.recordSystemAction ?? recordSystemAction;
  const prepared = await prepareSessions({
    options,
    note,
    config,
    human,
    persistence,
    embedded,
    transcript,
    conversations: hydrated.conversations,
    views: hydrated.views,
    agentsCtx,
    appendSystemAction,
  });
  if (!prepared.ok) return prepared.result;
  const { holders, humanHolder, sessions, sweep, b2a } = prepared;

  const capabilityFailure = await runCapabilityBoot({
    b2a,
    transcript,
    embedded,
    persistence,
    appendSystemAction,
    note,
  });
  if (capabilityFailure) return capabilityFailure;

  const runtimeRef: { current?: ServerRuntime } = {};
  const supervisionWire = await composeSupervision({
    options,
    config,
    sessions,
    agents,
    providerRuntimes,
    persistence,
    appendSystemAction,
    humanHolder,
    humanPersonId: human.personId,
    note,
    broadcast(name, data) {
      runtimeRef.current?.broadcast(name, data);
    },
  });
  const { supervision, watchdog, usageReader } = supervisionWire;
  const runtime: ServerRuntime = {
    root: options.root,
    cwd,
    human: { personId: human.personId, holder: humanHolder },
    holders,
    agents,
    kimiRuntime,
    providerRuntimes,
    sessions,
    supervision,
    watchdog,
    b2a,
    transcript,
    persistence,
    conversations: hydrated.conversations,
    configStore,
    config,
    focus: { app: 'messaging', ref: 'none' } as FocusSnapshot,
    broadcast: () => undefined,
    holderForPerson: async (personId: string) => {
      const principal = configStore.current().principals
        .find((candidate) => candidate.personId === personId);
      if (!principal) return null;
      const holder = await holders.holderFor({ token: principal.token, personId });
      return holder.ok ? holder.value : null;
    },
    mintOpId: () => `op_${randomUUID()}`,
  };
  runtimeRef.current = runtime;
  const adoptedConversationSubscription = adoptedConversations.subscribe((conversation) => {
    runtime.conversations.set(conversation.id, conversation);
    runtime.broadcast('conversation', {
      id: conversation.id,
      threadId: conversation.threadId ?? conversation.address,
      title: conversation.title,
      kind: conversation.kind,
      pinned: conversation.pinned,
      archived: conversation.archived,
      lastActivityAt: conversation.lastActivityAt,
      agentId: conversation.agentId,
    });
  });

  const others = config.principals
    .map((principal) => principal.personId)
    .filter((personId) => personId !== human.personId);
  await humanHolder.call((session) => (
    session as { setContactPolicy(value: object): Promise<unknown> }
  ).setContactPolicy({ allowlist: others, defaultRule: 'deny' }));
  await wireTurnAccounting({ providerRuntimes, sessions, usageReader });
  const restored = await restoreLiveSessions(runtime);
  if (restored > 0) {
    note(7, 'sessions', `${restored} session(s) reattached to their conversations`);
  }

  const b3Wire = await composeB3Wire({
    ...(options.b3 ?? {}),
    root: options.root,
    messagingRuntime: transcript.runtime,
    providerAgents: agents,
    publish(kind, payload) {
      if (kind === 'conversation.created') runtime.broadcast('conversation', payload);
    },
  });
  note(12, 'runtime', `b3.* composed on ${b3Wire.runtime.dataRoot}`);
  const methods = { ...buildMethods(runtime), ...b3Wire.methods };
  const transport: RunningTransport = await startTransport({
    root: options.root,
    port: options.port,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    methods,
    artifacts: b2a.artifacts,
    door: (context) => handleDoorHttpRequest({ runtime, methods }, context),
    identifyCaller: b3Wire.identifyCaller,
    onDispatch: b3Wire.onDispatch,
    onDisconnect: b3Wire.onDisconnect,
  });
  runtime.broadcast = (name, data) => transport.broadcast(name, data);
  const transcriptEvents = wireTranscriptEvents(runtime);
  try {
    await b3Wire.serve(transport);
  } catch (cause) {
    adoptedConversationSubscription.close();
    await transport.close();
    await b3Wire.close();
    await embedded.close();
    return refuse(
      'RuntimeUnavailable',
      `the B3 Runtime for ${options.root} refused to start: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  agents.subscribeAgentEvents((event) => transport.broadcast('presence', event));
  note(13, 'transport', `listening on ${transport.url} (nvk-ws v1, token-gated)`);
  if (config.transcript.ingest) transcript.topology.start();
  if (options.supervisionTimers ?? true) supervision.start();

  config = configStore.current();
  const configWatcher = configStore.watch((next) => {
    config = next;
    runtime.config = next;
  });
  return {
    ok: true,
    value: {
      url: transport.url,
      port: transport.port,
      token: transport.token,
      steps,
      interrupted: sweep.interrupted,
      sessions,
      supervision,
      get config() { return configStore.current(); },
      runtime,
      async close() {
        supervision.stop();
        configWatcher.close();
        await transcript.topology.stop();
        transcriptEvents.close();
        adoptedConversationSubscription.close();
        await transport.close();
        await b3Wire.close();
        await embedded.close();
      },
    },
  };
}
