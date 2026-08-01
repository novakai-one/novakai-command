// Where Agent Runtime's ports meet the real capabilities.
//
// This is the only place the three of them are in the same file, and that is
// the design: Agent Runtime declares the narrow thing it needs, Agents and
// Terminal implement their own contracts, and the composition root translates.
// Neither capability imports the other, and the Runtime cannot reach past what
// it asked for — a Runtime holding the whole Agents contract could create a
// role profile, which the one-writer law forbids (§3.3).
//
// Because both sides are typed, drift is a compile error rather than a
// surprise: this file will not build if either contract moves.
import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type AgentId, type AgentRunId, type B3Result, type CommandContext,
  type ProviderSessionId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  AgentsPort, ProviderPort, RunCredentialPort, TerminalPort,
} from '../../../agent-runtime/contract/index.js';
import type { GovernedAgentsContract } from '../../../agents/b3/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';
import type {
  LaunchAuthorityRegistrar,
} from '../../../terminal/adapters/pty-host/node-pty.js';

const systemContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

/** Agents, narrowed to exactly what the Runtime is allowed to ask for. */
export function agentsPort(agents: GovernedAgentsContract): AgentsPort {
  return {
    authoriseSpawn: (principal, input) => agents.authoriseSpawn(principal, input),
    authoriseRunOperation: (principal, input) => agents.authoriseRunOperation(principal, input),

    async createAgentFromRole(context, input) {
      const created = await agents.createAgentFromRole(context, input);
      if (!created.ok) return created;
      return b3ok({ agent: created.value.agent });
    },

    async resolveLaunchPlan(context, input) {
      return agents.resolveLaunchPlan(context, input);
    },

    getLaunchPlan: (principal, launchPlanId) => agents.getLaunchPlan(principal, launchPlanId),
    getAgent: (principal, agentId) => agents.getAgent(principal, agentId),

    async listChildAgentIds(principal, parentAgentId) {
      const edges = await agents.listChildren(principal, parentAgentId);
      if (!edges.ok) return edges;
      return b3ok(edges.value.map((edge) => edge.childAgentId));
    },

    async parentAgentIdOf(principal, agentId) {
      const tree = await agents.getAgentTree(principal, {
        rootAgentId: agentId, direction: 'ancestors', maxDepth: 1,
      });
      if (!tree.ok) return tree;
      const node = tree.value.items.find((item) => item.agent.id === agentId);
      return b3ok(node?.relationship?.parentAgentId ?? null);
    },

    async issueDelegationGrant(context, input) {
      const issued = await agents.issueDelegationGrant(context, input);
      if (!issued.ok) return issued;
      return b3ok({ id: issued.value.id });
    },

    expireGrantsOfRun: (agentRunId) =>
      agents.expireGrantsOfRun(systemContext(), agentRunId),

    async registerProviderSession(input) {
      const registered = await agents.registerProviderSession(systemContext(), input);
      if (!registered.ok) return registered;
      return b3ok({
        id: registered.value.id,
        providerNativeSessionId: registered.value.providerResumeHandle ?? '',
        discovered: registered.value.discovery.state === 'discovered',
      });
    },

    async getProviderSession(principal, providerSessionId) {
      const found = await agents.getProviderSession(principal, providerSessionId);
      if (!found.ok) return found;
      return b3ok({
        id: found.value.id,
        providerNativeSessionId: found.value.providerResumeHandle ?? '',
        discovered: found.value.discovery.state === 'discovered',
      });
    },

    continuationAllowed: (principal, input) => agents.continuationAllowed(principal, input),

    async getControlReplacementPlan(principal, planId) {
      const found = await agents.getControlReplacementPlan(principal, planId);
      if (!found.ok) return found;
      return b3ok({
        agentId: found.value.agentId,
        expectedOldRunId: found.value.expectedOldRunId,
        proposedLaunchPlanId: found.value.proposedLaunchPlanId,
      });
    },
  };
}

/**
 * Terminal, narrowed the same way — plus the one thing the port needs that the
 * public Terminal contract deliberately does not offer a caller: typing as the
 * RUNTIME rather than as a controller. The Runtime attaches its own controller
 * for the duration of a turn and releases it, which is the only way to submit
 * input without inventing a second write path (§22's "Messaging delivery or
 * interrupt barrier only" for a system principal).
 */
export function terminalPort(
  terminal: TerminalContract, epochOf: () => string | null,
): TerminalPort {
  const runtimeEpoch = (): B3Result<string> => {
    const active = epochOf();
    if (active === null) {
      return b3fail(b3err('RuntimeUnavailable', 'no active runtime epoch',
        { reason: 'no-active-epoch' }, true));
    }
    return b3ok(active);
  };

  return {
    async openManagedTerminal(context, input) {
      const opened = await terminal.openManagedTerminal(context, {
        owner: { kind: 'agent-run', agentRunId: input.agentRunId },
        launchAuthorityRef: input.launchAuthorityRef,
        launchFingerprint: input.launchFingerprint,
        workingDirectory: input.workingDirectory,
        columns: input.columns,
        rows: input.rows,
      });
      if (!opened.ok) return opened;
      return b3ok({ id: opened.value.id, status: opened.value.status });
    },

    async submitRuntimeInput(context, input) {
      const attached = await terminal.attachController(context, {
        terminalSessionId: input.terminalSessionId,
        controllerKind: 'operations',
        columns: RUNTIME_VIEWPORT.columns,
        rows: RUNTIME_VIEWPORT.rows,
      });
      if (!attached.ok) return attached;
      const submitted = await typeAsRuntime(terminal, context, {
        terminalSessionId: input.terminalSessionId,
        attachmentId: attached.value.id,
        text: input.text,
      });
      // Released whatever happened: a Runtime that kept the keyboard would lock
      // Chris out of a session it is not using.
      await terminal.detachController(context, {
        terminalSessionId: input.terminalSessionId,
        attachmentId: attached.value.id,
      });
      return submitted;
    },

    async readOutputSoFar(principal, terminalSessionId) {
      let text = '';
      for await (const frame of terminal.readTerminalStream(principal, {
        terminalSessionId, replayOnly: true,
      })) {
        if (!frame.ok) return frame;
        if (frame.value.kind === 'bytes') {
          text += Buffer.from(frame.value.base64, 'base64').toString('utf8');
        }
      }
      return b3ok(text);
    },

    beginProviderTurn: (input) => terminal.system.beginProviderTurn(systemContext(), input),
    endProviderTurn: (input) => terminal.system.endProviderTurn(systemContext(), input),

    async interruptTurn(input) {
      const epoch = runtimeEpoch();
      if (!epoch.ok) return epoch;
      const outcome = await terminal.interruptTerminalTurn(systemContext(), {
        terminalSessionId: input.terminalSessionId,
        agentRunId: input.agentRunId,
        providerTurnId: input.providerTurnId,
        activityGeneration: input.activityGeneration,
        expectedRuntimeEpochId: input.expectedRuntimeEpochId,
      });
      if (!outcome.ok) return outcome;
      if (outcome.value.kind === 'barrier-committed') {
        return b3ok({ kind: 'barrier-committed', providerTurnId: outcome.value.providerTurnId });
      }
      if (outcome.value.kind === 'raced-with-completion') {
        return b3ok({ kind: 'raced-with-completion', providerTurnId: outcome.value.providerTurnId });
      }
      return b3ok({ kind: 'target-turn-not-active' });
    },

    async terminate(input) {
      const stopped = await terminal.terminateTerminal(systemContext(), {
        terminalSessionId: input.terminalSessionId,
        agentRunId: input.agentRunId,
        expectedRuntimeEpochId: input.expectedRuntimeEpochId,
        reason: input.reason,
      });
      return stopped.ok ? b3ok(null) : stopped;
    },

    async getTerminal(principal, terminalSessionId) {
      const view = await terminal.getTerminalSession(principal, terminalSessionId);
      if (!view.ok) return b3ok(null);
      return b3ok({ id: view.value.session.id, status: view.value.session.status });
    },
  };
}

const RUNTIME_VIEWPORT = { columns: 120, rows: 40 } as const;

/** Acquire, write, release. The lease is held for one turn and no longer. */
async function typeAsRuntime(
  terminal: TerminalContract,
  context: CommandContext,
  input: {
    readonly terminalSessionId: Parameters<TerminalContract['writeInput']>[1]['terminalSessionId'];
    readonly attachmentId: Parameters<TerminalContract['writeInput']>[1]['attachmentId'];
    readonly text: string;
  },
): Promise<B3Result<{ readonly confirmed: boolean }>> {
  const lease = await terminal.acquireInputLease(context, {
    terminalSessionId: input.terminalSessionId,
    attachmentId: input.attachmentId,
    mode: 'acquire-if-free',
    ttlMs: 60_000,
  });
  if (!lease.ok) return lease;
  const written = await terminal.writeInput(context, {
    terminalSessionId: input.terminalSessionId,
    attachmentId: input.attachmentId,
    inputLeaseId: lease.value.id,
    leaseGeneration: lease.value.generation,
    expectedNextInputSequence: 0,
    kindOfInput: 'message-delivery',
    utf8Text: input.text,
  });
  await terminal.releaseInputLease(context, {
    terminalSessionId: input.terminalSessionId,
    attachmentId: input.attachmentId,
    leaseId: lease.value.id,
    generation: lease.value.generation,
  });
  if (!written.ok) return written;
  return b3ok({ confirmed: written.value.outcome !== 'submitted-unconfirmed' });
}

export type { ProviderPort, RunCredentialPort };

/**
 * How a spawned Agent authenticates as ITSELF (DEC-B3V4-05).
 *
 * The Runtime hands the child its Run id and an HMAC of it under a secret that
 * never leaves this machine. The transport re-derives and compares, so identity
 * comes from something the child was GIVEN rather than something it claimed —
 * and nothing durable has to be written to make it work.
 */
export function createRunCredentials(root: string): RunCredentialPort {
  const secret = runtimeSecret(root);
  const sign = (agentRunId: AgentRunId): string =>
    createHmac('sha256', secret).update(agentRunId, 'utf8').digest('hex');
  return {
    issue: (agentRunId) => ({
      NVK_AGENT_RUN_ID: agentRunId,
      NVK_AGENT_RUN_TOKEN: sign(agentRunId),
    }),
    verify: (agentRunId, token) => token !== '' && token === sign(agentRunId),
  };
}

/**
 * Runtime-private, under `.novakai/runtime/` (§18.3). Not a durable domain
 * record: if it is lost, every child simply has to be re-issued, which is what
 * a Runtime restart does anyway.
 */
function runtimeSecret(root: string): string {
  const file = path.join(root, 'runtime', 'run-credential-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(path.dirname(file), { recursive: true });
  const minted = createHmac('sha256', `${root}:${String(process.pid)}:${String(Date.now())}`)
    .update('nvk-run-credentials').digest('hex');
  writeFileSync(file, `${minted}\n`, { mode: 0o600 });
  return minted;
}

export type { AgentId, AgentRunId, ProviderSessionId };
