// packages/server/core/boot.ts — THE composition root (DEC-B1-1/DEC-B1-2).
//
// One persistent process boots, in dependency order, with a trace line per step
// (FND-005 pattern — a boot step is never silent):
//
//   1 config          2 foundation store   3 messaging (authority from config)
//   4 agents+providers 5 transcript        6 shell persistence
//   7 session layer + providerSession registry + orphan sweep
//   8 artifacts       9 projects          10 spine
//  11 supervision (B1a: watchdog hook)    12 B3 Runtime (`b3.*`)
//  13 HTTP + nvk-ws v1
//
// Step 12 is A4/T-02: the page this process serves reaches every Agent Run
// through FZ-VIEW-001's door, which is `b3.*`. Composing the Runtime anywhere
// else meant the server that served the Shell answered `unknown method` to the
// only vocabulary its screens speak, so a backed Shell was unreachable by
// construction. One process, one port, both vocabularies.
//
// It replaces packages/shell/demo/bridge.ts. Everything the demo PROVED is
// promoted; everything the demo HACKED (hardcoded tokens, person pools, code
// seeding, unauthenticated socket) is gone.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as messaging from '../../messaging/public/index.js';
import type { PersonId } from '../../messaging/public/index.js';
import {
  composeAgents, createAgentsContract, createClaudeCliRuntime, createCodexCliRuntime,
  createKimiCliRuntime, createProviderSessionRegistry,
  defaultClaudeCliPath, defaultCodexCliPath, defaultKimiCliPath, osProcessProbe,
  type ClaudeCliRuntime, type CodexCliRuntime, type KimiCliRuntime, type LiveLaneSender,
  type ProcessProbe, type ProviderCliRuntime, type ProviderSessionRegistry, type ProviderTurnRecord,
} from '../../agents/contract/index.js';
import { composeShellPersistence } from '../../shell/contract/persistence.node.js';
import { listConversationViews, setConversationView } from '../../shell/contract/conversationView.js';
import type { FocusSnapshot } from '../../shell/contract/context.js';
import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore, type ConfigStore } from './config/store.js';
import { canonicalDataRoot, StoreRouteConflictError } from './store-route.js';
import type { ServerConfig } from '../contract/config.js';
import { createSessionHolderFactory, type MessagingSessionHolder, type SessionHolderFactory } from './session/holders.js';
import { createLiveAuthority } from './session/authority.js';
import { createWatchdogHook, type WatchdogHook } from './supervision/watchdog.js';
import { createUsageReader } from './supervision/usage.js';
import { createUsageLog } from './supervision/log.js';
import { createSupervisedTransport } from './supervision/transport.js';
import { createSupervisionEngine, type SupervisionEngine, type SupervisionRecord } from './supervision/engine.js';
import { startTransport, type RunningTransport } from './transport/server.js';
import { buildMethods, restoreLiveSessions, type ServerRuntime, type Conversation } from './methods.js';
import { composeB3Wire } from './b3/runtime-wire.js';
import type { B3RuntimeOptions } from './b3/composition.js';
import { composeB2aServerCapabilities } from './b2a/composition.js';
import { composeTranscriptServerHost } from './b2b/composition.js';
import type { MessageExistenceQuery } from '../../spine/contract/index.js';

export interface BootOptions {
  /** `.novakai/` root. */
  root: string;
  port: number;
  /** Built shell bundle. Omitted = protocol only (tests, headless ops). */
  staticDir?: string;
  /** Working directory handed to provider CLIs (the repo root in practice). */
  cwd?: string;
  /** Overridable for tests; production discovers the installed CLI. */
  kimiCliPath?: string;
  /** B1b: same, for the two adapters this slice adds. */
  codexCliPath?: string;
  claudeCliPath?: string;
  /** Overridable for tests; production reads the operator's real home. */
  providerHome?: string;
  /** Start the supervision timers. Off in tests, on in production. */
  supervisionTimers?: boolean;
  /**
   * Directory holding `.watchdog-sessions.json`. Defaults to the data root:
   * it is this root's own state, and defaulting it to the working directory
   * left a throwaway root's registry inside the product checkout
   * (B3E-ENTRY-LIST E-03).
   */
  watchdogDir?: string;
  processProbe?: ProcessProbe;
  /** @internal failure-injection seam for never-silent trace tests. */
  recordSystemAction?: typeof recordSystemAction;
  /**
   * Passed straight through to the B3 Runtime this process composes (step 12).
   * It carries no policy of its own: the seams are the Runtime's own published
   * ones — the PTY host and the provider adapters a suite substitutes, the
   * interval tunables an operator sets — and `root` is this boot's root, never
   * a second one.
   */
  b3?: Omit<B3RuntimeOptions, 'root' | 'publish'>;
}

export interface BootStep {
  step: number;
  name: string;
  detail: string;
}

export interface BootError {
  code:
    | 'ConfigUnavailable'
    | 'StoreRouteConflict'
    | 'NoHumanPrincipal'
    | 'MessagingUnavailable'
    | 'StoreUnavailable'
    | 'MigrationTraceFailed'
    /**
     * Another process already holds this root's Runtime. Since step 12 this
     * server IS the Runtime, so it refuses rather than serving `b3.*` from a
     * composition that has no right to the machine's PTYs (red gate 2).
     */
    | 'RuntimeUnavailable';
  message: string;
}

export interface NovakaiServer {
  url: string;
  port: number;
  token: string;
  steps: BootStep[];
  /** Interrupted sends surfaced by the boot sweep (§13 disposition 2). */
  interrupted: Array<{ sessionId: string; clientOpId: string; reason: 'ReplyInterrupted' }>;
  sessions: ProviderSessionRegistry;
  /** B1b §8: the supervision engine, exposed so ops and tests can drive it. */
  supervision: SupervisionEngine;
  config: ServerConfig;
  /** @internal exposed so tests can drive methods without a socket. */
  runtime: ServerRuntime;
  close(): Promise<void>;
}

export type BootResult =
  | { ok: true; value: NovakaiServer }
  | { ok: false; error: BootError };

/**
 * A boot that will not happen, said once. Every refusal below is the same
 * sentence — this root cannot be served, and here is which fact stopped it —
 * so it is spelled in one place rather than re-assembled at each step.
 */
const refuse = (code: BootError['code'], message: string): BootResult =>
  ({ ok: false, error: { code, message } });

const HUMAN_ROLE = 'Human';
const MINT_RUNBOOK =
  'run: npx tsx packages/server/cli/nvk-token.ts mint person_chris --grants layout,settings,conversationView --roles Human';

export async function bootServer(options: BootOptions): Promise<BootResult> {
  const steps: BootStep[] = [];
  const note = (step: number, name: string, detail: string): void => {
    steps.push({ step, name, detail });
    console.log(`[nvk-server] ${step}/13 ${name}: ${detail}`);
  };
  const cwd = options.cwd ?? process.cwd();

  // ── 1. config ────────────────────────────────────────────────────────────
  // The §18.1 route gate runs inside this open and refuses a blocked root by
  // throwing — it is deliberately not a value there, because a process that
  // came up after a route conflict would be writing to a route nobody proved
  // is current. A composition root is where that becomes an operator-readable
  // refusal instead of a stack trace.
  let opened: Awaited<ReturnType<typeof openConfigStore>>;
  try {
    opened = await openConfigStore({ root: options.root, principal: 'sys_spine' });
  } catch (cause) {
    if (!(cause instanceof StoreRouteConflictError)) throw cause;
    return refuse('StoreRouteConflict', cause.message);
  }
  if (!opened.ok) {
    return refuse('ConfigUnavailable', opened.error.message);
  }
  const configStore: ConfigStore = opened.value;
  let config = configStore.current();
  note(1, 'config', `${config.principals.length} principal(s), ${config.bindings.length} binding(s), allowMock=${config.dev.allowMock}`);
  for (const missing of config.unresolvedPrincipals) {
    console.warn(`[nvk-server] principal "${missing.personId}" is unresolvable — ${missing.reason} (drawn absence, not a crash)`);
  }

  const human = config.principals.find((p) => p.roles.includes(HUMAN_ROLE));
  if (!human) {
    return {
      ok: false,
      error: {
        code: 'NoHumanPrincipal',
        // §18.1's inventory puts config.jsonl in `.novakai/stores/` with every
        // other registered kind. Naming the old root-level path here would send
        // an operator to a file the product no longer writes.
        message: `no principal with role "${HUMAN_ROLE}" in `
          + `${path.join(options.root, 'stores', 'config.jsonl')} — ${MINT_RUNBOOK}`,
      },
    };
  }

  // ── 2. foundation store ──────────────────────────────────────────────────
  // On the CANONICAL route (§18.1), like every other capability under this
  // root. Composing it on the legacy route is what made a fresh root bootable
  // exactly once (B3E-ENTRY-LIST E-01): the boot trace appended a legacy
  // `traces.jsonl` beside the canonical one the token mint had already
  // written, and the route gate then refused every later boot. `legacyRoot`
  // keeps a pre-B3 root's layout/settings/views readable until the gate's
  // cutover copies them across.
  const persistence = composeShellPersistence({
    root: options.root,
    dataRoot: canonicalDataRoot(options.root),
    principal: human.personId,
  });
  note(2, 'foundation', `store open at ${options.root} as ${human.personId}`);

  // ── 3. messaging (authority BUILT FROM CONFIG — the hardcoded table is gone) ─
  const clock = messaging.createSystemClock();
  const store = await messaging.openJsonlStore(clock, { path: path.join(options.root, 'messaging.jsonl') });
  // The authority is LIVE over config: a person provisioned for a new agent
  // conversation is authenticatable without restarting the server (DEC-B1-8).
  const authority = createLiveAuthority({ snapshot: () => configStore.current(), clock });
  const embedded = messaging.createEmbeddedMessaging({
    clock,
    store,
    authority: authority as never,
  });
  await embedded.start();
  note(3, 'messaging', `embedded capability up with ${config.principals.length} configured principal(s)`);

  // ── 4. agents + provider adapter registry ────────────────────────────────
  const kimiCliPath = options.kimiCliPath ?? config.providers.kimi.cliPath ?? defaultKimiCliPath();
  const codexCliPath = options.codexCliPath ?? config.providers.codex.cliPath ?? defaultCodexCliPath();
  const claudeCliPath = options.claudeCliPath ?? config.providers.claude.cliPath ?? defaultClaudeCliPath();
  // Each provider gets its OWN cwd when config names one — codex in particular
  // needs a git-repo root, and the server's cwd is not guaranteed to be one.
  const kimiRuntime: KimiCliRuntime = createKimiCliRuntime({ cwd: config.providers.kimi.cwd ?? cwd, cliPath: kimiCliPath });
  const codexRuntime: CodexCliRuntime = createCodexCliRuntime({ cwd: config.providers.codex.cwd ?? cwd, cliPath: codexCliPath });
  const claudeRuntime: ClaudeCliRuntime = createClaudeCliRuntime({ cwd: config.providers.claude.cwd ?? cwd, cliPath: claudeCliPath });
  const providerRuntimes: Partial<Record<'kimi' | 'codex' | 'claude', ProviderCliRuntime>> = {
    kimi: kimiRuntime, codex: codexRuntime, claude: claudeRuntime,
  };
  const agentsCtx = composeAgents({
    root: options.root,
    // CANONICAL route, same as the foundation store above (E-01): composing on
    // the legacy flat root wrote agents/providerSessions/traces beside their
    // canonical files, and the route gate then refused every later boot.
    dataRoot: canonicalDataRoot(options.root),
    principal: human.personId,
    providerRuntimes,
    allowMock: config.dev.allowMock,
    cwd,
  });
  const agents = createAgentsContract(agentsCtx);
  const availability = (name: string, runtime: ProviderCliRuntime, path: string): string =>
    `${name}=${runtime.isAvailable() ? path : 'CLI NOT FOUND'}`;
  note(4, 'agents', [
    availability('kimi', kimiRuntime, kimiCliPath),
    availability('codex', codexRuntime, codexCliPath),
    availability('claude', claudeRuntime, claudeCliPath),
    `mock=${config.dev.allowMock ? 'dev' : 'disabled'}`,
  ].join(', '));

  // ── 5. transcript topology ───────────────────────────────────────────────
  // The dedicated config gate controls BOTH copy custody and ingestion.
  // Startup is deferred until transport listens; the sealed synchronous
  // watcher runs in a worker so provider volume cannot block HTTP.
  const transcript = composeTranscriptServerHost({
    root: options.root,
    ...(options.providerHome ? { providerHome: options.providerHome } : {}),
  });
  if (config.transcript.ingest) {
    note(
      5,
      'transcript',
      'copy custody + ingestion enabled (starts after transport)',
    );
  } else {
    note(
      5,
      'transcript',
      'copy custody + ingestion disabled (config transcript.ingest=false)',
    );
  }

  // ── 6. shell persistence (composed at step 2; hydrate the view cache) ────
  const conversations = new Map<string, Conversation>();
  const conversationViews = await listConversationViews(persistence.conversationViewDriver);
  for (const view of conversationViews) {
    conversations.set(view.id, {
      id: view.id,
      address: view.threadRef?.kind === 'thread'
        ? `thread:${view.threadRef.id}`
        : (view.address ?? ''),
      title: view.titleOverride ?? view.id,
      kind: 'agent',
      pinned: view.pinned,
      archived: view.archived,
      lastActivityAt: view.lastActivityAt,
      ...(view.threadRef?.kind === 'thread' ? { threadId: view.threadRef.id } : {}),
      // S2 (M2-01): restore the durable agent binding (session or not).
      ...(view.agentId ? { agentId: view.agentId } : {}),
      ...(view.provider ? { provider: view.provider } : {}),
      ...(view.lastReadMessageId ? { lastReadMessageId: view.lastReadMessageId } : {}),
    });
  }

  // ── 7. session layer + providerSession registry + orphan sweep ───────────
  // The factory takes the capability, not a plucked function: the server's ONLY
  // `.authenticate` call site is inside holders.ts (red gate 5, architecture-tested).
  const holders: SessionHolderFactory = createSessionHolderFactory({ messaging: embedded as never });
  const humanHolder = await holders.holderFor({ token: human.token, personId: human.personId });
  if (!humanHolder.ok) {
    return refuse('MessagingUnavailable', humanHolder.error.message);
  }
  const appendSystemAction = options.recordSystemAction ?? recordSystemAction;

  // §9 migration: archive only views that are confidently demo-era legacy.
  // threadRef:null is the valid state before a fresh conversation's first send,
  // so its persisted address decides whether it remains usable. Older views
  // with no address are ambiguous and stay untouched: a missed legacy view is
  // recoverable; a wrongly archived fresh view is data loss.
  const listedThreads = await humanHolder.value.call((session) =>
    (session as { listThreadsForPerson(input: object): Promise<unknown> })
      .listThreadsForPerson({})) as {
    kind: string;
    value?: { threads: Array<{ id: string; direct?: { pair: string[] }; room?: unknown }> };
    error?: { name?: string; message?: string };
  };
  const configuredPeople = new Set(config.principals.map((principal) => principal.personId));
  const resolvableThreads = listedThreads.kind === 'ok' && listedThreads.value
    ? new Set(listedThreads.value.threads
      .filter((thread) =>
        thread.room !== undefined
        || (thread.direct?.pair.every((personId) => configuredPeople.has(personId)) ?? false))
      .map((thread) => thread.id))
    : null;
  if (!resolvableThreads) {
    console.error(
      `[nvk-server] legacy conversation classification could not list messaging threads: `
      + `${listedThreads.error?.name ?? 'Unknown'} ${listedThreads.error?.message ?? ''}`.trim(),
    );
  }

  const unavailableMessage =
    'This legacy conversation has no resolvable person or thread. It was archived; start a new conversation to send a message.';
  let archivedLegacy = 0;
  for (const view of conversationViews) {
    const hasThreadRef = view.threadRef?.kind === 'thread';
    const address = view.address?.trim();
    const personId = !hasThreadRef && address?.startsWith('person:')
      ? address.slice('person:'.length)
      : null;
    const addressedThreadId = !hasThreadRef && address?.startsWith('thread:')
      ? address.slice('thread:'.length)
      : null;
    const confidentlyUnresolvable = hasThreadRef
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
    if (!confidentlyUnresolvable) continue;

    const conversation = conversations.get(view.id)!;
    conversation.archived = true;
    conversation.address = '';
    delete conversation.threadId;
    conversation.unavailable = {
      code: 'ConversationUnavailable',
      message: unavailableMessage,
    };
    const migrationClientOpId = `op_conversation_migrate_archive_${view.id}`;
    if (!view.archived) {
      const migrated = await setConversationView(
        persistence.conversationViewDriver,
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

    const traced = await appendSystemAction(persistence.handle, {
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
      await transcript.topology.stop();
      await embedded.close();
      return {
        ok: false,
        error: {
          code: 'MigrationTraceFailed',
          message:
            `legacy conversation migration trace failed for ${view.id} `
            + `(${traced.error.code}): ${traced.error.message}`,
        },
      };
    }
  }
  note(
    6,
    'shell',
    `layout/settings ready, ${conversations.size} conversation view(s) hydrated; `
    + `${archivedLegacy} unresolvable legacy view(s) archived`,
  );

  const sessions = createProviderSessionRegistry(agentsCtx, options.processProbe ?? osProcessProbe);
  const sweep = await sessions.sweepOrphans();
  for (const error of sweep.errors) {
    console.error(`[nvk-server] orphan sweep registry patch failed (${error.code}): ${error.message}`);
  }
  note(7, 'sessions', `${holders.principals().length} holder(s); ${(await sessions.resumable()).length} resumable session(s); ${sweep.interrupted.length} interrupted, ${sweep.killed.length} orphan(s) reaped`);
  for (const interruption of sweep.interrupted) {
    const traced = await appendSystemAction(persistence.handle, {
      action: 'hook_log',
      target: { kind: 'providerSession', id: interruption.sessionId },
      clientOpId: `op_${randomUUID()}` as never,
      meta: { event: 'ReplyInterrupted', clientOpId: interruption.clientOpId },
    });
    if (!traced.ok) {
      console.error(`[nvk-server] ReplyInterrupted trace failed (${traced.error.code}): ${traced.error.message}`);
    }
  }

  const b2a = composeB2aServerCapabilities({
    root: options.root,
    principal: human.personId,
    messaging: {
      getDelivery: (input) => humanHolder.value.call((session) =>
        (session as MessageExistenceQuery).getDelivery(input)),
    },
  });
  const traceCapabilityBoot = async (
    capability: 'artifacts' | 'projects' | 'spine',
    target: { kind: 'artifact' | 'project' | 'spineStep'; id: string },
    meta: Record<string, unknown>,
  ): Promise<BootError | null> => {
    let traced: Awaited<ReturnType<typeof recordSystemAction>>;
    try {
      traced = await appendSystemAction(persistence.handle, {
        action: 'hook_log',
        target,
        clientOpId: `op_server_boot_${capability}_${randomUUID()}` as never,
        meta: {
          event: 'server.boot.capability',
          capability,
          ...meta,
        },
      });
    } catch (cause) {
      return {
        code: 'StoreUnavailable',
        message:
          `${capability} boot trace threw: `
          + `${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
    return traced.ok
      ? null
      : {
          code: 'StoreUnavailable',
          message:
            `${capability} boot trace failed (${traced.error.code}): `
            + traced.error.message,
        };
  };
  const failCapabilityBoot = async (
    error: BootError,
  ): Promise<BootResult> => {
    await transcript.topology.stop();
    await embedded.close();
    return { ok: false, error };
  };

  // ── 8. artifacts: maintenance precedes its successful boot trace ─────────
  const artifactSweep = await b2a.artifacts.boot.sweepOrphans();
  if (!artifactSweep.ok) {
    return failCapabilityBoot({
      code: 'StoreUnavailable',
      message:
        `artifacts boot failed (${artifactSweep.error.code}): `
        + artifactSweep.error.message,
    });
  }
  const artifactTraceError = await traceCapabilityBoot(
    'artifacts',
    { kind: 'artifact', id: 'server_boot_artifacts' },
    { sweptOrphans: artifactSweep.value.swept.length },
  );
  if (artifactTraceError) return failCapabilityBoot(artifactTraceError);
  note(
    8,
    'artifacts',
    `${artifactSweep.value.swept.length} orphan byte file(s) swept`,
  );

  // ── 9. projects: the ordinary and Spine-only doors share one host ────────
  const projectsTraceError = await traceCapabilityBoot(
    'projects',
    { kind: 'project', id: 'server_boot_projects' },
    {},
  );
  if (projectsTraceError) return failCapabilityBoot(projectsTraceError);
  note(9, 'projects', 'operations and Spine attachment contract ready');

  // ── 10. spine: discover accepted work; never continue it during boot ─────
  const pendingWorkflows = await b2a.spine.boot.scanWorkflows();
  if (!pendingWorkflows.ok) {
    return failCapabilityBoot({
      code: 'StoreUnavailable',
      message:
        `spine boot failed (${pendingWorkflows.error.code}): `
        + pendingWorkflows.error.message,
    });
  }
  const spineTraceError = await traceCapabilityBoot(
    'spine',
    { kind: 'spineStep', id: 'server_boot_spine' },
    { resumableWorkflows: pendingWorkflows.value.items.length },
  );
  if (spineTraceError) return failCapabilityBoot(spineTraceError);
  note(
    10,
    'spine',
    `${pendingWorkflows.value.items.length} resumable workflow(s) discovered; auto-continue disabled`,
  );

  // ── 11. supervision (B1b: the engine — gate, drift, lifecycle, usage) ───
  const watchdog: WatchdogHook = createWatchdogHook(options.watchdogDir ?? options.root);
  const usageReader = createUsageReader({
    ...(options.providerHome ? { home: options.providerHome } : {}),
    transcriptRoot: path.join(options.root, 'transcripts'),
    discoveryIntervalMs:
      Math.min(config.supervision.usageIntervalSec, config.supervision.driftIntervalSec) * 1000,
  });
  const usageLog = createUsageLog(options.root);
  // The registry is the engine's session truth; this adapts its record shape to
  // the narrow slice supervision reads plus its one owned backfill mutation.
  const supervisionSessions = {
    list: async (): Promise<SupervisionRecord[]> => (await sessions.list()) as SupervisionRecord[],
    get: async (id: string): Promise<SupervisionRecord | null> =>
      (await sessions.get(id)) as SupervisionRecord | null,
    close: async (id: string, status: 'closed' | 'exited') => {
      const res = await sessions.close(id, status);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
    recordUsage: async (
      id: string,
      usage: Parameters<ProviderSessionRegistry['recordUsage']>[1],
    ) => {
      const res = await sessions.recordUsage(id, usage);
      return res.ok ? { ok: true } : { ok: false, error: res.error };
    },
  };
  const supervisionTransport = createSupervisedTransport({
    agents: { sendToSession: (sessionId, input) => agents.sendToSession(sessionId as never, input) },
    runtimes: providerRuntimes,
    providerOf: async (sessionId) => (await sessions.get(sessionId))?.provider ?? null,
  });
  const supervision: SupervisionEngine = createSupervisionEngine({
    sessions: supervisionSessions,
    lifecycle: {
      closeSession: (sessionId) => agents.closeSession(sessionId as never),
      async spawnFresh(input) {
        const spawned = await agents.spawnAgent(input.agentId as never) as
          { ok: boolean; value?: { sessionId: string; model: string }; error?: { code?: string; message?: string } };
        if (!spawned.ok || !spawned.value) {
          return { ok: false, error: { code: spawned.error?.code ?? 'SpawnFailed', message: spawned.error?.message ?? 'spawn failed' } };
        }
        const resumed = Boolean(input.resumeFrom) && agents.reattachSession({
          sessionId: spawned.value.sessionId,
          agentId: input.agentId,
          provider: input.provider,
          providerConversationId: input.resumeFrom ?? null,
          model: spawned.value.model || 'cli-default',
          cwd: input.cwd,
        });
        const registered = await sessions.register({
          sessionId: spawned.value.sessionId, agentId: input.agentId,
          provider: input.provider, cwd: input.cwd,
          model: spawned.value.model || 'cli-default',
          providerConversationId: resumed ? input.resumeFrom ?? null : null,
        });
        if (!registered.ok) {
          return { ok: false, error: { code: registered.error.code, message: registered.error.message } };
        }
        return { ok: true, value: { ...spawned.value, resumed } };
      },
    },
    transport: supervisionTransport,
    usage: usageReader,
    trace: (input) => appendSystemAction(persistence.handle, {
      action: input.action,
      target: input.target as never,
      clientOpId: (input.clientOpId ?? `op_${randomUUID()}`) as never,
      ...(input.meta ? { meta: input.meta } : {}),
    }),
    broadcast: (name, data) => runtime.broadcast(name, data),
    async appendUsage(rows) {
      const failure = usageLog.append({ at: new Date().toISOString(), rows });
      if (failure) console.error(`[nvk-server] usage.jsonl append failed: ${failure}`);
    },
    async escalate(text) {
      // DEC-B1-12: escalation reaches Chris through messaging, on the lawful
      // holder path — never a console line he will never read.
      await humanHolder.value.call((s) => (s as { sendMessage(i: object): Promise<unknown> }).sendMessage({
        address: `person:${human.personId}`,
        body: { text: `⚠️ supervision: ${text}` },
        priority: 'normal',
        clientMessageId: `cmsg_${randomUUID()}`,
      }));
    },
    policy: config.supervision,
    // The gate demands the skills that are actually REGISTERED (DEC-S2-4's
    // provider-neutral registry). An empty registry means the gate still runs
    // and still demands the marker — it just has no paths to name, which is a
    // visible state rather than a silently skipped gate.
    skillPaths: await registeredSkillPaths(agents),
    onTraceFailure: (reason) => console.error(`[nvk-server] ${reason}`),
    onFailure: (failure) => console.error(
      `[nvk-server] supervision ${failure.operation} failed `
      + `(${failure.code}): ${failure.message}`,
    ),
  });
  note(11, 'supervision', `engine up — usage every ${config.supervision.usageIntervalSec}s, drift every ${config.supervision.driftIntervalSec}s; log at ${usageLog.filePath}; watchdog registry at ${watchdog.registryPath}`);

  // ── the runtime the WS methods operate on ───────────────────────────────
  const runtime: ServerRuntime = {
    root: options.root,
    cwd,
    human: { personId: human.personId, holder: humanHolder.value },
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
    conversations,
    configStore,
    config,
    focus: { app: 'messaging', ref: 'none' } as FocusSnapshot,
    broadcast: () => undefined, // replaced once the transport is listening
    holderForPerson: async (personId: string) => {
      const principal = configStore.current().principals.find((p) => p.personId === personId);
      if (!principal) return null;
      const holder = await holders.holderFor({ token: principal.token, personId });
      return holder.ok ? holder.value : null;
    },
    mintOpId: () => `op_${randomUUID()}`,
  };

  // Chris addresses every provisioned agent person; each agent person opens its
  // own door to Chris when it is provisioned (DEC-14, promoted from the demo).
  const others = config.principals.map((p) => p.personId).filter((id) => id !== human.personId);
  await humanHolder.value.call((s) => (s as { setContactPolicy(p: object): Promise<unknown> })
    .setContactPolicy({ allowlist: others, defaultRule: 'deny' }));

  // Provider turn accounting: the CLI conversation id is learned on the first
  // reply, and a completed turn clears inFlight (DEC-B1-6/§13 disposition 2).
  // B1b: every provider, not just kimi — a codex or claude turn that did not
  // clear inFlight would leave a live session looking permanently interrupted.
  const recordTurn = (record: ProviderTurnRecord): void => {
    void (async () => {
      const failures: string[] = [];
      if (record.cliSessionId) {
        try {
          const resumed = await sessions.recordResumeHandle(record.key, record.cliSessionId);
          if (!resumed.ok) failures.push(`recordResumeHandle ${resumed.error.code}: ${resumed.error.message}`);
        } catch (cause) {
          failures.push(`recordResumeHandle: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      try {
        const replied = await sessions.markReplied(record.key);
        if (!replied.ok) failures.push(`markReplied ${replied.error.code}: ${replied.error.message}`);
      } catch (cause) {
        failures.push(`markReplied: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (failures.length > 0) throw new Error(failures.join('; '));
    })().catch((cause) => {
      console.error(
        `[nvk-server] provider turn bookkeeping failed for ${record.key}: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  };
  for (const provider of Object.values(providerRuntimes)) provider?.onTurn(recordTurn);

  // A session that survived a restart ADOPTED its provider thread: the turns it
  // made before this process started are not ours to bill again. Sessions this
  // process spawns are declared implicitly (the reader bills them in full).
  for (const record of await sessions.resumable()) {
    if (record.providerConversationId) {
      usageReader.trackSession(record.sessionId, { threadPreexisting: true });
    }
  }

  // 7b: rebind sessions that outlived the last process — to their provider
  // runtime AND to their conversation, so a send after a restart reaches the
  // CLI instead of quietly going nowhere (DEC-B1-6).
  const restored = await restoreLiveSessions(runtime);
  if (restored > 0) note(7, 'sessions', `${restored} session(s) reattached to their conversations`);

  // ── 12. the B3 Runtime, on this process's own root ───────────────────────
  // Composed LAST of the capabilities, and deliberately after every path that
  // can still refuse the boot: a Runtime composed before one of those would
  // hold the machine's instance lease and its timers while the process walked
  // away from them.
  const b3Wire = await composeB3Wire({ ...(options.b3 ?? {}), root: options.root });
  note(12, 'runtime', `b3.* composed on ${b3Wire.runtime.dataRoot}`);

  // ── 13. HTTP + nvk-ws v1 ────────────────────────────────────────────────
  // ONE table. The Shell's boot methods and `b3.*` answer on the same socket,
  // because they answer the same page (A4/T-02). The b3 half is spelled by the
  // adapter, never here — a second spelling is how the headless host and the
  // backed Shell end up with different surfaces.
  const methods = { ...buildMethods(runtime), ...b3Wire.methods };
  const transport: RunningTransport = await startTransport({
    root: options.root,
    port: options.port,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    methods,
    artifacts: b2a.artifacts,
    // An Agent Run presenting its credential on this socket is identified as
    // ITSELF here too — the Shell's server is a lawful place for a spawned
    // Agent to call from, and a forged credential is refused rather than
    // downgraded to Chris.
    identifyCaller: b3Wire.identifyCaller,
    onDispatch: b3Wire.onDispatch,
    onDisconnect: b3Wire.onDisconnect,
  });
  runtime.broadcast = (name, data) => transport.broadcast(name, data);
  // The machine is claimed once the socket exists, for the reason the headless
  // host claims it: a second Runtime must never serve a request it is not
  // allowed to have served. A refused claim gives the port back.
  try {
    await b3Wire.serve(transport);
  } catch (cause) {
    await transport.close();
    await b3Wire.close();
    await embedded.close();
    return refuse('RuntimeUnavailable',
      `the B3 Runtime for ${options.root} refused to start: `
      + `${cause instanceof Error ? cause.message : String(cause)}`);
  }
  agents.subscribeAgentEvents((event) => transport.broadcast('presence', event));
  note(13, 'transport', `listening on ${transport.url} (nvk-ws v1, token-gated)`);
  if (config.transcript.ingest) transcript.topology.start();

  // The supervision timers start only once the socket exists — otherwise the
  // first usage broadcast would fire into the no-op broadcaster above.
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
        await transport.close();
        // Before messaging: the Runtime releases the machine's instance lease
        // on the way down, and a root whose lease outlived its process refuses
        // the next boot.
        await b3Wire.close();
        await embedded.close();
      },
    },
  };
}

/**
 * The absolute paths of every registered skill — what the gate demands an agent
 * read before it does any work. A skills registry that cannot be read yields an
 * empty list rather than a boot failure: the gate then demands the marker with
 * no paths to name, which is visible, instead of silently not running.
 */
async function registeredSkillPaths(agents: ReturnType<typeof createAgentsContract>): Promise<string[]> {
  const listed = await agents.listSkills() as
    { ok: boolean; value?: { items: Array<{ path?: string }> } };
  if (!listed.ok || !listed.value) return [];
  return listed.value.items
    .map((skill) => skill.path)
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
}

export type { MessagingSessionHolder };
