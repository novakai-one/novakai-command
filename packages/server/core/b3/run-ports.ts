/* eslint-disable max-lines -- Narrow Runtime adapters stay grouped at the composition seam. */

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
  b3err, b3fail, b3ok, deriveClientOpId, mintClientOpId, mintTraceCorrelationId,
  type AgentId, type AgentRunId, type B3Result, type CommandContext,
  type IsoUtc, type ProviderSessionId, type SystemCommandContext,
  type TerminalInputAttemptId,
} from '@novakai/foundation/contract';
import type {
  AgentsPort, ProviderPort, ProviderTurnInputAttemptFacts, RunCredentialPort,
  TerminalPort, TurnDeliveryStep,
} from '../../../agent-runtime/contract/index.js';
import type { GovernedAgentsContract } from '../../../agents/b3/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';
import type {
  LaunchAuthorityRegistrar,
} from '../../../terminal/adapters/pty-host/node-pty.js';
import { notificationTerminalPort } from './notification-terminal-port.js';

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

    async listChildRelationships(principal, parentAgentId) {
      return agents.listChildren(principal, parentAgentId);
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
        provider: registered.value.provider,
        providerConversationId: registered.value.providerConversationId,
        providerVersion: registered.value.providerVersion ?? 'unknown',
        providerNativeSessionId: registered.value.providerResumeHandle ?? '',
        discovered: registered.value.discovery.state === 'discovered',
      });
    },

    async getProviderSession(principal, providerSessionId) {
      const found = await agents.getProviderSession(principal, providerSessionId);
      if (!found.ok) return found;
      return b3ok({
        id: found.value.id,
        provider: found.value.provider,
        providerConversationId: found.value.providerConversationId,
        providerVersion: found.value.providerVersion ?? 'unknown',
        providerNativeSessionId: found.value.providerResumeHandle ?? '',
        discovered: found.value.discovery.state === 'discovered',
      });
    },

    continuationAllowed: (principal, input) => agents.continuationAllowed(principal, input),

    discoverAgentControls: (principal, input) =>
      agents.discoverAgentControls(principal, input),

    async applyAgentControl(context, input) {
      const outcome = await agents.applyAgentControl(context, input);
      if (!outcome.ok) return outcome;
      // The plan does not cross the port — its ID does. A Runtime that held the
      // whole replacement record could act on it without the caller asking,
      // which is exactly what §12.1 says a control must never do.
      if (outcome.value.kind === 'replacement-required') {
        return b3ok({
          kind: 'replacement-required',
          replacementPlanId: outcome.value.plan.id,
          proposedLaunchPlanId: outcome.value.plan.proposedLaunchPlanId,
        });
      }
      return b3ok(outcome.value);
    },

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
    ...notificationTerminalPort(terminal),
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
      // §3.2: one saga effect, one idempotency key, derived from the effect's
      // own name. The command's key belongs to the command — two turns of the
      // same gate sharing it makes the second turn a swallowed replay of the
      // first, which is how the work turn used to disappear.
      const step = (name: string): CommandContext => ({
        ...context, clientOpId: deriveClientOpId(`${input.effectKey}:${name}`),
      });
      const attached = await terminal.attachController(step('attach'), {
        terminalSessionId: input.terminalSessionId,
        controllerKind: 'operations',
        columns: RUNTIME_VIEWPORT.columns,
        rows: RUNTIME_VIEWPORT.rows,
      });
      if (!attached.ok) return attached;
      const submitted = await typeAsRuntime(terminal, step, {
        terminalSessionId: input.terminalSessionId,
        attachmentId: attached.value.id,
        keystrokes: input.keystrokes,
      });
      // Released whatever happened: a Runtime that kept the keyboard would lock
      // Chris out of a session it is not using.
      await terminal.detachController(step('detach'), {
        terminalSessionId: input.terminalSessionId,
        attachmentId: attached.value.id,
      });
      return submitted;
    },

    async prepareProviderTurnInput(input) {
      const prepared = await terminal.prepareProviderTurnInput(systemContext(), input);
      return prepared.ok ? b3ok(prepared.value) : prepared;
    },

    async executeProviderTurnInput(input) {
      const executed = await terminal.executeProviderTurnInput(systemContext(), input);
      return executed.ok ? b3ok(executed.value) : executed;
    },

    async cancelPreparedProviderTurnInput(input) {
      const cancelled = await terminal.cancelPreparedProviderTurnInput(systemContext(), input);
      return cancelled.ok ? b3ok(cancelled.value) : cancelled;
    },

    async getProviderTurnInputAttempt(input) {
      const found = await terminal.getProviderTurnInputAttempt(systemContext().principal, input);
      if (!found.ok && found.error.code === 'ProviderTurnSubmissionConflict') return b3ok(null);
      return found.ok ? b3ok(found.value) : found;
    },

    async listIncompleteProviderTurnInputAttempts(input) {
      const items: ProviderTurnInputAttemptFacts[] = [];
      let cursor: import('@novakai/foundation/contract').EventCursor | undefined;
      do {
        const listed = await terminal.listIncompleteProviderTurnInputAttempts(
          systemContext().principal, {
            ...input, ...(cursor === undefined ? {} : { cursor }), limit: 200,
          },
        );
        if (!listed.ok) return listed;
        items.push(...listed.value.items);
        cursor = listed.value.nextCursor;
      } while (cursor !== undefined);
      return b3ok(items);
    },

    quarantineProviderTurnInputAttempt: (input) =>
      terminal.system.quarantineProviderTurnInputAttempt(systemContext(), input),

    async settleProviderTurnCompletion(input) {
      return terminal.settleProviderTurnCompletion(systemContext(), input);
    },

    async closeProviderTurnBarrierUnproven(input) {
      return terminal.closeProviderTurnBarrierUnproven(systemContext(), input);
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

/**
 * The viewport the Runtime declares when it attaches to type a turn.
 *
 * It must match what the session was OPENED with, or attaching would resize the
 * PTY under the provider and re-wrap — or clip — the answer the gate is about
 * to read. See `MANAGED_VIEWPORT` in agent-runtime/core/runs-compose.ts for why
 * it is this wide.
 */
const RUNTIME_VIEWPORT = { columns: 400, rows: 40 } as const;

/** The beat between two keystrokes of one turn. */
async function pause(milliseconds: number): Promise<void> {
  await new Promise((settle) => {
    setTimeout(settle, milliseconds);
  });
}

/**
 * Acquire, type the whole turn, release. The lease is held across every
 * keystroke because they are ONE turn — releasing between the text and the key
 * that sends it would let another controller land a line in the middle of it.
 */
async function typeAsRuntime(
  terminal: TerminalContract,
  step: (name: string) => CommandContext,
  input: {
    readonly terminalSessionId: Parameters<TerminalContract['writeInput']>[1]['terminalSessionId'];
    readonly attachmentId: Parameters<TerminalContract['writeInput']>[1]['attachmentId'];
    readonly keystrokes: readonly TurnDeliveryStep[];
  },
): Promise<B3Result<{
  readonly confirmed: boolean;
  readonly terminalInputAttemptId: TerminalInputAttemptId;
  readonly submittedAt: IsoUtc;
}>> {
  const lease = await terminal.acquireInputLease(step('lease'), {
    terminalSessionId: input.terminalSessionId,
    attachmentId: input.attachmentId,
    mode: 'acquire-if-free',
    ttlMs: 60_000,
  });
  if (!lease.ok) return lease;
  // Where the input stream actually is, asked AFTER the lease is held so nobody
  // can move it between the question and the write (NVK-KIMI-025 repair 1, the
  // same class of bug as the B3a reattach). A hardcoded claim here is never
  // right: a live session's first sequence is 1, and every turn after the
  // provider's own startup banner is higher still — which is why EVERY governed
  // launch died at this line with `expected 0, actual 1`.
  const view = await terminal.getTerminalSession(
    systemContext().principal, input.terminalSessionId,
  );
  if (!view.ok) return view;
  let outcome: B3Result<{
    readonly confirmed: boolean;
    readonly terminalInputAttemptId: TerminalInputAttemptId;
    readonly submittedAt: IsoUtc;
  }> | null = null;
  let sequence = view.value.nextInputSequence;

  for (const [index, keystroke] of input.keystrokes.entries()) {
    const written = await terminal.writeInput(step(`write-${String(index)}`), {
      terminalSessionId: input.terminalSessionId,
      attachmentId: input.attachmentId,
      inputLeaseId: lease.value.id,
      leaseGeneration: lease.value.generation,
      expectedNextInputSequence: sequence,
      kindOfInput: 'message-delivery',
      // Exactly what the adapter gave, one step at a time. WHAT to type and
      // when is the provider adapter's business (`deliverTurn`), because it is
      // the only layer that knows what this CLI's composer does with a burst.
      // Each write gets its own idempotency key: sharing one would make every
      // keystroke after the first a swallowed replay of it (P0-1's lesson).
      utf8Text: keystroke.utf8Text,
    });
    if (!written.ok) {
      outcome = written;
      break;
    }
    sequence = written.value.inputSequence + 1;
    outcome = b3ok({
      confirmed: written.value.outcome !== 'submitted-unconfirmed',
      terminalInputAttemptId: written.value.id,
      submittedAt: written.value.createdAt,
    });
    if (keystroke.pauseMsAfter > 0) await pause(keystroke.pauseMsAfter);
  }

  await terminal.releaseInputLease(step('release'), {
    terminalSessionId: input.terminalSessionId,
    attachmentId: input.attachmentId,
    leaseId: lease.value.id,
    generation: lease.value.generation,
  });
  return outcome ?? b3fail(b3err(
    'ValidationFailed', 'a Runtime input turn must contain at least one delivery step',
    { operation: 'terminal.submitRuntimeInput' }, false,
  ));
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
