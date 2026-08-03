// Durable command receipts (B3V4-P2 §4.5, DEC-B3V4-30).
//
// One rule: a retry cannot silently become a different command. The receipt id
// is deterministic from {principal, operation, clientOpId}; the canonical
// request hash is stored beside it. Same key + same hash resumes or returns the
// stored outcome. Same key + a DIFFERENT hash is `IdempotencyConflict`, never a
// second execution.
//
// Foundation is the only writer of this kind (§3.3 one-writer law), so the
// scoped handle is composed here and never handed out.
import { createHash } from 'node:crypto';
import { composeHandle } from './compose.js';
import { createObject, getObject, updateObject } from './api.js';
import { mintClientOpId, type ClientOpId, type ObjectId } from './brands.js';
import { isAbsent, type ScopedStoreHandle } from './types.js';
import {
  b3err, b3fail, b3ok, deterministicId, nowIsoUtc,
  type B3ContractError, type B3PrincipalId, type B3Result, type CommandContext,
  type CommandReceiptId, type PublicOperationName,
} from './b3.js';

export type CommandReceiptState = 'accepted' | 'running' | 'succeeded' | 'failed';

export interface StoredOperationOutcome {
  /**
   * §4.5 names this field `ok`; it is spelled `succeeded` here because the
   * house standard forbids identifiers under four characters. Same fact, and
   * the CLI/wire surfaces still speak §17.2's `ok`.
   */
  readonly succeeded: boolean;
  readonly valueDigest?: string;
  /**
   * Additive to §4.5's shape (§3.5 permits additive fields). Without the value
   * itself a replay could only be answered by RE-RUNNING the command, which is
   * exactly what an effectful operation must not do.
   */
  readonly value?: unknown;
  readonly error?: B3ContractError;
}

export interface CommandReceiptRecord {
  readonly kind: 'commandReceipt';
  readonly id: CommandReceiptId;
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly permissionLevel: 'private';
  readonly createdBy: string;
  readonly principalId: B3PrincipalId;
  readonly operation: PublicOperationName;
  readonly clientOpId: ClientOpId;
  readonly canonicalRequestHash: string;
  readonly state: CommandReceiptState;
  readonly outcome?: StoredOperationOutcome;
}

/**
 * Stable JSON: object keys sorted at every depth, so two structurally identical
 * requests hash the same regardless of how the caller built them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, field]) => field !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([name, field]) => `${JSON.stringify(name)}:${canonicalJson(field)}`).join(',')}}`;
}

export function canonicalRequestHash(request: unknown): string {
  return createHash('sha256').update(canonicalJson(request), 'utf8').digest('hex');
}

export function commandReceiptId(
  principalId: string, operation: string, clientOpId: string,
): CommandReceiptId {
  return deterministicId('receipt', [principalId, operation, clientOpId]) as CommandReceiptId;
}

export interface CommandDescriptor {
  readonly operation: PublicOperationName;
  /** The complete boundary payload; it alone decides the canonical hash. */
  readonly request: unknown;
  /**
   * Whether re-running is safe when a prior attempt never reached a terminal
   * state. True for operations whose only effects are Foundation mutations
   * (idempotent by clientOpId). False for anything that has already touched a
   * PTY or a provider — those report an uncertain effect instead of repeating.
   */
  readonly replaySafe: boolean;
}

export interface ReceiptStore {
  runCommand<T>(
    context: CommandContext,
    descriptor: CommandDescriptor,
    execute: () => Promise<B3Result<T>>,
  ): Promise<B3Result<T>>;
  /** Keep a successful prerequisite-wait outcome resumable under the same receipt. */
  runResumableCommand<T>(
    context: CommandContext,
    descriptor: CommandDescriptor,
    execute: () => Promise<B3Result<T>>,
    keepRunning: (value: T) => boolean,
  ): Promise<B3Result<T>>;
  /** @internal proofs read receipts directly; production callers use runCommand(). */
  readReceipt(id: CommandReceiptId): Promise<CommandReceiptRecord | null>;
}

export interface ComposeReceiptsOptions {
  root: string;
  dataRoot?: string;
  legacyRoot?: string;
  lockTimeoutMs?: number;
}

export function composeReceiptStore(options: ComposeReceiptsOptions): ReceiptStore {
  const handle: ScopedStoreHandle = composeHandle({
    ...options,
    capability: 'foundation',
    allowedKinds: ['commandReceipt'],
    principal: 'sys_foundation',
  });

  async function readReceipt(id: CommandReceiptId): Promise<CommandReceiptRecord | null> {
    const stored = await getObject<CommandReceiptRecord>(handle, 'commandReceipt', id as unknown as ObjectId);
    if (!stored.ok || isAbsent(stored.value)) return null;
    return stored.value.object;
  }

  async function runCommand<T>(
    context: CommandContext,
    descriptor: CommandDescriptor,
    execute: () => Promise<B3Result<T>>,
  ): Promise<B3Result<T>> {
    return runWithSettlement(context, descriptor, execute, () => false);
  }

  async function runResumableCommand<T>(
    context: CommandContext,
    descriptor: CommandDescriptor,
    execute: () => Promise<B3Result<T>>,
    keepRunning: (value: T) => boolean,
  ): Promise<B3Result<T>> {
    return runWithSettlement(context, descriptor, execute, keepRunning);
  }

  async function runWithSettlement<T>(
    context: CommandContext,
    descriptor: CommandDescriptor,
    execute: () => Promise<B3Result<T>>,
    keepRunning: (value: T) => boolean,
  ): Promise<B3Result<T>> {
    const id = commandReceiptId(context.principal.id, descriptor.operation, context.clientOpId);
    const hash = canonicalRequestHash(descriptor.request);
    const prior = await readReceipt(id);

    if (prior) {
      const settled = await answerFromPrior<T>(id, prior, hash, context, descriptor);
      if (settled !== null) return settled;
      // Otherwise fall through and re-execute; every effect underneath a
      // replay-safe command is idempotent on the same clientOpId.
    } else {
      const opened = await createObject<CommandReceiptRecord>(handle, {
        kind: 'commandReceipt', id, schemaVersion: 1,
        createdAt: nowIsoUtc(), permissionLevel: 'private',
        createdBy: 'sys_foundation',
        principalId: context.principal.id,
        operation: descriptor.operation,
        clientOpId: context.clientOpId,
        canonicalRequestHash: hash,
        state: 'running',
      }, mintClientOpId());
      if (!opened.ok) {
        return b3fail(b3err('StoreUnavailable',
          `command receipt could not be recorded: ${opened.error.message}`,
          { owner: 'foundation', cause: opened.error.code }, true));
      }
    }

    const result = await execute();
    if (!result.ok || !keepRunning(result.value)) await settle(id, result);
    return result;
  }

  /**
   * What an EARLIER attempt already decided — or `null` when this attempt
   * should run.
   *
   * Four answers live here, and the differences matter: a different request is
   * a conflict; a success replays; a settled refusal replays, because a caller
   * must not be able to retry its way past a denial; and a RETRYABLE failure
   * runs again, because §11 promised it could.
   */
  async function answerFromPrior<T>(
    id: CommandReceiptId,
    prior: CommandReceiptRecord,
    hash: string,
    context: CommandContext,
    descriptor: CommandDescriptor,
  ): Promise<B3Result<T> | null> {
    if (prior.canonicalRequestHash !== hash) {
      return b3fail(b3err('IdempotencyConflict',
        `clientOpId ${context.clientOpId} was already used for a different ${descriptor.operation} request`,
        { receiptId: id, originalHash: prior.canonicalRequestHash, receivedHash: hash }, false));
    }
    if (prior.state === 'succeeded') return replayOutcome<T>(prior);
    if (prior.state === 'failed' && !retryableFailure(prior)) return replayOutcome<T>(prior);
    if (!descriptor.replaySafe) {
      return b3fail(b3err('RecoveryRequired',
        `${descriptor.operation} was interrupted after its effect may have been applied`,
        { operationId: id, stage: prior.state, reason: 'effect-outcome-uncertain' }, true));
    }
    if (prior.state === 'failed') {
      const reopened = await reopen(id, prior);
      if (!reopened.ok) return reopened;
    }
    return null;
  }

  /** Put a retryable failure back into `running` so this attempt can settle it. */
  async function reopen(
    id: CommandReceiptId, prior: CommandReceiptRecord,
  ): Promise<B3Result<null>> {
    const current = await getObject<CommandReceiptRecord>(
      handle, 'commandReceipt', id as unknown as ObjectId,
    );
    if (!current.ok || isAbsent(current.value)) {
      return b3fail(b3err('StoreUnavailable', 'the command receipt could not be re-read',
        { owner: 'foundation', cause: 'receipt-missing' }, true));
    }
    const written = await updateObject<CommandReceiptRecord>(
      handle, id as unknown as ObjectId, { state: 'running' },
      current.value.version, mintClientOpId(),
    );
    if (!written.ok) {
      return b3fail(b3err('StoreUnavailable',
        `the command receipt could not be reopened: ${written.error.message}`,
        { owner: 'foundation', cause: written.error.code }, true));
    }
    void prior;
    return b3ok(null);
  }

  async function settle<T>(id: CommandReceiptId, result: B3Result<T>): Promise<void> {
    const current = await getObject<CommandReceiptRecord>(handle, 'commandReceipt', id as unknown as ObjectId);
    if (!current.ok || isAbsent(current.value)) return;
    const outcome: StoredOperationOutcome = result.ok
      ? { succeeded: true, valueDigest: canonicalRequestHash(result.value), value: result.value }
      : { succeeded: false, error: result.error };
    // A failure to record the outcome must not turn a completed command into a
    // caller-visible error: the receipt is audit truth, the command already ran.
    await updateObject<CommandReceiptRecord>(
      handle, id as unknown as ObjectId,
      { state: result.ok ? 'succeeded' : 'failed', outcome },
      current.value.version, mintClientOpId(),
    );
  }

  return { runCommand, runResumableCommand, readReceipt };
}

/** Whether the stored failure was one the caller was invited to retry. */
function retryableFailure(prior: CommandReceiptRecord): boolean {
  return prior.outcome?.error?.retryable === true;
}

function replayOutcome<T>(prior: CommandReceiptRecord): B3Result<T> {
  const outcome = prior.outcome;
  if (!outcome) {
    return b3fail(b3err('RecoveryRequired',
      `receipt ${prior.id} reached ${prior.state} without recording its outcome`,
      { operationId: prior.id, stage: prior.state, reason: 'outcome-missing' }, true));
  }
  if (outcome.succeeded) return b3ok(outcome.value as T);
  return b3fail(outcome.error ?? b3err('RecoveryRequired',
    `receipt ${prior.id} recorded a failure without its error`,
    { operationId: prior.id, stage: prior.state, reason: 'error-missing' }, true));
}
