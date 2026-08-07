// The browser-safe terminal facade (§12.6).
//
// The page receives plain data. It never imports a capability implementation,
// never learns a PID or a socket path, and never decides policy — it asks the
// Runtime and renders the answer.
/**
 * Who the Novakai window is, as an owner of plain shells. It is a name, not a
 * claim of authority: it is how a tab recognises the session IT left running
 * rather than one that happens to be on the same machine.
 */
export const SHELL_INSTANCE_ID = 'novakai-shell';

export interface TerminalOwnerView {
  readonly kind: 'plain-shell' | 'agent-run';
  readonly label: string;
}

export interface TerminalTabView {
  readonly terminalSessionId: string;
  readonly status: 'reserved' | 'starting' | 'live' | 'exited' | 'failed' | 'recovery-required';
  readonly owner: TerminalOwnerView;
  readonly workingDirectory: string;
  readonly attachedControllerCount: number;
  readonly holdsInputLease: boolean;
  readonly replay: { readonly earliestSequence: number; readonly latestSequence: number };
  /**
   * Where the Runtime's input stream is. A tab that just opened has typed
   * nothing, but the session may have been typed into for an hour — so this is
   * asked for, never assumed (NVK-KIMI-025 repair 1).
   */
  readonly nextInputSequence: number;
}

export interface TerminalAttachment {
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  /** The sequence this window's FIRST write must claim. */
  readonly nextInputSequence: number;
}

export interface TerminalFrame {
  readonly kind: 'bytes' | 'gap' | 'exit';
  readonly text: string;
  readonly sequence?: number;
}

/**
 * The browser's own plain-data outcome. It deliberately does NOT import the
 * capability Result type: the page receives data, never an implementation.
 */
export type TerminalOutcome<Value> =
  | { readonly succeeded: true; readonly value: Value }
  | { readonly succeeded: false; readonly code: string; readonly message: string };

/**
 * Everything the terminal tab is allowed to do. Note what is NOT here: there is
 * no way for a window to stop a session (red gate 1). Closing is `detach`.
 */
export interface TerminalServices {
  listTerminals(): Promise<TerminalOutcome<readonly TerminalTabView[]>>;
  openTerminal(workingDirectory: string, columns: number, rows: number): Promise<TerminalOutcome<TerminalTabView>>;
  attach(
    terminalSessionId: string, columns: number, rows: number,
  ): Promise<TerminalOutcome<TerminalAttachment>>;
  detach(terminalSessionId: string, attachmentId: string): Promise<TerminalOutcome<null>>;
  write(
    terminalSessionId: string, attachment: TerminalAttachment, text: string, sequence: number,
  ): Promise<TerminalOutcome<{ readonly inputSequence: number }>>;
  resize(
    terminalSessionId: string, attachmentId: string, columns: number, rows: number,
  ): Promise<TerminalOutcome<TerminalTabView>>;
  readReplay(
    terminalSessionId: string, afterOutputSequence: number,
  ): Promise<TerminalOutcome<readonly TerminalFrame[]>>;
  runtimeStatus(): Promise<TerminalOutcome<{
    readonly activeEpochId: string;
    readonly liveTerminalSessionCount: number;
    readonly attachedControllerCount: number;
  }>>;
}

/**
 * Which live session this tab may adopt — the ONE rule, stated where it can be
 * read and tested rather than left as "whatever came back first".
 *
 * A tab reopening should find the shell it left running. It must never find
 * somebody else's: not an agent run's terminal, not one another process opened,
 * not one in a different directory. Adopting means acquiring the input lease
 * and typing, so getting this wrong is not a cosmetic mistake.
 */
export function chooseAdoptable(
  views: readonly TerminalTabView[],
  workingDirectory: string,
  shellInstanceId: string,
): TerminalTabView | null {
  const mine = views.filter((view) => view.status === 'live'
    && view.owner.kind === 'plain-shell'
    && view.owner.label === shellInstanceId
    && view.workingDirectory === workingDirectory);
  // Ordered, so two tabs asking the same question get the same answer.
  return [...mine].sort(
    (left, right) => left.terminalSessionId.localeCompare(right.terminalSessionId),
  )[0] ?? null;
}

/**
 * The Runtime's `TerminalSessionView`, reduced to what a window may know.
 *
 * This is the seam where the capability's record becomes plain page data, so it
 * lives here — beside the rules that read it — rather than inside the socket
 * client. That is also what makes it provable against a REAL Runtime view
 * instead of a hand-written fixture (NVK-KIMI-025 repair 3).
 */
export function toTabView(reported: unknown): TerminalTabView {
  const view = reported as {
    session: {
      id: string; status: TerminalTabView['status']; workingDirectory: string;
      owner: { kind: string; shellInstanceId?: string; agentRunId?: string };
    };
    attachments: { state: string }[];
    activeInputLease?: unknown;
    replay: { earliestSequence: number; latestSequence: number };
    nextInputSequence: number;
  };
  return {
    terminalSessionId: view.session.id,
    status: view.session.status,
    owner: {
      kind: view.session.owner.kind === 'agent-run' ? 'agent-run' : 'plain-shell',
      label: view.session.owner.agentRunId ?? view.session.owner.shellInstanceId ?? 'shell',
    },
    workingDirectory: view.session.workingDirectory,
    attachedControllerCount: view.attachments.filter((item) => item.state === 'attached').length,
    holdsInputLease: view.activeInputLease !== undefined,
    replay: view.replay,
    nextInputSequence: view.nextInputSequence,
  };
}

/**
 * What a page says when it could not reach the Runtime at all.
 *
 * The raw cause is KEPT, not replaced: whoever has to fix this needs the parse
 * error. But it is not the headline, because the headline has to answer the
 * question a person actually has when a terminal window will not open — are my
 * shells gone? They are not. A window failing to reach the Runtime says nothing
 * about the sessions, which is the same distinction the whole tab surface is
 * built on (red gate 1).
 */
export function describeBootFailure(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : JSON.stringify(cause);
  return `Cannot reach the Novakai Runtime, so this window has nothing to attach to. `
    + `Any terminals it started are still running. (${detail})`;
}

/** The one sentence the tab shows. Three facts, never collapsed into one. */
export function describeTerminal(view: TerminalTabView): string {
  const origin = view.owner.kind === 'plain-shell'
    ? 'Started as a plain shell'
    : `Started for ${view.owner.label}`;
  const controllers = view.attachedControllerCount === 1
    ? '1 window attached'
    : `${view.attachedControllerCount} windows attached`;
  const running = view.status === 'live'
    ? 'running in the background Runtime'
    : `${view.status}`;
  return `${origin} · ${controllers} · ${running}`;
}
