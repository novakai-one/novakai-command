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
  b3err, b3fail, b3ok, mintClientOpId, mintProviderSessionId, mintRuntimeEpochId,
  mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type AuthorityScope,
  type CommandContext, type ProviderSessionId, type RuntimeEpochId,
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
import type { AgentRunsContract } from '../contract/runs-api.js';
import type { RuntimeHostContract } from '../contract/types.js';
import { composeAgentRuns } from '../core/runs-compose.js';


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
  readonly runtime: AgentRunsContract;
  readonly agents: FakeAgents;
  readonly terminal: FakeTerminal;
  readonly providers: FakeProviders;
  readonly fence: FakeFence;
  readonly events: { kind: string; payload: Readonly<Record<string, unknown>> }[];
  readonly root: string;
  human(scopes?: readonly AuthorityScope[]): CommandContext;
  agentRun(agentRunId: AgentRunId, scopes?: readonly AuthorityScope[]): CommandContext;
  principal(): AuthenticatedPrincipal;
  close(): void;
}

export interface RunsRigOptions extends FakeAgentsOptions {
  readonly gateTimeoutMs?: number;
}

export function createRunsRig(options: RunsRigOptions = {}): RunsRig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-runs-'));
  const agents = createFakeAgents(options);
  const terminal = createFakeTerminal();
  const providers = createFakeProviders();
  const fence = createFakeFence();
  const events: RunsRig['events'] = [];

  const runtime = composeAgentRuns({
    root,
    dataRoot: path.join(root, 'stores'),
    agents,
    terminal,
    providers,
    credentials: fakeCredentials,
    fence,
    publish: (kind, payload) => { events.push({ kind, payload }); },
    gateTimeoutMs: options.gateTimeoutMs ?? 2_000,
  });

  const envelope = (principal: AuthenticatedPrincipal): CommandContext => ({
    principal,
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  });

  return {
    runtime, agents, terminal, providers, fence, events, root,
    human: (scopes = EVERY_SCOPE) => envelope({
      id: CHRIS, kind: 'human', verifiedScopes: scopes,
    }),
    agentRun: (agentRunId, scopes = EVERY_SCOPE) => envelope({
      id: 'agentRun_principal' as never, kind: 'agent-run', agentRunId, verifiedScopes: scopes,
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
