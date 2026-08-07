// shell/contract/agentLifecycle.ts — FZ-VIEW-001's `lifecycle` slice.
//
// The read half of this door has been open since the tracer. The COMMAND half
// was never built, and that single absence is why two surfaces shipped a stated
// limit instead of a control: FZ-VIEW-033's "Stop and close" had no route
// (finding L-18), and every question about stopping a Run ended at "use the
// Run's own controls" — controls that live behind this slice. Finding L-20.
//
// The two rules the read door is copied under (contract/agentRuns.ts) hold here
// unchanged, and a third one belongs to commands only:
//
//   3. EVERY INPUT CARRIES WHAT THE CALLER READ. `expectedLiveRunId`,
//      `expectedRecordVersion`, `expectedAssignmentVersion`, `confirmationToken`
//      — the owner refuses a command aimed at a version the caller never saw.
//      So a command is not callable from a screen alone: the screen must READ
//      first, and a read that fails must stop the command rather than let it
//      proceed on a value the Shell made up. That is B3.1's "never guessed"
//      clause, applied to a mutation, where the cost of guessing is a killed
//      process rather than a wrong sentence.
//
// `confirmation` is the one union copied verbatim rather than widened to
// `string`. It is not a value set that can grow — it is a typed interlock whose
// whole purpose is that a stop cannot be a side effect of something else
// (`runs-api.ts:91`). Widening it here would retire the interlock at the exact
// seam it exists to guard.
import type { AgentRunRowView, ShellReadResult } from './agentRuns.js';

/**
 * The frozen result envelope (FZ-CLI-SCHEMA-011), under the name a command
 * deserves. Same shape as the read side on purpose: a domain refusal is a
 * VALUE on both halves of the door, so a screen never has two failure idioms.
 */
export type ShellCommandResult<Value> = ShellReadResult<Value>;

/** `SpawnAgentInput`, browser-safe (`runs-api.ts:47`). */
export interface SpawnAgentRequest {
  readonly roleProfileId: string;
  readonly displayName: string;
  /** A growable set upstream, so `string` here — the owner refuses an unknown. */
  readonly requestedProvider?: string;
  readonly requestedModelId?: string;
  readonly requestedEffort?: string;
  readonly workingDirectory: string;
  readonly task?: { readonly kind: 'supervised'; readonly brief: string };
  readonly columns?: number;
  readonly rows?: number;
}

/** `InterruptAgentTurnInput`. The version is the one the caller READ. */
export interface InterruptAgentTurnRequest {
  readonly agentRunId: string;
  readonly expectedRecordVersion: number;
}

/** `StopAgentInput`. Three fields, and none of them is optional. */
export interface StopAgentRequest {
  readonly agentId: string;
  readonly expectedLiveRunId: string;
  readonly confirmation: 'stop-one';
}

export interface PrepareStopAgentTreeRequest {
  readonly rootAgentId: string;
}

/** The token is issued over the tree the caller was SHOWN. Never minted here. */
export interface StopAgentTreeRequest {
  readonly rootAgentId: string;
  readonly confirmationToken: string;
  readonly confirmation: 'stop-tree';
}

export interface ContinueAgentRequest {
  readonly agentId: string;
  readonly expectedOldRunId: string;
  /** `ContinuationMode` upstream — never defaulted, so the caller must say. */
  readonly mode: string;
  readonly configurationMode: string;
  readonly replacementPlanId?: string;
  readonly handoverArtifactId?: string;
}

export interface AdoptAgentRequest {
  readonly subjectAgentId: string;
  readonly expectedAssignmentVersion: number;
  readonly supervisor:
    | { readonly kind: 'agent'; readonly agentId: string }
    | { readonly kind: 'human'; readonly principalId: string };
}

/**
 * FZ-VIEW-001's `lifecycle` slice, member for member.
 *
 * Outcomes are `unknown` on purpose. Each of these returns a discriminated
 * outcome the Runtime owns (`InterruptAgentTurnOutcome` has three members, and
 * a `raced-with-completion` is a real answer), and re-typing those unions in
 * the browser would be rule 2's mistake at command scale — a stale copy of a
 * closed union is how a host starts believing an outcome is impossible. A
 * screen that needs to READ an outcome narrows it at its own edge, in the open.
 */
export interface ShellLifecycleServices {
  spawnAgent(request: SpawnAgentRequest): Promise<ShellCommandResult<unknown>>;
  interruptAgentTurn(request: InterruptAgentTurnRequest): Promise<ShellCommandResult<unknown>>;
  stopAgent(request: StopAgentRequest): Promise<ShellCommandResult<unknown>>;
  prepareStopAgentTree(
    request: PrepareStopAgentTreeRequest,
  ): Promise<ShellCommandResult<unknown>>;
  stopAgentTree(request: StopAgentTreeRequest): Promise<ShellCommandResult<unknown>>;
  continueAgent(request: ContinueAgentRequest): Promise<ShellCommandResult<unknown>>;
  adoptAgent(request: AdoptAgentRequest): Promise<ShellCommandResult<unknown>>;
}

/** FZ-VIEW-001's `runtime` slice — one member, and it is a read. */
export interface ShellRuntimeServices {
  getRuntimeStatus(): Promise<ShellReadResult<unknown>>;
}

// ── The pure decision between a tab and a stop ──────────────────────────────

export type TerminalStopPlan =
  | { readonly send: true; readonly request: StopAgentRequest }
  | { readonly send: false; readonly because: string };

/**
 * Rule 3, as code.
 *
 * A terminal tab knows exactly one thing about the Agent behind it: the
 * `agentRunId` on `owner.label`. `StopAgentInput` wants an `agentId` as well,
 * and the ONLY honest source of that is the Run row itself. So this function
 * takes the subject the tab named and the answer the Runtime actually gave, and
 * it refuses in every case where sending would mean asserting something nobody
 * told the Shell:
 *
 *   - the read failed        → there is no agentId, and there is no guessing one
 *   - the row is another Run → the tab would stop somebody else's Agent
 *   - the owner says ended   → `finalAt`, and only `finalAt` (OQ-07). A stop
 *                              here is not dangerous, it is a lie about what
 *                              the press accomplished
 *
 * Note what is NOT consulted: `run.lifecycle`. An `interrupted` Run with no
 * `finalAt` is still live until reconciliation says otherwise, and a Shell that
 * refused to stop it would strand exactly the process most likely to need it.
 */
export function planTerminalStop(
  agentRunId: string,
  read: ShellReadResult<AgentRunRowView>,
): TerminalStopPlan {
  if (!read.ok) {
    return {
      send: false,
      because: `Novakai could not read this Run, so it has nothing to aim a stop at `
        + `(${read.error.code}: ${read.error.message}).`,
    };
  }
  if (read.value.run.id !== agentRunId) {
    return {
      send: false,
      because: 'The Runtime answered about a different Run than this terminal belongs to, '
        + 'so nothing was stopped.',
    };
  }
  if (read.value.run.finalAt !== undefined) {
    return {
      send: false,
      because: `Novakai reports this Run as already ended (${read.value.run.finalAt}), `
        + 'so there is nothing left to stop.',
    };
  }
  return {
    send: true,
    request: {
      agentId: read.value.run.agentId,
      expectedLiveRunId: agentRunId,
      confirmation: 'stop-one',
    },
  };
}

/**
 * What the dialog says when a stop did not happen.
 *
 * The reason is kept whole and the CONSEQUENCE is added, because the reason
 * alone leaves the one question a person actually has unanswered: is the thing
 * still running? It is. A window that failed to stop a process and then closed
 * quietly would be the same lie as a Stop button that only detaches — which is
 * the defect `terminalClose.ts` was written to prevent.
 */
export function describeStopRefusal(because: string): string {
  // Terminated first. The reason is composed from an owner-supplied `message`
  // and no owner promises punctuation, so without this the consequence — the
  // half a person actually needs — ran on as a clause of somebody else's
  // sentence: "…this Run has already moved on The session and the Agent…".
  // Found on a screenshot with the assertion for "still running" green.
  const ended = /[.!?]$/u.test(because.trim()) ? because.trim() : `${because.trim()}.`;
  return `${ended} The session and the Agent behind it are still running, and this `
    + 'window is still open.';
}
