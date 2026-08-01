// The browser-safe terminal facade (§12.6).
//
// The page receives plain data. It never imports a capability implementation,
// never learns a PID or a socket path, and never decides policy — it asks the
// Runtime and renders the answer.
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
}

export interface TerminalAttachment {
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
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
