// The rig every Run suite is built on.
//
// Persistence is REAL — a Foundation store in a temp directory — because the
// behaviour under test is durable behaviour. The three ports are fakes, and
// that is the point: every failure this slice must survive is a port answering
// differently. A crash is "the store stops accepting writes at stage N". A
// stale epoch is "the fence says no". A substituted session is "discovery
// returns a different id". None of them needs a mocked internal.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentRunPrincipalId, b3err, b3fail, b3ok, mintClientOpId, mintProviderSessionId,
  mintRuntimeEpochId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type AuthorityScope,
  type B3Result, type CommandContext, type ProviderSessionId, type RuntimeEpochId,
  type TranscriptBindingId,
} from '@novakai/foundation/contract';
import type { LaunchPlanFacts, RunCredentialPort } from '../contract/ports.js';
import {
  createFakeAgents, CHRIS, EVERY_SCOPE,
  type FakeAgents, type FakeAgentsOptions,
} from './runs-agents-fake.js';
import {
  createFakeProviders, createFakeTerminal,
  type FakeProviders, type FakeTerminal,
} from './runs-fakes.js';
import type { RunUsageLookup } from '../contract/runs-api.js';
import type { RuntimeHostContract } from '../contract/types.js';
import type { RunWatcherPort } from '../contract/custody-ports.js';
import { composeAgentRuns, type ComposedAgentRuns } from '../core/runs-compose.js';
import {
  createFakeMessagingEndpoints, createFakeTranscriptCustody,
  type FakeMessagingEndpoints, type FakeTranscriptCustody,
} from './runs-b3c-fakes.js';
import { createRunsStore, type RunsStore } from '../core/runs-store.js';
import {
  createFakeNotificationDelivery, type FakeNotificationDelivery,
} from './runs-notification-fake.js';


// ── The fence and the credentials ───────────────────────────────────────────

export type FakeFence = RuntimeHostContract['fence'] & {
  epochId: RuntimeEpochId;
  /** Turn the fence off, so a stale process's mutations are refused. */
  stale: boolean;
};

export function createFakeFence(): FakeFence {
  const fence: FakeFence = {
    epochId: mintRuntimeEpochId(),
    stale: false,
    activeEpochId: () => (fence.stale ? null : fence.epochId),
    assertActive: (epochId) => {
      if (fence.stale) {
        return b3fail(b3err('StaleRuntimeEpoch', 'this process no longer owns the runtime',
          { received: epochId ?? null, active: null }, true));
      }
      if (epochId !== undefined && epochId !== fence.epochId) {
        return b3fail(b3err('StaleRuntimeEpoch', 'that epoch is no longer active',
          { received: epochId, active: fence.epochId }, true));
      }
      return b3ok(fence.epochId);
    },
  };
  return fence;
}

export const fakeCredentials: RunCredentialPort = {
  issue: (agentRunId) => ({ NVK_AGENT_RUN_ID: agentRunId, NVK_AGENT_RUN_TOKEN: 'token' }),
  verify: () => true,
};

// ── The rig ─────────────────────────────────────────────────────────────────

export interface RunsRig {
  readonly runtime: ComposedAgentRuns;
  readonly agents: FakeAgents;
  readonly terminal: FakeTerminal;
  readonly providers: FakeProviders;
  readonly fence: FakeFence;
  readonly messagingEndpoint: FakeMessagingEndpoints;
  readonly transcriptCustody: FakeTranscriptCustody;
  readonly notifications: FakeNotificationDelivery;
  readonly events: { kind: string; payload: Readonly<Record<string, unknown>> }[];
  readonly root: string;
  human(scopes?: readonly AuthorityScope[]): CommandContext;
  agentRun(agentRunId: AgentRunId, scopes?: readonly AuthorityScope[]): CommandContext;
  principal(): AuthenticatedPrincipal;
  close(): void;
}

export interface RunsRigOptions extends FakeAgentsOptions {
  readonly watchers?: RunWatcherPort;
  readonly usage?: RunUsageLookup;
  readonly gateTimeoutMs?: number;
  /**
   * Stop accepting durable writes after N of them — a crash, modelled as what a
   * crash actually looks like from inside the operation. A rig built on the
   * SAME root afterwards is the restarted process.
   */
  readonly crashAfterWrites?: number;
  /** Reuse a root, so a "restart" reads what the dead attempt left behind. */
  readonly root?: string;
  /**
   * Reuse the live ports.
   *
   * `crashAfterWrites` models a STORE that stopped accepting writes — a full
   * disk, a lock timeout — while the process and its PTY lived on. A retry in
   * that world can still see what the session printed, which is what §13.5's
   * "retry observes transcript before sending again" depends on. Handing the
   * retry a blank terminal would model a different failure (the whole Runtime
   * dying, where the PTY goes with it) and answer it with the wrong mechanism.
   */
  readonly agents?: FakeAgents;
  readonly terminal?: FakeTerminal;
  readonly providers?: FakeProviders;
  /**
   * Compose WITHOUT the B3c capability ports, to prove the honest branch: a
   * host with no Messaging or Transcript records those rungs `not-needed` with
   * a reason naming the absent capability, rather than pretending.
   */
  readonly withoutB3cCapabilities?: boolean;
  /**
   * Shared across a crash/restart for the same reason `agents` and `terminal`
   * are: Messaging's claims and Transcript's bindings live on disk in
   * production, so a restarted Runtime finds the claim its dying attempt
   * reserved. A fresh fake per restart would model a capability that forgets,
   * which no real one does.
   */
  readonly messagingEndpoint?: FakeMessagingEndpoints;
  readonly transcriptCustody?: FakeTranscriptCustody;
  readonly notifications?: FakeNotificationDelivery;
}

export function createRunsRig(options: RunsRigOptions = {}): RunsRig {
  const root = options.root ?? mkdtempSync(path.join(tmpdir(), 'nvk-b3b-runs-'));
  const agents = options.agents ?? createFakeAgents(options);
  const terminal = options.terminal ?? createFakeTerminal();
  // The scripted agent is told what its role pins, from the same source the
  // role is built from — so its reply is evidence, not the prompt read back.
  terminal.pinnedTokens = (options.skills ?? [{ id: 'tdd', version: 1, digest: 'digest-tdd' }])
    .map((skill) => `${skill.id}@v${String(skill.version)}#${skill.digest}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const providers = options.providers ?? createFakeProviders();
  const messagingEndpoint = options.messagingEndpoint ?? createFakeMessagingEndpoints();
  const transcriptCustody = options.transcriptCustody ?? createFakeTranscriptCustody();
  const notifications = options.notifications ?? createFakeNotificationDelivery();
  const fence = createFakeFence();
  const events: RunsRig['events'] = [];

  const storeOptions = { root, dataRoot: path.join(root, 'stores') };
  const runtime = composeAgentRuns({
    ...storeOptions,
    ...(options.crashAfterWrites === undefined
      ? {}
      : { store: crashingStore(createRunsStore(storeOptions), options.crashAfterWrites) }),
    agents,
    terminal,
    providers,
    credentials: fakeCredentials,
    fence,
    publish: (kind, payload) => { events.push({ kind, payload }); },
    gateTimeoutMs: options.gateTimeoutMs ?? 2_000,
    ...(options.withoutB3cCapabilities === true
      ? {} : { messagingEndpoint, transcriptCustody }),
    ...(options.withoutB3cCapabilities === true
      ? {}
      : {
          async transcriptBinding(agentRunId: AgentRunId) {
            const binding = transcriptCustody.bindings.find(
              (item) => item.agentRunId === String(agentRunId),
            );
            return binding === undefined ? null : {
              bindingId: binding.id as TranscriptBindingId,
              bindingState: 'bound' as const,
              ...(binding.mirrorWatermark === undefined
                ? {}
                : { mirrorWatermark: binding.mirrorWatermark }),
            };
          },
        }),
    ...(options.watchers === undefined ? {} : { watchers: options.watchers }),
    notifications,
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });

  const envelope = (principal: AuthenticatedPrincipal): CommandContext => ({
    principal,
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  });

  return {
    runtime, agents, terminal, providers, fence, events, root,
    messagingEndpoint, transcriptCustody, notifications,
    human: (scopes = EVERY_SCOPE) => envelope({
      id: CHRIS, kind: 'human', verifiedScopes: scopes,
    }),
    agentRun: (agentRunId, scopes = EVERY_SCOPE) => envelope({
      // Derived exactly as the server derives it (see `agentRunPrincipalId`).
      id: agentRunPrincipalId(agentRunId), kind: 'agent-run', agentRunId, verifiedScopes: scopes,
    }),
    principal: () => ({ id: CHRIS, kind: 'human', verifiedScopes: EVERY_SCOPE }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** The confirmation a well-behaved agent replies with, for a scripted terminal. */
export function confirmationFor(plan: LaunchPlanFacts): string {
  const tokens = plan.skills
    .map((skill) => `${skill.id}@v${String(skill.version)}#${skill.digest}`)
    .sort();
  return `SKILLS-CONFIRMED: ${JSON.stringify(tokens)}`;
}

export const reservationOf = (): ProviderSessionId => mintProviderSessionId();

export {
  createFakeProviders, createFakeTerminal,
  type FakeProviders, type FakeTerminal, type ScriptedReply,
} from './runs-fakes.js';

export {
  createFakeAgents, CHRIS, EVERY_SCOPE,
  type FakeAgents, type FakeAgentsOptions,
} from './runs-agents-fake.js';

/**
 * A store that dies after N durable writes.
 *
 * Reads keep working, because a crashed process leaves its FILES intact — what
 * stops is this process's ability to append. That is the shape recovery has to
 * cope with; a store that also stopped reading would be a different and easier
 * problem.
 */
function crashingStore(real: RunsStore, afterWrites: number): RunsStore {
  let written = 0;
  const dead = (): B3Result<never> => b3fail(b3err('StoreUnavailable',
    'the runtime process died mid-operation', { owner: 'agent-runtime', cause: 'crash' }, true));
  return {
    async create(principal, payload, clientOpId) {
      written += 1;
      if (written > afterWrites) return dead();
      return real.create(principal, payload, clientOpId);
    },
    async update(principal, id, patch, expectedVersion, clientOpId) {
      written += 1;
      if (written > afterWrites) return dead();
      return real.update(principal, id, patch, expectedVersion, clientOpId);
    },
    read: (kind, id) => real.read(kind, id),
    list: (kind, filter) => real.list(kind, filter),
  };
}
