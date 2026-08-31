// The cross-capability custody seams the Run lifecycle varies at: what
// Messaging must answer about an Agent's terminal endpoint, and what
// Transcript must answer about a Run's custody of its own mirror.
//
// Split out of `ports.ts` for the same reason those ports are narrow in the
// first place: they are the only seams whose counterpart is another CAPABILITY
// rather than a host facility (Agents, Terminal, the provider). Keeping them in
// one file makes "what does the spawn ladder ask of its peers" a thing you can
// read in one sitting.
import type {
  ActivityGeneration, AgentId, AgentRunId, B3ClientOpId, B3PrincipalId, B3Result,
  HumanPrincipalId, ProviderSessionId, ResolvedLaunchPlanId, TerminalSessionId,
  TraceCorrelationId,
} from '@novakai/foundation/contract';

/**
 * The Messaging endpoint lifecycle, seen through the four questions the spawn
 * and continuation ladders actually ask.
 *
 * Narrow on purpose. The Runtime cannot send a Message, cannot read an inbox,
 * and cannot open a conversation through this port — it can only reserve,
 * activate, drain and transfer the claim that says WHICH Run currently owns an
 * Agent's terminal, which is the only Messaging fact a Run lifecycle owns.
 */
export interface MessagingEndpointPort {
  /**
   * The Thread this Agent's own conversation lives in, get-or-create.
   *
   * Needed because a Transcript binding cannot exist without one (every
   * mirrored turn commits into a Thread) and nothing else in the spawn
   * ladder holds a Thread id.
   */
  ensureAgentThread(
    input: {
      readonly agentId: AgentId;
      readonly rootHumanPrincipalId: HumanPrincipalId;
    },
  ): Promise<B3Result<{ readonly threadId: string }>>;

  /** The Agent's current claim, or the empty generation when it has none. */
  currentEndpoint(
    agentId: AgentId,
  ): Promise<B3Result<{
    readonly claimId: string | null;
    readonly endpointGeneration: number;
    /**
     * Which Run holds it. A caller closing ITS OWN endpoint has to be able to
     * tell — draining a claim a successor already took would silence a live
     * Agent, and the claim id alone does not say whose it is.
     */
    readonly agentRunId?: string;
  }>>;

  reserve(
    input: {
      readonly agentId: AgentId;
      readonly agentRunId: AgentRunId;
      readonly terminalSessionId: TerminalSessionId;
      readonly expectedEndpointGeneration: number;
    },
  ): Promise<B3Result<{ readonly claimId: string; readonly endpointGeneration: number }>>;

  activate(claimId: string): Promise<B3Result<{ readonly claimId: string }>>;

  /** The old endpoint stops accepting new work before the transfer. */
  drain(claimId: string): Promise<B3Result<{ readonly claimId: string }>>;

  transfer(
    input: {
      readonly agentId: AgentId;
      readonly expectedOldClaimId: string;
      readonly newRunId: AgentRunId;
      readonly newTerminalSessionId: TerminalSessionId;
      readonly oldFinalTranscriptWatermark: string;
      readonly expectedEndpointGeneration: number;
    },
  ): Promise<B3Result<{ readonly claimId: string; readonly endpointGeneration: number }>>;
}

/** Transcript-first child bootstrap; no terminal or ProviderSession is exposed. */
export interface HeadlessChildMessagingPort {
  prepare(input: {
    readonly agentId: AgentId;
    readonly parentAgentId: AgentId;
    readonly rootHumanPrincipalId: HumanPrincipalId;
    readonly provider: 'claude' | 'codex' | 'kimi';
    readonly displayName: string;
    readonly environment: Readonly<Record<string, string>>;
    readonly clientOpId: B3ClientOpId;
  }): Promise<B3Result<{
    readonly conversationId: string;
  }>>;

  dispatchBrief(input: {
    readonly agentId: AgentId;
    readonly parentAgentId: AgentId;
    readonly conversationId: string;
    readonly brief: string;
    readonly clientOpId: B3ClientOpId;
  }): Promise<B3Result<{
    readonly sendId: string;
    readonly providerSessionId: ProviderSessionId;
    readonly providerResumeId: string | null;
    readonly response: string;
  }>>;
}

/**
 * Inbox delivery, seen through the two operations the Runtime is authorised
 * to perform as `sys_agent_runtime`.
 *
 * As narrow as `MessagingEndpointPort` and for the same reason: a Runtime
 * holding this cannot send a Message, cannot read another Agent's inbox and
 * cannot choose what an item says. It can take the next item Messaging is
 * willing to hand over for an Agent's live endpoint, and report what the
 * terminal did with it.
 */
export interface MessagingInboxPort {
  /** Exact durable source fact, including after it has been claimed/submitted. */
  getSource(inboxItemId: string): Promise<B3Result<{
    readonly inboxItemId: string;
    readonly messageId: string;
    readonly text: string;
  } | null>>;

  /** Read the next queued source fact without claiming it at an unsafe boundary. */
  peekNext(agentId: AgentId): Promise<B3Result<{
    readonly inboxItemId: string;
    readonly messageId: string;
    readonly text: string;
  } | null>>;

  /**
   * The Agent's next queued item, already moved to `claimed`, or null when
   * there is nothing to deliver or no active endpoint to deliver through.
   *
   * The TEXT rides on the answer because the Runtime has no other way to read a
   * Message and must not acquire one — a port that returned only an id would
   * force the composition root to hand the Runtime the whole Messaging
   * contract.
   */
  claimNext(agentId: AgentId): Promise<B3Result<{
    readonly inboxItemId: string;
    readonly messageId: string;
    readonly text: string;
  } | null>>;

  /** What the terminal did. Never inferred, never optimistic. */
  recordSubmission(
    input: {
      readonly inboxItemId: string;
      readonly outcome: 'submitted-confirmed' | 'submitted-unconfirmed' | 'failed';
      readonly terminalInputAttemptId?: string;
      readonly failureReason?: string;
    },
  ): Promise<B3Result<{ readonly state: string }>>;
}

// ── What Transcript must answer ─────────────────────────────────────────────

/**
 * Transcript custody, seen through the two things a Run lifecycle owns: this
 * Run's binding is established at spawn, and the watermark it reached is
 * committed before the endpoint moves on.
 *
 * Separate from `TranscriptBindingLookup`, which is the read a Run VIEW makes.
 * This one mutates; that one does not.
 */
export interface TranscriptCustodyPort {
  bind(
    input: {
      readonly agentId: AgentId;
      readonly agentRunId: AgentRunId;
      readonly provider: 'claude' | 'codex' | 'kimi';
      readonly providerSessionId: ProviderSessionId;
      readonly threadId: string;
    },
  ): Promise<B3Result<{
    readonly bindingId: string;
    readonly mirrorWatermark?: string;
  }>>;

  /**
   * How far this Run's mirror durably got. The empty string is a real answer —
   * a Run that produced no transcript position has no watermark, and inventing
   * one would let a transfer claim a position nothing ever committed.
   */
  finalWatermarkOf(agentRunId: AgentRunId): Promise<B3Result<{
    readonly bindingId: string | null;
    readonly finalWatermark: string;
  }>>;
}

/**
 * What Supervision must answer at the watcher-installation rung of the ladder.
 *
 * As narrow as its neighbours above, and for the same reason: the Runtime
 * cannot create a watcher of its own, cannot read one, and cannot fire one. It
 * can ask ONE question — "materialise the watchers this Run's immutable launch
 * plan pinned" — and Supervision remains the sole writer of every record that
 * answer touches.
 *
 * Optional on the Runtime, exactly like the two ports above: a host composed
 * without Supervision records the rung `not-needed` naming the absent
 * capability, which is a true statement about that host.
 */
export interface InstalledWatcherFacts {
  readonly id: string;
  readonly templateRef: { readonly id: string; readonly version: number; readonly digest: string };
  readonly source: 'implicit-activity-drift' | 'explicit';
}

export interface RunWatcherPort {
  installRunWatchers(
    input: {
      readonly agentRunId: AgentRunId;
      readonly launchPlanId: ResolvedLaunchPlanId;
      readonly requiredTemplateRefs: readonly {
        readonly id: string; readonly version: number; readonly digest: string;
      }[];
      readonly recipient:
        | { readonly kind: 'agent'; readonly agentId: AgentId }
        | { readonly kind: 'human'; readonly principalId: HumanPrincipalId };
      readonly activityGeneration: ActivityGeneration;
      readonly requestProvenance: {
        readonly requestedBy: B3PrincipalId;
        readonly traceId: TraceCorrelationId;
        readonly clientOpId: B3ClientOpId;
      };
    },
  ): Promise<B3Result<readonly InstalledWatcherFacts[]>>;
}
