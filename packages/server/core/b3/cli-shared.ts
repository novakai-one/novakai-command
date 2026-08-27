// Shared CLI plumbing: flags, the §17.2 JSON envelope, and the exit codes.
//
// `--json` field names and enum meanings are a compatibility contract; the
// human text above them is free to improve.
import {
  b3fail, b3ok, isValidClientOpId, isValidId, mintClientOpId, validationFailed,
  type B3ClientOpId, type B3ContractError, type B3Result, type IdFormat,
} from '@novakai/foundation/contract';

/**
 * §17.2. The JSON field names here — including the two-letter `ok` — ARE the
 * compatibility contract, so they are built through this factory rather than
 * written as literals the house identifier rule would reject.
 */
export type CliOutput<Value> =
  | { readonly schemaVersion: 1; readonly ok: true; readonly command: CliCommand; readonly value: Value }
  | { readonly schemaVersion: 1; readonly ok: false; readonly command: CliCommand; readonly error: B3ContractError };

/**
 * NVK-KIMI-085 X-1: `command` is the canonical dotted command path with the
 * RESOLVED argument form appended, drawn from this closed published set — never
 * the caller's argv. Transcribed from the ruling, in its order.
 *
 * It is a set and not a convention because it is a discriminator: OQ-09 and
 * OQ-16 give `agent inspect` and `agent usage` two different value types
 * depending on the argument, and this field is the only published way to tell
 * which one you were handed. A free-form string there forces a consumer to
 * sniff fields — the thing the ruling exists to prevent.
 *
 * The two `.stream` members are the NDJSON follow-on lines of OQ-14(ii). They
 * are published here so the vocabulary is whole; the stream that emits them is
 * slice A3.
 */
export const RULED_COMMANDS = [
  'runtime.ensure', 'runtime.status', 'runtime.doctor', 'runtime.stop',
  'agent.list', 'agent.tree',
  'agent.inspect.run', 'agent.inspect.agent',
  'agent.attach', 'agent.attach.stream',
  'agent.interrupt', 'agent.stop', 'agent.stop-tree.prepare', 'agent.stop-tree.confirm',
  'agent.continue', 'agent.adopt', 'agent.controls', 'agent.control', 'agent.message',
  'agent.communications', 'agent.usage.run', 'agent.usage.agent', 'agent.events',
  'terminal.list', 'terminal.inspect', 'terminal.attach', 'terminal.attach.stream',
  'terminal.detach',
  'watch.add', 'watch.list', 'watch.update', 'watch.remove',
  'watch.notifications', 'watch.acknowledge', 'watch.reset-drift',
] as const;

export type RuledCommand = (typeof RULED_COMMANDS)[number];

/**
 * Everything else this CLI can print in the `command` field, kept in a SEPARATE
 * list so that nothing outside §17.1's tree can pass for ruled surface:
 *
 *  - the OUT-OF-B3e EXTRAS (freeze §5b, NVK-KIMI-092): lawful pre-existing
 *    B3a–B3d verbs that §17.1 never named. Eleven were ruled lawful and are
 *    left exactly as they are, space form and all;
 *  - `runtime.cutover-report`, the one defect's replacement. It is spelled
 *    DOTTED and still unruled, which is deliberate: membership of X-1's set is
 *    what decides "ratified or extra" (§0 consequence 5), never the shape of
 *    the string. What it may not be is a ratified command plus a flag — the
 *    old `"runtime doctor --cutover"` was exactly that, and it is the reason
 *    the membership test could not be applied to it;
 *  - the group-level usage line, printed when the verb is not a command at all.
 *    X-1 constrains commands; a refusal that names no command names its group.
 */
export const UNRULED_COMMANDS = [
  'agent', 'runtime', 'terminal', 'watch',
  'agent roles', 'agent define-role', 'agent operations', 'agent fence',
  'agent grants', 'agent repair', 'agent open-conversation',
  'terminal open', 'terminal write', 'terminal read',
  'runtime.cutover-report',
] as const;

export type CliCommand = RuledCommand | (typeof UNRULED_COMMANDS)[number];

/**
 * X-3's resolution rule, spelled once: ONLY an `agentRun_` prefix picks the run
 * form. Everything else — an Agent id, a malformed id, a missing argument — is
 * the agent form, which is what makes the resolution total and keeps the two
 * dual-form commands from ever having to guess.
 */
export const isRunForm = (target: string | undefined): boolean =>
  target?.startsWith('agentRun_') ?? false;

/**
 * The verb an operator typed, recovered from a command member for the human
 * usage line. Dotted members carry it as their second segment; the unruled
 * space-form ones as their second word.
 */
export const verbOf = (command: CliCommand): string =>
  (command.includes('.') ? command.split('.')[1]! : command.split(' ')[1] ?? '');

const OK_FIELD = 'ok';

function cliEnvelope<Value>(command: CliCommand, result: B3Result<Value>): CliOutput<Value> {
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
  /**
   * Every occurrence of a flag, in the order the operator typed them.
   *
   * `parseFlags` kept ONE value per name, which is right for every flag that
   * names a single thing and silently wrong for A5-02's `--confirmed-run`: a
   * `runtime stop` told about three live Runs would have confirmed only the
   * last, and stopped while refusing two Runs the operator had already agreed
   * to lose. `value()` keeps its old meaning; a repeatable flag reads here.
   */
  values(name: string): readonly string[];
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

/**
 * AMD-005 A5-02 — the concurrency preconditions, as flags.
 *
 * "A command whose in-process input requires a caller-supplied concurrency
 * precondition accepts it as an explicit flag; the CLI never reads a record in
 * order to supply one."
 *
 * The CLI supplied all of them, at five sites, by reading the record it was
 * about to write. That is a compare-and-set against a value nobody compared:
 * the operator decided at version 3, the CLI fetched version 5 a millisecond
 * before writing, and the write the CAS existed to refuse went through. The
 * operator's belief is the only expected value worth quoting, and it can only
 * arrive from the operator.
 *
 * Spelled once, here, for the same reason `pageFlags` is: five copies of one
 * law is how the five sites drift into five laws.
 */
export const EXPECT_VERSION_FLAG = 'expect-version';
export const EXPECT_EPOCH_FLAG = 'expect-epoch';
export const EXPECT_EPISODE_FLAG = 'expect-episode';
export const CONFIRMED_RUN_FLAG = 'confirmed-run';
export const REASON_FLAG = 'reason';

const requiredFlag = (name: string, message: string): B3Result<never> =>
  b3fail(validationFailed([{ path: name, message }]));

/**
 * `--expect-version <n>` → `expectedRecordVersion` / `expectedAssignmentVersion`
 * / `expectedRunVersion`, whichever the owner's input names.
 *
 * The CLI refuses only the encoding error it can SEE — "that is not a whole
 * number". Each owner's floor differs (`count(…, 1, …)` for a Run record,
 * `count(…, 0, …)` for an assignment), and a range check here would be CLI-only
 * policy answering a question the boundary already answers — the same reading
 * `--depth` was given in A5-09 (OQ-06).
 */
export function expectedVersion(flags: Flags): B3Result<number> {
  const given = flags.value(EXPECT_VERSION_FLAG);
  if (given === undefined) {
    return requiredFlag(EXPECT_VERSION_FLAG,
      `--${EXPECT_VERSION_FLAG} <n> is required: quote the record version YOU read`);
  }
  const version = Number(given);
  if (!Number.isInteger(version)) {
    return requiredFlag(EXPECT_VERSION_FLAG, `--${EXPECT_VERSION_FLAG} must be a whole number`);
  }
  return b3ok(version);
}

/** One required id-shaped precondition flag, refused here only for its shape. */
function expectedId(
  flags: Flags, flag: string, prefix: string, format: IdFormat, purpose: string,
): B3Result<string> {
  const given = flags.value(flag);
  if (given === undefined) {
    return requiredFlag(flag, `--${flag} <${prefix}Id> is required: ${purpose}`);
  }
  if (!isValidId(given, prefix, format)) {
    return requiredFlag(flag, `--${flag} must be a ${prefix} identifier`);
  }
  return b3ok(given);
}

/** `--expect-epoch <RuntimeEpochId>` → `expectedEpochId`. */
export const expectedEpoch = (flags: Flags): B3Result<string> => expectedId(
  flags, EXPECT_EPOCH_FLAG, 'runtimeEpoch', 'uuidv7',
  'a stop applies to the Runtime you saw, never to one that took over since',
);

/** `--expect-episode <DriftEpisodeId>` → `expectedEpisodeId`. */
export const expectedEpisode = (flags: Flags): B3Result<string> => expectedId(
  flags, EXPECT_EPISODE_FLAG, 'driftEpisode', 'base32sha256',
  'a reset applies to the drift episode you looked at',
);

/**
 * `--confirmed-run <AgentRunId>`, repeatable → `confirmedRunIds`.
 *
 * Optional at the owner's boundary (`RequestRuntimeStopInput.confirmedRunIds?`),
 * so an absent flag omits the field rather than sending an empty list — an
 * empty list is the operator saying "I confirm nothing", which is a different
 * sentence from not being asked.
 */
export function confirmedRuns(flags: Flags): B3Result<{ confirmedRunIds?: readonly string[] }> {
  const given = flags.values(CONFIRMED_RUN_FLAG);
  if (given.length === 0) return b3ok({});
  const malformed = given.filter((id) => !isValidId(id, 'agentRun', 'uuidv7'));
  if (malformed.length > 0) {
    // Every bad id is reported, not just the first: an operator confirming four
    // Runs should learn about all four typos in one answer, not four runs.
    return b3fail(validationFailed(malformed.map((id) => ({
      path: CONFIRMED_RUN_FLAG, message: `--${CONFIRMED_RUN_FLAG} "${id}" is not an AgentRunId`,
    }))));
  }
  return b3ok({ confirmedRunIds: given });
}

/**
 * `--reason <text>` → `reason`.
 *
 * `watch reset-drift` shipped a default of `'reset requested by nvk watch
 * reset-drift'` — the durable record of why a human overrode a drift alarm,
 * written by the tool instead of the human. Emptiness is still the owner's
 * call (`field.text('reason')`); what the CLI will not do is answer for them.
 */
export function requiredReason(flags: Flags): B3Result<string> {
  const given = flags.value(REASON_FLAG);
  return given === undefined
    ? requiredFlag(REASON_FLAG, `--${REASON_FLAG} <text> is required: say why, in your words`)
    : b3ok(given);
}

export function parseFlags(argv: readonly string[]): Flags {
  const positional: string[] = [];
  const named = new Map<string, string[]>();
  const push = (name: string, value: string): void => {
    const seen = named.get(name);
    if (seen === undefined) named.set(name, [value]);
    else seen.push(value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      push(name, 'true');
      continue;
    }
    push(name, next);
    index += 1;
  }
  // `value()` answers with the LAST occurrence, which is what a Map already did
  // and what every non-repeatable flag has always been read as. Changing it to
  // the first would silently move which value a command already in the field
  // sends; the repeatable case reads `values()` instead.
  const lastOf = (name: string): string | undefined => named.get(name)?.at(-1);
  return {
    json: lastOf('json') === 'true',
    value: lastOf,
    values: (name: string) => named.get(name) ?? [],
    positional,
  };
}

/**
 * Say the answer without ending the process — for commands like `attach` that
 * report what they did and then keep doing it.
 */
export function report<Value>(
  command: CliCommand, flags: Flags, result: B3Result<Value>, human: (value: Value) => string,
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
  command: CliCommand, flags: Flags, result: B3Result<Value>, human: (value: Value) => string,
): never {
  report(command, flags, result, human);
  process.exit(result.ok ? EXIT.success : exitCodeFor(result.error));
}

export function fail(command: CliCommand, flags: Flags, error: B3ContractError): never {
  emit(command, flags, b3fail(error), () => '');
}
