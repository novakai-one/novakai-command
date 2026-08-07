// shell/contract/agentTerminal.ts — FZ-VIEW-001's `terminal` slice.
//
// Seven operations, named exactly as the freeze names them
// (`attachController · detachController · acquireInputLease · releaseInputLease
// · writeInput · resizeTerminal · readTerminalStream`, P2 §12.6:2495–2536).
//
// The Shell has been able to DO all seven since B1a — through
// `contract/terminalServices.ts`, a second facade with its own names, its own
// socket and its own outcome type. That is not a missing capability, it is a
// SECOND DOOR onto one capability, which is the FZ-VIEW-034 failure shape drawn
// at the architecture level rather than at a row: two names for one operation is
// how two surfaces start disagreeing about what the operation did.
//
// So this slice is the frozen door, and `TerminalServices` becomes what it
// always was in practice — a presentation adapter over it (base64 in and out, a
// tab-shaped view, the lease folded into `attach` because a window that cannot
// type still wants to watch). One wire call per operation, in one place.
//
// What is deliberately NOT here: `open`, `list` and `inspect`. The Shell calls
// all three and they are real published methods — but they are not in FZ-VIEW-001's
// `terminal` Pick, and a slice that quietly grew three members would be exactly
// the frozen-projection growth CL-S forbids. They stay on the B1a facade, where
// they are visible as the Shell's own extra reach rather than smuggled in as
// contract.
import type { ShellReadResult } from './agentRuns.js';

export interface AttachControllerRequest {
  readonly terminalSessionId: string;
  /** `CONTROLLER_KINDS` upstream — a growable set, so `string` (rule 2). */
  readonly controllerKind: string;
  readonly columns: number;
  readonly rows: number;
  readonly afterOutputSequence?: number;
}

export interface DetachControllerRequest {
  readonly terminalSessionId: string;
  readonly attachmentId: string;
}

export interface AcquireInputLeaseRequest {
  readonly terminalSessionId: string;
  readonly attachmentId: string;
  readonly mode: string;
  readonly ttlMs: number;
  readonly expectedLeaseGeneration?: number;
}

/**
 * Four fields, and the last two are the point: releasing a lease names WHICH
 * lease and which generation of it, so a stale window cannot release the lease
 * a newer one just took.
 */
export interface ReleaseInputLeaseRequest {
  readonly terminalSessionId: string;
  readonly attachmentId: string;
  readonly leaseId: string;
  readonly generation: number;
}

export interface WriteInputRequest {
  readonly terminalSessionId: string;
  readonly attachmentId: string;
  readonly inputLeaseId: string;
  readonly leaseGeneration: number;
  readonly expectedNextInputSequence: number;
  readonly kindOfInput: string;
  readonly utf8Text?: string;
}

export interface ResizeTerminalRequest {
  readonly terminalSessionId: string;
  readonly attachmentId: string;
  readonly columns: number;
  readonly rows: number;
}

export interface ReadTerminalStreamRequest {
  readonly terminalSessionId: string;
  readonly afterOutputSequence?: number;
}

/**
 * Outcomes are `unknown` for the same reason the lifecycle slice's are: the
 * capability owns those shapes, and the one place they become page data is
 * `contract/terminalServices.ts`'s `toTabView` — provable against a REAL
 * Runtime view, which a second copy of the type here would not be.
 */
export interface ShellTerminalServices {
  attachController(request: AttachControllerRequest): Promise<ShellReadResult<unknown>>;
  detachController(request: DetachControllerRequest): Promise<ShellReadResult<unknown>>;
  acquireInputLease(request: AcquireInputLeaseRequest): Promise<ShellReadResult<unknown>>;
  releaseInputLease(request: ReleaseInputLeaseRequest): Promise<ShellReadResult<unknown>>;
  writeInput(request: WriteInputRequest): Promise<ShellReadResult<unknown>>;
  resizeTerminal(request: ResizeTerminalRequest): Promise<ShellReadResult<unknown>>;
  readTerminalStream(request: ReadTerminalStreamRequest): Promise<ShellReadResult<unknown>>;
}
