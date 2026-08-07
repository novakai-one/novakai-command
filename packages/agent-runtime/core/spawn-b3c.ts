// The three B3c rungs of the spawn ladder, and the four of the continuation
// ladder — §13.5 rows 6/9/10, §13.6.
//
// These shipped as `not-needed: B3c` while B3c itself shipped. Three
// independent verifiers found the same consequence: `getAgentEndpoint` returned
// `claim: null` for a live governed Agent, `getBinding` returned
// `UnknownAgentRun`, and the terminal half of "messages are messages" had no
// reachable surface at all — because the mirror runs off a binding nothing ever
// created.
//
// Every function here is re-entrant the same way the rest of the ladder is: it
// asks the journal whether its stage already completed before it does anything,
// so a resumed command adopts the claim or binding its earlier attempt made
// rather than minting a second one.
import {
  b3fail, b3ok,
  type AgentId, type B3Result, type CommandContext, type HumanPrincipalId,
} from '@novakai/foundation/contract';
import type { AgentRun, RunOperation } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import { advance, completed } from './journal.js';

/**
 * What a host WITHOUT a given capability records instead of the stage.
 *
 * This is the honest form of the deferral the slice failed on. "B3c" was a lie
 * once B3c shipped; "no Messaging capability is composed in this host" is a
 * checkable statement about the host, and the production composition — which
 * composes both — can never produce it.
 */
const NOT_COMPOSED = {
  messaging: 'no Messaging capability is composed in this host',
  transcript: 'no Transcript capability is composed in this host',
} as const;

/** A stage whose owner exists, recorded against the object that owner made. */
async function record(
  core: RunsCore,
  operation: RunOperation,
  stage: RunOperation['currentStage'],
  owner: 'messaging' | 'transcript',
  ownerObjectId: string,
): Promise<B3Result<RunOperation>> {
  return advance(core, operation, { stage, owner, ownerObjectId });
}

/** A stage whose owning capability this host does not have. */
async function absent(
  core: RunsCore,
  operation: RunOperation,
  stage: RunOperation['currentStage'],
  owner: 'messaging' | 'transcript',
): Promise<B3Result<RunOperation>> {
  return advance(core, operation, {
    stage, owner, outcome: 'not-needed', notNeededBecause: NOT_COMPOSED[owner],
  });
}

export interface EndpointReservation {
  readonly operation: RunOperation;
  /** Absent when this host composes no Messaging. */
  readonly claimId?: string;
  readonly threadId?: string;
}

/**
 * §13.5 row 6 — "Messaging claim is reserved; queue may accept, no delivery."
 *
 * SURFACED SPEC TENSION, decided rather than hidden. §12.5's
 * `ReserveAgentEndpointInput` and §8.1's `AgentEndpointClaim` both require a
 * `TerminalSessionId`, and no published Terminal surface mints one before
 * `openManagedTerminal`. Pass 1 line 503 puts this row before the terminal row.
 * The two cannot both hold literally.
 *
 * Resolution: reserve as soon as the terminal session id exists, which is
 * still strictly before any provider input can exist — the skills-gate turn is
 * the first, and it comes several rungs later. The cost is that this row lands
 * after `terminal-live` in `completedStages` rather than before it. No contract
 * was reshaped to hide the difference.
 */
export async function reserveEndpoint(
  core: RunsCore,
  input: {
    readonly agentRun: AgentRun;
    readonly agentId: AgentId;
    readonly rootHumanPrincipalId: HumanPrincipalId;
    readonly operation: RunOperation;
  },
): Promise<B3Result<EndpointReservation>> {
  const messaging = core.messagingEndpoint;
  if (messaging === undefined) {
    const recorded = await absent(core, input.operation, 'endpoint-reserved', 'messaging');
    return recorded.ok ? b3ok({ operation: recorded.value }) : recorded;
  }

  const thread = await messaging.ensureAgentThread({
    agentId: input.agentId, rootHumanPrincipalId: input.rootHumanPrincipalId,
  });
  if (!thread.ok) return thread;

  // Resume: an earlier attempt that already reserved recorded the claim id it
  // got. Reserving again would fail the generation CAS and strand a spawn that
  // had already done the work.
  const earlier = completed(input.operation, 'endpoint-reserved');
  if (earlier?.ownerObjectId !== undefined) {
    return b3ok({
      operation: input.operation,
      claimId: earlier.ownerObjectId,
      threadId: thread.value.threadId,
    });
  }

  const current = await messaging.currentEndpoint(input.agentId);
  if (!current.ok) return current;
  const terminalSessionId = input.agentRun.terminalSessionId;
  if (terminalSessionId === undefined) {
    return b3fail({
      code: 'RecoveryRequired',
      message: 'the Run reached the endpoint stage with no terminal session to claim',
      details: {
        operationId: input.operation.id,
        stage: 'endpoint-reserved',
        reason: 'effect-outcome-uncertain',
      },
      retryable: true,
    });
  }

  const reserved = await messaging.reserve({
    agentId: input.agentId,
    agentRunId: input.agentRun.id,
    terminalSessionId,
    expectedEndpointGeneration: current.value.endpointGeneration,
  });
  if (!reserved.ok) return reserved;

  const recorded = await record(
    core, input.operation, 'endpoint-reserved', 'messaging', reserved.value.claimId,
  );
  if (!recorded.ok) return recorded;
  return b3ok({
    operation: recorded.value,
    claimId: reserved.value.claimId,
    threadId: thread.value.threadId,
  });
}

/** §13.5 row 9 — "Transcript returns binding; a waiting source is valid." */
export async function bindTranscript(
  core: RunsCore,
  input: {
    readonly agentRun: AgentRun;
    readonly agentId: AgentId;
    readonly provider: 'claude' | 'codex' | 'kimi';
    readonly threadId?: string;
    readonly operation: RunOperation;
  },
): Promise<B3Result<RunOperation>> {
  const transcript = core.transcriptCustody;
  // A binding with no Thread cannot mirror a single turn, so a host that could
  // not produce one records the stage as un-owned rather than writing custody
  // that points nowhere.
  if (transcript === undefined || input.threadId === undefined) {
    return absent(core, input.operation, 'transcript-bound', 'transcript');
  }
  const bound = await transcript.bind({
    agentId: input.agentId,
    agentRunId: input.agentRun.id,
    provider: input.provider,
    providerSessionId: input.agentRun.providerSessionId,
    threadId: input.threadId,
  });
  if (!bound.ok) return bound;
  return record(core, input.operation, 'transcript-bound', 'transcript', bound.value.bindingId);
}

/**
 * §13.6's transcript half — the continued Run's OWN custody.
 *
 * A continuation is a new provider context with a new ProviderSession, so it
 * needs its own binding for exactly the reason a fresh spawn does: the mirror
 * reads the session's file, and the superseded Run's binding names the
 * superseded file. The continuation ladder drained, finalised and transferred
 * and never bound, so the moment an Agent was continued its LIVE Run had no
 * transcript custody at all — while the retired Run's binding read back
 * perfectly, which is what made the gap easy to miss.
 *
 * It reuses `bindTranscript` rather than repeating it, and resolves the Thread
 * the same way the spawn ladder does: a continuation continues a conversation,
 * so `ensureAgentThread` returns the one the Agent already has.
 */
export async function bindContinuedTranscript(
  core: RunsCore,
  context: CommandContext,
  input: {
    readonly agentRun: AgentRun;
    readonly agentId: AgentId;
    readonly provider: 'claude' | 'codex' | 'kimi';
    readonly operation: RunOperation;
  },
): Promise<B3Result<RunOperation>> {
  const messaging = core.messagingEndpoint;
  if (messaging === undefined) {
    return absent(core, input.operation, 'transcript-bound', 'transcript');
  }
  // The Agent record is where the root human lives, and the root human is what
  // resolves the Thread. Read here rather than passed in: a continuation
  // ordered by a supervising Agent must land in the conversation Chris's spawn
  // created, not a second one keyed on whoever ordered the restart.
  const agent = await core.agents.getAgent(context.principal, input.agentId);
  if (!agent.ok) return agent;
  const thread = await messaging.ensureAgentThread({
    agentId: input.agentId, rootHumanPrincipalId: agent.value.rootHumanPrincipalId,
  });
  if (!thread.ok) return thread;
  return bindTranscript(core, {
    agentRun: input.agentRun,
    agentId: input.agentId,
    provider: input.provider,
    threadId: thread.value.threadId,
    operation: input.operation,
  });
}

/** §13.5 row 10 — "Messaging activates exact claim generation; one active endpoint." */
export async function activateEndpoint(
  core: RunsCore,
  input: { readonly claimId?: string; readonly operation: RunOperation },
): Promise<B3Result<RunOperation>> {
  const messaging = core.messagingEndpoint;
  if (messaging === undefined || input.claimId === undefined) {
    return absent(core, input.operation, 'endpoint-active', 'messaging');
  }
  const active = await messaging.activate(input.claimId);
  if (!active.ok) return active;
  return record(core, input.operation, 'endpoint-active', 'messaging', active.value.claimId);
}

// ── §13.6, the continuation half ────────────────────────────────────────────

export interface DrainedEndpoint {
  readonly operation: RunOperation;
  readonly oldClaimId?: string;
  readonly oldEndpointGeneration?: number;
  readonly finalWatermark: string;
}

/**
 * §13.6's first two rows: "old endpoint draining" and "final transcript
 * watermark committed".
 *
 * The watermark is READ, never invented. §13.9 lets a watermark advance only
 * over a durable outcome, so the value handed to the transfer is whatever the
 * mirror actually reached — the empty string when it reached nothing.
 */
export async function drainOldEndpoint(
  core: RunsCore,
  input: {
    readonly agentId: AgentId;
    readonly oldRunId: AgentRun['id'];
    readonly operation: RunOperation;
  },
): Promise<B3Result<DrainedEndpoint>> {
  const endpoint = await drainClaim(core, input.agentId, input.operation);
  if (!endpoint.ok) return endpoint;
  const finalised = await finaliseOldWatermark(core, input.oldRunId, endpoint.value.operation);
  if (!finalised.ok) return finalised;

  return b3ok({
    operation: finalised.value.operation,
    ...(endpoint.value.oldClaimId === undefined
      ? {} : { oldClaimId: endpoint.value.oldClaimId }),
    ...(endpoint.value.oldEndpointGeneration === undefined
      ? {} : { oldEndpointGeneration: endpoint.value.oldEndpointGeneration }),
    finalWatermark: finalised.value.finalWatermark,
  });
}

/**
 * §13.6 row 1 — the old endpoint stops accepting new work.
 *
 * "Nothing to drain" is a legitimate state, not a silent skip: an Agent
 * continued before its first endpoint ever activated has no claim, and the
 * transfer will have nothing to move either.
 */
async function drainClaim(
  core: RunsCore, agentId: AgentId, operation: RunOperation,
): Promise<B3Result<{
  readonly operation: RunOperation;
  readonly oldClaimId?: string;
  readonly oldEndpointGeneration?: number;
}>> {
  const messaging = core.messagingEndpoint;
  if (messaging === undefined) {
    const recorded = await absent(core, operation, 'old-endpoint-drained', 'messaging');
    return recorded.ok ? b3ok({ operation: recorded.value }) : recorded;
  }
  const current = await messaging.currentEndpoint(agentId);
  if (!current.ok) return current;
  const oldEndpointGeneration = current.value.endpointGeneration;

  if (current.value.claimId === null) {
    const recorded = await advance(core, operation, {
      stage: 'old-endpoint-drained',
      owner: 'messaging',
      outcome: 'not-needed',
      notNeededBecause: 'this Agent held no endpoint claim to drain',
    });
    return recorded.ok
      ? b3ok({ operation: recorded.value, oldEndpointGeneration })
      : recorded;
  }

  const oldClaimId = current.value.claimId;
  const drained = await messaging.drain(oldClaimId);
  if (!drained.ok) return drained;
  const recorded = await record(
    core, operation, 'old-endpoint-drained', 'messaging', drained.value.claimId,
  );
  return recorded.ok
    ? b3ok({ operation: recorded.value, oldClaimId, oldEndpointGeneration })
    : recorded;
}

/**
 * §13.6 row 2 — the position the mirror actually reached, never a value this
 * function made up. The empty string is a real answer: a Run that produced no
 * transcript position has no watermark.
 */
async function finaliseOldWatermark(
  core: RunsCore, oldRunId: AgentRun['id'], operation: RunOperation,
): Promise<B3Result<{
  readonly operation: RunOperation; readonly finalWatermark: string;
}>> {
  const transcript = core.transcriptCustody;
  if (transcript === undefined) {
    const recorded = await absent(core, operation, 'old-transcript-finalised', 'transcript');
    return recorded.ok
      ? b3ok({ operation: recorded.value, finalWatermark: '' })
      : recorded;
  }
  const watermark = await transcript.finalWatermarkOf(oldRunId);
  if (!watermark.ok) return watermark;
  const recorded = watermark.value.bindingId === null
    ? await advance(core, operation, {
      stage: 'old-transcript-finalised',
      owner: 'transcript',
      outcome: 'not-needed',
      notNeededBecause: 'this Run never had a transcript binding to finalise',
    })
    : await record(
      core, operation, 'old-transcript-finalised', 'transcript', watermark.value.bindingId,
    );
  return recorded.ok
    ? b3ok({ operation: recorded.value, finalWatermark: watermark.value.finalWatermark })
    : recorded;
}

/**
 * §13.6 — "Messaging endpoint claim transferred atomically".
 *
 * One store operation closes the old claim, opens the new one, and re-points
 * every queued inbox item. There is no instant at which a queued Message
 * belongs to both endpoints or to neither; that atomicity is Messaging's, and
 * the Runtime's job is only to ask for it with the right expectations.
 */
export async function transferEndpoint(
  core: RunsCore,
  input: {
    readonly agentId: AgentId;
    readonly newRun: AgentRun;
    readonly drained: DrainedEndpoint;
    readonly operation: RunOperation;
  },
): Promise<B3Result<RunOperation>> {
  const messaging = core.messagingEndpoint;
  if (messaging === undefined) {
    return absent(core, input.operation, 'endpoint-transferred', 'messaging');
  }
  const terminalSessionId = input.newRun.terminalSessionId;
  if (input.drained.oldClaimId === undefined
    || input.drained.oldEndpointGeneration === undefined) {
    // The replacement still needs an endpoint of its own, or the Agent comes
    // out of a continuation unable to receive anything.
    const reserved = await messaging.reserve({
      agentId: input.agentId,
      agentRunId: input.newRun.id,
      terminalSessionId: terminalSessionId!,
      expectedEndpointGeneration: (await currentGeneration(core, input.agentId)),
    });
    if (!reserved.ok) return reserved;
    const active = await messaging.activate(reserved.value.claimId);
    if (!active.ok) return active;
    return record(
      core, input.operation, 'endpoint-transferred', 'messaging', active.value.claimId,
    );
  }

  const transferred = await messaging.transfer({
    agentId: input.agentId,
    expectedOldClaimId: input.drained.oldClaimId,
    newRunId: input.newRun.id,
    newTerminalSessionId: terminalSessionId!,
    oldFinalTranscriptWatermark: input.drained.finalWatermark,
    expectedEndpointGeneration: input.drained.oldEndpointGeneration,
  });
  if (!transferred.ok) return transferred;
  return record(
    core, input.operation, 'endpoint-transferred', 'messaging', transferred.value.claimId,
  );
}

async function currentGeneration(core: RunsCore, agentId: AgentId): Promise<number> {
  const current = await core.messagingEndpoint!.currentEndpoint(agentId);
  return current.ok ? current.value.endpointGeneration : -1;
}
