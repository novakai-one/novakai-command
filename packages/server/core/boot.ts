// packages/server/core/boot.ts — THE composition root (DEC-B1-1/DEC-B1-2).
//
// One persistent process boots, in dependency order, with a trace line per step
// (FND-005 pattern — a boot step is never silent):
//
//   1 config          2 foundation store   3 messaging (authority from config)
//   4 agents+providers 5 transcript        6 shell persistence
//   7 session layer + providerSession registry + orphan sweep
//   8 supervision (B1a: watchdog hook)     9 HTTP + nvk-ws v1
//
// It replaces packages/shell/demo/bridge.ts. Everything the demo PROVED is
// promoted; everything the demo HACKED (hardcoded tokens, person pools, code
// seeding, unauthenticated socket) is gone.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as messaging from '../../messaging/public/index.js';
import type { PersonId } from '../../messaging/public/index.js';
import {
  composeAgents, createAgentsContract, createKimiCliRuntime, createProviderSessionRegistry,
  defaultKimiCliPath, osProcessProbe,
  type KimiCliRuntime, type LiveLaneSender, type ProcessProbe, type ProviderSessionRegistry,
} from '../../agents/contract/index.js';
import { composeShellPersistence } from '../../shell/contract/persistence.node.js';
import { listConversationViews } from '../../shell/contract/conversationView.js';
import type { ScreenContext } from '../../shell/contract/context.js';
import { createTranscriptWatcher, defaultSources } from '../../transcript/contract/index.js';
import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import { openConfigStore, type ConfigStore } from './config/store.js';
import type { ServerConfig } from '../contract/config.js';
import { createSessionHolderFactory, type MessagingSessionHolder, type SessionHolderFactory } from './session/holders.js';
import { createLiveAuthority } from './session/authority.js';
import { createWatchdogHook, type WatchdogHook } from './supervision/watchdog.js';
import { startTransport, type RunningTransport } from './transport/server.js';
import { buildMethods, restoreLiveSessions, type ServerRuntime, type Conversation } from './methods.js';

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
  /** Directory holding `.watchdog-sessions.json`. Defaults to cwd. */
  watchdogDir?: string;
  processProbe?: ProcessProbe;
  transcripts?: boolean;
  /** @internal failure-injection seam for never-silent trace tests. */
  recordSystemAction?: typeof recordSystemAction;
}

export interface BootStep {
  step: number;
  name: string;
  detail: string;
}

export interface BootError {
  code: 'ConfigUnavailable' | 'NoHumanPrincipal' | 'MessagingUnavailable' | 'StoreUnavailable';
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
  config: ServerConfig;
  /** @internal exposed so tests can drive methods without a socket. */
  runtime: ServerRuntime;
  close(): Promise<void>;
}

export type BootResult =
  | { ok: true; value: NovakaiServer }
  | { ok: false; error: BootError };

const HUMAN_ROLE = 'Human';
const MINT_RUNBOOK =
  'run: npx tsx packages/server/cli/nvk-token.ts mint person_chris --grants layout,settings,conversationView --roles Human';

export async function bootServer(options: BootOptions): Promise<BootResult> {
  const steps: BootStep[] = [];
  const note = (step: number, name: string, detail: string): void => {
    steps.push({ step, name, detail });
    console.log(`[nvk-server] ${step}/9 ${name}: ${detail}`);
  };
  const cwd = options.cwd ?? process.cwd();

  // ── 1. config ────────────────────────────────────────────────────────────
  const opened = await openConfigStore({ root: options.root, principal: 'sys_spine' });
  if (!opened.ok) {
    return { ok: false, error: { code: 'ConfigUnavailable', message: opened.error.message } };
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
        message: `no principal with role "${HUMAN_ROLE}" in ${path.join(options.root, 'config.jsonl')} — ${MINT_RUNBOOK}`,
      },
    };
  }

  // ── 2. foundation store ──────────────────────────────────────────────────
  const persistence = composeShellPersistence({ root: options.root, principal: human.personId });
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
  const kimiCliPath = options.kimiCliPath ?? defaultKimiCliPath();
  const kimiRuntime: KimiCliRuntime = createKimiCliRuntime({ cwd, cliPath: kimiCliPath });
  const agentsCtx = composeAgents({
    root: options.root,
    principal: human.personId,
    providerRuntimes: { kimi: kimiRuntime },
    allowMock: config.dev.allowMock,
    cwd,
  });
  const agents = createAgentsContract(agentsCtx);
  note(4, 'agents', `providers: kimi=${kimiRuntime.isAvailable() ? kimiCliPath : 'CLI NOT FOUND'}, claude/codex=B1b, mock=${config.dev.allowMock ? 'dev' : 'disabled'}`);

  // ── 5. transcript watchers ───────────────────────────────────────────────
  // Config decides (see DevConfigInput.watchTranscripts): the S2 watcher scans
  // synchronously, so at real transcript volume it would starve this process's
  // HTTP loop. The step still runs and still traces either way.
  let transcripts: { stop(): void } | null = null;
  const watchTranscripts = options.transcripts ?? config.dev.watchTranscripts;
  if (watchTranscripts) {
    const sources = defaultSources();
    const watcher = createTranscriptWatcher({ root: options.root, sources });
    watcher.start();
    transcripts = watcher;
    note(5, 'transcript', `watching ${sources.length} provider dir(s)`);
  } else {
    note(5, 'transcript', 'watchers disabled (config dev.watchTranscripts) — synchronous S2 scan would starve the HTTP loop; ingestion lands in B1b/S3');
  }

  // ── 6. shell persistence (composed at step 2; hydrate the view cache) ────
  const conversations = new Map<string, Conversation>();
  for (const view of await listConversationViews(persistence.conversationViewDriver)) {
    conversations.set(view.id, {
      id: view.id,
      address: view.threadRef?.kind === 'thread' ? `thread:${view.threadRef.id}` : '',
      title: view.titleOverride ?? view.id,
      kind: 'agent',
      pinned: view.pinned,
      archived: view.archived,
      lastActivityAt: view.lastActivityAt,
      ...(view.threadRef?.kind === 'thread' ? { threadId: view.threadRef.id } : {}),
    });
  }
  note(6, 'shell', `layout/settings ready, ${conversations.size} conversation view(s) hydrated`);

  // ── 7. session layer + providerSession registry + orphan sweep ───────────
  // The factory takes the capability, not a plucked function: the server's ONLY
  // `.authenticate` call site is inside holders.ts (red gate 5, architecture-tested).
  const holders: SessionHolderFactory = createSessionHolderFactory({ messaging: embedded as never });
  const humanHolder = await holders.holderFor({ token: human.token, personId: human.personId });
  if (!humanHolder.ok) {
    return { ok: false, error: { code: 'MessagingUnavailable', message: humanHolder.error.message } };
  }
  const sessions = createProviderSessionRegistry(agentsCtx, options.processProbe ?? osProcessProbe);
  const sweep = await sessions.sweepOrphans();
  for (const error of sweep.errors) {
    console.error(`[nvk-server] orphan sweep registry patch failed (${error.code}): ${error.message}`);
  }
  note(7, 'sessions', `${holders.principals().length} holder(s); ${(await sessions.resumable()).length} resumable session(s); ${sweep.interrupted.length} interrupted, ${sweep.killed.length} orphan(s) reaped`);
  const appendSystemAction = options.recordSystemAction ?? recordSystemAction;
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

  // ── 8. supervision (B1a: the watchdog hook) ─────────────────────────────
  const watchdog: WatchdogHook = createWatchdogHook(options.watchdogDir ?? cwd);
  note(8, 'supervision', `watchdog registry at ${watchdog.registryPath} (drift check-ins + usage table land in B1b)`);

  // ── the runtime the WS methods operate on ───────────────────────────────
  const runtime: ServerRuntime = {
    root: options.root,
    cwd,
    human: { personId: human.personId, holder: humanHolder.value },
    holders,
    agents,
    kimiRuntime,
    sessions,
    watchdog,
    persistence,
    conversations,
    configStore,
    config,
    focus: { app: 'messaging', ref: 'none' } as ScreenContext,
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
  kimiRuntime.onTurn((record) => {
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
  });

  // 7b: rebind sessions that outlived the last process — to their provider
  // runtime AND to their conversation, so a send after a restart reaches the
  // CLI instead of quietly going nowhere (DEC-B1-6).
  const restored = await restoreLiveSessions(runtime);
  if (restored > 0) note(7, 'sessions', `${restored} session(s) reattached to their conversations`);

  // ── 9. HTTP + nvk-ws v1 ─────────────────────────────────────────────────
  const methods = buildMethods(runtime);
  const transport: RunningTransport = await startTransport({
    root: options.root,
    port: options.port,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    methods,
  });
  runtime.broadcast = (name, data) => transport.broadcast(name, data);
  agents.subscribeAgentEvents((event) => transport.broadcast('presence', event));
  note(9, 'transport', `listening on ${transport.url} (nvk-ws v1, token-gated)`);

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
      get config() { return configStore.current(); },
      runtime,
      async close() {
        configWatcher.close();
        transcripts?.stop();
        await transport.close();
        await embedded.close();
      },
    },
  };
}

export type { MessagingSessionHolder };
