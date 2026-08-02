// The two cross-capability seams the B3c Run lifecycle varies at: what Messaging
// must answer about an Agent's terminal endpoint, and what Transcript must
// answer about a Run's custody of its own mirror.
//
// Split out of `ports.ts` for the same reason those ports are narrow in the
// first place: they are the only seams whose counterpart is another CAPABILITY
// rather than a host facility (Agents, Terminal, the provider). Keeping them in
// one file makes "what does the spawn ladder ask of its peers" a thing you can
// read in one sitting — and it is exactly §13.5 rows 6/9/10 plus §13.6.
//
// Re-exported from `ports.ts`, so no consumer changes: the contract's public
// surface is unchanged.
import type {
  AgentId, AgentRunId, B3Result, HumanPrincipalId, ProviderSessionId,
  ResolvedLaunchPlanId, TerminalSessionId,
} from '@novakai/foundation/contract';

/**
 * The Messaging endpoint lifecycle, seen through the four questions the spawn
 * and continuation ladders actually ask (§13.5 rows 6/10, §13.6).
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
   * Needed because a Transcript binding cannot exist without one (§12.5:
   * every mirrored turn commits into a Thread) and nothing else in the spawn
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

  /** §13.6: the old endpoint stops accepting new work before the transfer. */
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

// ── What Transcript must answer ─────────────────────────────────────────────

/**
 * Transcript custody, seen through the two things a Run lifecycle owns: this
 * Run's binding is established at spawn (§13.5 row 9), and the watermark it
 * reached is committed before the endpoint moves on (§13.6's "final transcript
 * watermark committed").
 *
 * Separate from `TranscriptBindingLookup`, which is the §19.1 read a Run VIEW
 * makes. This one mutates; that one does not.
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
 * What Supervision must answer at §13.5's watcher rung (B3d).
 *
 * As narrow as its neighbours above, and for the same reason: the Runtime
 * cannot create a watcher of its own, cannot read one, and cannot fire one. It
 * can ask ONE question — "materialise the watchers this Run's immutable launch
 * plan pinned" — and Supervision remains the sole writer of every record that
 * answer touches (§3.3).
 *
 * Optional on the Runtime, exactly like the two ports above: a host composed
 * without Supervision records the rung `not-needed` naming the absent
 * capability, which is a true statement about that host.
 */
export interface RunWatcherPort {
  installRunWatchers(
    input: {
      readonly agentRunId: AgentRunId;
      readonly launchPlanId: ResolvedLaunchPlanId;
      readonly requiredTemplateRefs: readonly {
        readonly id: string; readonly version: number; readonly digest: string;
      }[];
    },
  ): Promise<B3Result<readonly { readonly id: string }[]>>;
}
