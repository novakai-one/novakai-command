// LANE B — manual WatchRule lifecycle behind the frozen commands.
import {
  b3err,
  b3fail,
  b3ok,
  deriveClientOpId,
  type ActivityGeneration,
  type AuthenticatedPrincipal,
  type B3Result,
  type CommandContext,
} from '@novakai/foundation/contract';
import {
  mintWatchRuleId,
  requiresWatchStartTurnAuthority,
  SUPERVISION_RECORD_WRITER,
  SUPERVISION_WATCH_START_TURN_SCOPE,
  type CreateWatchRuleInput,
  type UpdateWatchRuleInput,
  type WatchDeadline,
  type WatchRule,
  type WatchSubject,
} from '../../contract/index.js';
import type { Persisted, SupervisionStore } from '../store.js';
import { armDeadline } from '../watchers.js';

export interface WatchRuleGenerationPort {
  generationFor(
    principal: AuthenticatedPrincipal,
    subject: WatchSubject,
  ): Promise<B3Result<ActivityGeneration>>;
}

export interface RuleDependencies {
  readonly store: SupervisionStore;
  readonly generation?: WatchRuleGenerationPort;
  readonly clock: () => Date;
}

const permissionDenied = () => b3err(
  'PermissionDenied',
  'this watcher requires supervision:watch:start-turn',
  { operation: 'watch-rule-write', requiredScope: SUPERVISION_WATCH_START_TURN_SCOPE },
  false,
);

function authorize(context: CommandContext, input: CreateWatchRuleInput): B3Result<null> {
  return requiresWatchStartTurnAuthority(input)
    && !context.principal.verifiedScopes.includes(SUPERVISION_WATCH_START_TURN_SCOPE)
    ? b3fail(permissionDenied())
    : b3ok(null);
}

function ruleRecord(
  context: CommandContext,
  input: CreateWatchRuleInput,
  createdAt: string,
): Persisted<WatchRule> & Record<string, unknown> {
  return {
    kind: 'watchRule',
    id: mintWatchRuleId(),
    schemaVersion: 1,
    createdAt: createdAt as never,
    permissionLevel: 'private',
    createdBy: context.principal.id,
    ...input,
  };
}

function timed(rule: WatchRule): boolean {
  return rule.condition.kind === 'idle-for-ms' || rule.condition.kind === 'activity-drift';
}

async function generationForActiveRule(
  deps: RuleDependencies,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
): Promise<B3Result<ActivityGeneration | null>> {
  if (rule.status !== 'active' || !timed(rule)) return b3ok(null);
  if (deps.generation === undefined) {
    return b3fail(b3err(
      'RuntimeUnavailable', 'watcher generationFor is not composed', {}, true,
    ));
  }
  return deps.generation.generationFor(principal, rule.subject);
}

async function ensureDeadline(
  deps: RuleDependencies,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
): Promise<B3Result<null>> {
  const generation = await generationForActiveRule(deps, principal, rule);
  if (!generation.ok) return b3fail(generation.error);
  if (generation.value === null) return b3ok(null);
  return armDeadline(deps, SUPERVISION_RECORD_WRITER, rule, generation.value);
}

function mutationClientOpId(rule: WatchRule): string | undefined {
  return rule.lastMutation.state === 'legacy-no-trace'
    ? undefined
    : String(rule.lastMutation.clientOpId);
}

async function replayedCreate(
  deps: RuleDependencies,
  context: CommandContext,
): Promise<B3Result<WatchRule | null>> {
  const rules = await deps.store.list<WatchRule>('watchRule');
  if (!rules.ok) return b3fail(rules.error);
  return b3ok(rules.value.find(
    (rule) => mutationClientOpId(rule) === String(context.clientOpId),
  ) ?? null);
}

/** Create one rule and arm its timed condition at the authoritative generation. */
export async function createWatchRule(
  deps: RuleDependencies,
  context: CommandContext,
  input: CreateWatchRuleInput,
): Promise<B3Result<WatchRule>> {
  const authorized = authorize(context, input);
  if (!authorized.ok) return b3fail(authorized.error);
  const replay = await replayedCreate(deps, context);
  if (!replay.ok) return b3fail(replay.error);
  if (replay.value !== null) {
    const armed = await ensureDeadline(deps, context.principal, replay.value);
    return armed.ok ? b3ok(replay.value) : b3fail(armed.error);
  }
  const written = await deps.store.create<WatchRule>(
    context.principal.id,
    ruleRecord(context, input, deps.clock().toISOString()),
    context.clientOpId,
  );
  if (!written.ok) return b3fail(written.error);
  const armed = await ensureDeadline(deps, context.principal, written.value);
  return armed.ok ? b3ok(written.value) : b3fail(armed.error);
}

async function supersedeDeadlines(
  deps: RuleDependencies,
  rule: WatchRule,
  context: CommandContext,
): Promise<B3Result<null>> {
  const deadlines = await deps.store.list<WatchDeadline>('watchDeadline');
  if (!deadlines.ok) return b3fail(deadlines.error);
  for (const deadline of deadlines.value) {
    if (deadline.watchRuleId !== rule.id
      || deadline.state === 'fired' || deadline.state === 'superseded') continue;
    const written = await deps.store.update<WatchDeadline>(
      SUPERVISION_RECORD_WRITER,
      deadline.id,
      { state: 'superseded' },
      deadline.recordVersion,
      deriveClientOpId(
        'b3v4:supersede-watch-deadline:' + context.clientOpId + ':' + deadline.id,
      ),
    );
    if (!written.ok) return b3fail(written.error);
  }
  return b3ok(null);
}

/** Exact-CAS replacement; retirement is lifecycle, never deletion. */
export async function updateWatchRule(
  deps: RuleDependencies,
  context: CommandContext,
  input: UpdateWatchRuleInput,
): Promise<B3Result<WatchRule>> {
  const authorized = authorize(context, input.replacement);
  if (!authorized.ok) return b3fail(authorized.error);
  const current = await deps.store.read<WatchRule>('watchRule', input.watchRuleId);
  if (!current.ok) return b3fail(current.error);
  if (current.value === null
    || Number(current.value.recordVersion) !== Number(input.expectedRecordVersion)) {
    return b3fail(b3err(
      'WatcherConflict', 'the WatchRule replacement fence does not match current truth',
      {
        watchRuleId: input.watchRuleId,
        expectedRecordVersion: input.expectedRecordVersion,
        actualRecordVersion: current.value?.recordVersion,
      },
      true,
    ));
  }
  const written = await deps.store.update<WatchRule>(
    context.principal.id,
    current.value.id,
    {
      ...input.replacement,
      driftPolicy: input.replacement.driftPolicy,
      action: input.replacement.action,
    },
    current.value.recordVersion,
    context.clientOpId,
  );
  if (!written.ok) return b3fail(written.error);
  if (written.value.status !== 'active') {
    const superseded = await supersedeDeadlines(deps, written.value, context);
    return superseded.ok ? b3ok(written.value) : b3fail(superseded.error);
  }
  const armed = await ensureDeadline(deps, context.principal, written.value);
  return armed.ok ? b3ok(written.value) : b3fail(armed.error);
}
