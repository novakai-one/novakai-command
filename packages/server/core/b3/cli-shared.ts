// Shared CLI plumbing: flags, the §17.2 JSON envelope, and the exit codes.
//
// `--json` field names and enum meanings are a compatibility contract; the
// human text above them is free to improve.
import { b3fail, type B3ContractError, type B3Result } from '@novakai/foundation/contract';

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

/** §17.2. The code says what a script should DO about it, not just that it failed. */
export const EXIT = {
  success: 0,
  validation: 2,
  permission: 3,
  conflict: 4,
  retryable: 5,
  recovery: 6,
} as const;

const BY_CODE: Readonly<Record<string, number>> = {
  ValidationFailed: EXIT.validation,
  UnsupportedContractVersion: EXIT.validation,
  UnsupportedOperation: EXIT.validation,
  PermissionDenied: EXIT.permission,
  AuthorityEscalation: EXIT.permission,
  IdempotencyConflict: EXIT.conflict,
  VersionConflict: EXIT.conflict,
  InputLeaseBusy: EXIT.conflict,
  InputLeaseGenerationChanged: EXIT.conflict,
  LiveRunConflict: EXIT.conflict,
  StoreRouteConflict: EXIT.conflict,
  StaleRuntimeEpoch: EXIT.retryable,
  RuntimeUnavailable: EXIT.retryable,
  StoreUnavailable: EXIT.retryable,
  Backpressure: EXIT.retryable,
  RecoveryRequired: EXIT.recovery,
  InputSubmittedUnconfirmed: EXIT.recovery,
};

export function exitCodeFor(error: B3ContractError): number {
  return BY_CODE[error.code] ?? EXIT.validation;
}

export interface Flags {
  readonly json: boolean;
  value(name: string): string | undefined;
  readonly positional: readonly string[];
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

export function emit<Value>(
  command: string, flags: Flags, result: B3Result<Value>, human: (value: Value) => string,
): never {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(cliEnvelope(command, result))}\n`);
  } else if (result.ok) {
    process.stdout.write(`${human(result.value)}\n`);
  } else {
    process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
  }
  process.exit(result.ok ? EXIT.success : exitCodeFor(result.error));
}

export function fail(command: string, flags: Flags, error: B3ContractError): never {
  emit(command, flags, b3fail(error), () => '');
}
