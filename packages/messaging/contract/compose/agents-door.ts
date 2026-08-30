import type { Page, Result } from '@novakai/foundation/contract';

/**
 * The structural slice of the Agents capability Messaging binds to.
 *
 * Messaging never imports the Agents package: the host passes its composed
 * AgentsContract, which satisfies this shape structurally. The seam is
 * defensive by policy — the Agents package is not yet audited — so identity
 * facts crossing it (provider names, session pointers, attachment states)
 * are re-validated by the adapters before they reach Messaging records.
 * Scalar fields are trusted once this interface types them.
 *
 * Optional fields accept explicit `undefined` so the door stays satisfiable
 * whether or not the host compiles with `exactOptionalPropertyTypes`.
 */

/** The error vocabulary Messaging reads from an Agents failure. */
export interface AgentsDoorError {
  readonly code: string;
  readonly message: string;
}

/** The Agent definition fields Messaging reads — nothing more. */
export interface AgentsDoorAgent {
  readonly id: string;
  readonly provider: string;
  readonly sessionId?: string | undefined;
  readonly sessions?: readonly string[] | undefined;
}

/** Agents reports a missing Agent as a value, never a failure. */
export interface AgentsDoorAbsent {
  readonly absent: true;
}

/** Facts required to adopt one externally discovered Agent. */
export interface AgentsDoorDefineInput {
  readonly displayName: string;
  readonly provider: 'claude' | 'codex' | 'kimi';
  readonly model: string;
  readonly origin: 'provider-spawned';
  readonly teamId: string;
  readonly missionId: string;
}

/** Input to the Agents-owned session-pointer transition. */
export interface AgentsDoorAttachInput {
  readonly agentId: string;
  readonly providerSessionId: string;
  readonly expectedSessionId: string | null;
  readonly clientOpId: string;
}

/** The attachment state Agents reports; re-validated by the adapter. */
export interface AgentsDoorAttachOutcome {
  readonly state: string;
}

/** One provider turn requested through the Agents door. */
export interface AgentsDoorTurnInput {
  readonly agentId: string;
  readonly text: string;
  readonly resumeId?: string | undefined;
}

/** One completed provider turn — Messaging reads only the assistant text. */
export interface AgentsDoorTurnExecution {
  readonly response: string;
}

/**
 * The whole seam, declared once. Each adapter binds only the ops it needs
 * via `Pick`, so a new Agents capability never widens an existing binding.
 *
 * Known ceiling: Agents' `listAgents` forwards no page options, so it
 * returns at most one default page. Callers MUST treat a present
 * `nextCursor` as "directory too large to trust" and fail loudly — never
 * conclude an Agent is absent from a partial page. The cursor-forwarding
 * fix belongs to the Agents package audit.
 */
export interface AgentsDoor {
  getAgent(agentId: string): Promise<Result<AgentsDoorAgent | AgentsDoorAbsent, AgentsDoorError>>;
  listAgents(): Promise<Result<Page<AgentsDoorAgent>, AgentsDoorError>>;
  defineAgent(
    input: AgentsDoorDefineInput,
    clientOpId: string,
  ): Promise<Result<AgentsDoorAgent, AgentsDoorError>>;
  attachProviderSession(
    input: AgentsDoorAttachInput,
  ): Promise<Result<AgentsDoorAttachOutcome, AgentsDoorError>>;
  providerTurnReadiness(agentId: string): 'idle' | 'busy' | 'unavailable';
  executeProviderTurn(
    input: AgentsDoorTurnInput,
  ): Promise<Result<AgentsDoorTurnExecution, AgentsDoorError>>;
}
