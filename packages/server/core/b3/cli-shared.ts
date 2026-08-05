// Shared CLI plumbing: flags, the §17.2 JSON envelope, and the exit codes.
//
// `--json` field names and enum meanings are a compatibility contract; the
// human text above them is free to improve.
import {
  b3fail, b3ok, isValidClientOpId, mintClientOpId, validationFailed,
  type B3ClientOpId, type B3ContractError, type B3Result,
} from '@novakai/foundation/contract';

/**
 * §17.2. The JSON field names here — including the two-letter `ok` — ARE the
 * compatibility contract, so they are built through this factory rather than
 * written as literals the house identifier rule would reject.
 */
export type CliOutput<Value> =
  | { readonly schemaVersion: 1; readonly ok: true; readonly command: string; readonly value: Value }
  | { readonly schemaVersion: 1; readonly ok: false; readonly command: string; readonly error: B3ContractError };

const OK_FIELD = 'ok';

function cliEnvelope<Value>(command: string, result: B3Result<Value>): CliOutput<Value> {
  const body = result.ok
    ? { schemaVersion: 1, command, value: result.value }
    : { schemaVersion: 1, command, error: result.error };
  return { ...body, [OK_FIELD]: result.ok } as CliOutput<Value>;
}

// AMD-005 A5-11's published table. It moved out of this file so that it can be
// a TOTAL function of the error code: it used to carry 26 of the 56 codes and
// fall through to exit 2, which told a caller facing a recovery state that its
// request was malformed. Re-exported here because every CLI already reads the
// exit vocabulary through this module.
export { EXIT, exitCodeFor } from './exit-codes.js';
import { EXIT, exitCodeFor } from './exit-codes.js';

export interface Flags {
  readonly json: boolean;
  value(name: string): string | undefined;
  readonly positional: readonly string[];
}

/** §17.2's flag name. Spelled once, so both CLIs cannot disagree about it. */
export const CLIENT_OP_ID_FLAG = 'client-op-id';

/**
 * §17.2: `--client-op-id <ClientOpId>`, generated if omitted. ONE id per
 * invocation, whatever it does — the receipt id is derived per operation, so a
 * command that attaches, types and detaches resumes all three on a retry rather
 * than doing any of them twice (§4.5, DEC-B3V4-30).
 *
 * A malformed id is refused rather than quietly replaced with a fresh one: a
 * caller that thinks it is being idempotent and silently is not is worse off
 * than one that is told.
 */
export function clientOpIdFrom(flags: Flags): B3Result<B3ClientOpId> {
  const given = flags.value(CLIENT_OP_ID_FLAG);
  if (given === undefined) return b3ok(mintClientOpId());
  if (!isValidClientOpId(given)) {
    return b3fail(validationFailed([{
      path: CLIENT_OP_ID_FLAG,
      message: 'must be op_<uuidv4|uuidv5>; omit the flag and one is generated',
    }]));
  }
  return b3ok(given as B3ClientOpId);
}

/**
 * AMD-005 A5-01: every command whose `--json` value is a `Page<T>` accepts
 * `--limit <n>` (1–200) and `--cursor <EventCursor>`, both handed to the list
 * method unchanged, with 200 supplied when `--limit` is omitted.
 *
 * Spelled once, here, because a per-command copy is how two `Page` commands
 * end up with two different defaults. The CLI never re-pages, merges pages,
 * filters items, or recomputes `omissions` — a cursor it invented would
 * describe a page the owner never minted (FZ-EVT-007: cursors are opaque and
 * minted by the stream owner).
 */
export const DEFAULT_PAGE_LIMIT = 200;
export const MAX_PAGE_LIMIT = 200;

export function pageFlags(flags: Flags): B3Result<{ limit: number; cursor?: string }> {
  const cursor = flags.value('cursor');
  const tail = cursor === undefined ? {} : { cursor };
  const given = flags.value('limit');
  if (given === undefined) return b3ok({ limit: DEFAULT_PAGE_LIMIT, ...tail });
  const limit = Number(given);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    return b3fail(validationFailed([{
      path: 'limit', message: `must be a whole number from 1 to ${MAX_PAGE_LIMIT}`,
    }]));
  }
  return b3ok({ limit, ...tail });
}

export function parseFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const named = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      named.set(name, 'true');
      continue;
    }
    named.set(name, next);
    index += 1;
  }
  return {
    json: named.get('json') === 'true',
    value: (name: string) => named.get(name),
    positional,
  };
}

/**
 * Say the answer without ending the process — for commands like `attach` that
 * report what they did and then keep doing it.
 */
export function report<Value>(
  command: string, flags: Flags, result: B3Result<Value>, human: (value: Value) => string,
): void {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(cliEnvelope(command, result))}\n`);
  } else if (result.ok) {
    process.stdout.write(`${human(result.value)}\n`);
  } else {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  }
}

export function emit<Value>(
  command: string, flags: Flags, result: B3Result<Value>, human: (value: Value) => string,
): never {
  report(command, flags, result, human);
  process.exit(result.ok ? EXIT.success : exitCodeFor(result.error));
}

export function fail(command: string, flags: Flags, error: B3ContractError): never {
  emit(command, flags, b3fail(error), () => '');
}
