import {
  b3err, b3fail, b3ok, deriveClientOpId,
  type AuthenticatedPrincipal, type B3PrincipalId, type B3Result,
} from '@novakai/foundation/contract';
import {
  deriveNotificationId, isProviderUsageEvidenceId, subjectKey, watchOccurrenceFamily,
  type ConditionOccurrence, type Notification,
  type RunOccurrenceEventFacts,
  type WatchEvaluationId, type WatchEvaluationRuleOutcome,
  type WatchOccurrenceRelationshipAuthority, type WatchRule,
} from '../contract/index.js';
import type { Persisted, SupervisionStore } from './store.js';
import type { UsageEvidenceReader, UsageRunReader } from './usage/index.js';

export interface OrdinaryCommitDependencies {
  readonly store: SupervisionStore;
  readonly runs?: UsageRunReader;
  readonly evidence?: UsageEvidenceReader;
  readonly relationships?: WatchOccurrenceRelationshipAuthority;
}

export interface OrdinaryCommitResult {
  readonly outcome: WatchEvaluationRuleOutcome;
  readonly notification?: Notification;
}

interface ResolvedLegacy {
  readonly qualifiedAt: string;
  readonly activityGeneration: number;
  readonly occurrenceKey: string;
  readonly sameCondition: boolean;
}

const isV2Ordinary = (notification: Notification): notification is Extract<
  Notification,
  { readonly schemaVersion: 2; readonly phase: 'condition' }
> => notification.schemaVersion === 2 && notification.phase === 'condition';

function recovery(
  operationId: WatchEvaluationId,
  stage: 'occurrence-derivation' | 'legacy-occurrence-adoption' | 'rule-version-fence',
  reason: string,
) {
  return b3err('RecoveryRequired', reason, { operationId, stage, reason }, true);
}

function occurrenceKey(notification: Persisted<Notification> & Record<string, unknown>): string {
  if (notification.schemaVersion !== 2) {
    return `L:${String(notification.conditionGeneration)}`;
  }
  if (notification.occurrenceIdentity === 'legacy-generation') {
    return `L:${String(notification.conditionGeneration)}`;
  }
  const occurrence = notification.conditionOccurrence as NonNullable<
    Extract<Notification, { readonly schemaVersion: 2 }>['conditionOccurrence']
  >;
  if (occurrence.kind === 'agent-run' || occurrence.kind === 'run-final') {
    return `AR:${String(occurrence.agentRunId)}`;
  }
  if (occurrence.kind === 'committed-event') {
    return `EV:${String(occurrence.eventId)}`;
  }
  return `OP:${String(occurrence.runOperationId)}`;
}

function eventOccurrenceKey(
  family: ReturnType<typeof watchOccurrenceFamily>,
  facts: RunOccurrenceEventFacts,
): string | null {
  if (family === 'AR') return `AR:${String(facts.agentRunId)}`;
  if (family === 'EV') return `EV:${facts.eventId}`;
  if (family === 'OP' && facts.occurrenceKind === 'operation-failed') {
    return `OP:${String(facts.occurrence.runOperationId)}`;
  }
  if (family === 'L') return `L:${String(facts.activityGeneration)}`;
  return null;
}

/** Owner-validate one immutable legacy row; no createdAt/query-time fallback. */
async function resolveLegacy(
  deps: OrdinaryCommitDependencies,
  principal: AuthenticatedPrincipal,
  rule: WatchRule,
  legacy: Notification,
  operationId: WatchEvaluationId,
): Promise<B3Result<ResolvedLegacy>> {
  const family = watchOccurrenceFamily(rule.subject, rule.condition);
  const references = [...new Set(legacy.evidenceRefs.map(String))];
  if (references.length === 0) {
    return b3fail(recovery(
      operationId,
      'legacy-occurrence-adoption',
      `legacy Notification ${String(legacy.id)} has no owner-validatable evidence`,
    ));
  }

  const usageCondition = [
    'turn-count-at-least', 'input-tokens-at-least',
    'output-tokens-at-least', 'cost-micros-at-least',
  ].includes(rule.condition.kind);
  if (usageCondition && family === 'L') {
    if (deps.runs?.getRunOccurrenceEvent === undefined
      || deps.runs.resolveUsageRunByProviderSession === undefined
      || deps.evidence?.getProviderUsageEvidence === undefined) {
      return b3fail(recovery(
        operationId,
        'legacy-occurrence-adoption',
        `legacy L-usage Notification ${String(legacy.id)} lacks composed owner lookups`,
      ));
    }
    let selected: Extract<RunOccurrenceEventFacts, {
      readonly occurrenceKind: 'usage-generation';
    }> | undefined;
    let qualifiedAt: string | undefined;
    for (const ref of references) {
      const source = await deps.runs.getRunOccurrenceEvent(principal, ref);
      if (!source.ok) return source;
      if (source.value === null
        || source.value.kind !== 'agent.run.usage.changed'
        || source.value.occurrenceKind !== 'usage-generation') {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy L-usage Notification ${String(legacy.id)} cannot validate Runtime source ${ref}`,
        ));
      }
      const evidence = await deps.evidence.getProviderUsageEvidence(
        principal, source.value.occurrence.qualifyingEvidenceRef,
      );
      if (!evidence.ok) return evidence;
      if (evidence.value === null) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy L-usage Notification ${String(legacy.id)} cites absent Agents evidence`,
        ));
      }
      const bound = await deps.runs.resolveUsageRunByProviderSession(
        principal, evidence.value.providerSessionId,
      );
      if (!bound.ok) return bound;
      if (bound.value === null
        || bound.value.agentRunId !== source.value.agentRunId
        || bound.value.providerSessionId !== source.value.providerSessionId
        || source.value.occurrence.qualifyingEvidenceRef !== evidence.value.id
        || rule.subject.kind !== 'agent-run'
        || rule.subject.agentRunId !== source.value.agentRunId) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy L-usage Notification ${String(legacy.id)} has contradictory owner provenance`,
        ));
      }
      if (selected !== undefined
        && (selected.eventId !== source.value.eventId
          || selected.activityGeneration !== source.value.activityGeneration
          || qualifiedAt !== evidence.value.observedAt)) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy L-usage Notification ${String(legacy.id)} has ambiguous Runtime sources`,
        ));
      }
      selected = source.value;
      qualifiedAt = evidence.value.observedAt;
    }
    if (selected === undefined || qualifiedAt === undefined) {
      return b3fail(recovery(
        operationId,
        'legacy-occurrence-adoption',
        `legacy L-usage Notification ${String(legacy.id)} has absent Runtime provenance/time`,
      ));
    }
    const expectedLegacyId = deriveNotificationId({
      watchRuleId: rule.id,
      subjectKey: subjectKey(rule.subject),
      condition: rule.condition,
      activityGeneration: legacy.conditionGeneration as never,
      phase: 'condition',
    });
    return b3ok({
      qualifiedAt,
      activityGeneration: Number(selected.activityGeneration),
      occurrenceKey: `L:${String(selected.activityGeneration)}`,
      sameCondition: expectedLegacyId === legacy.id,
    });
  }
  if (usageCondition) {
    if (deps.runs?.resolveUsageRunByProviderSession === undefined
      || deps.evidence?.getProviderUsageEvidence === undefined) {
      return b3fail(recovery(
        operationId,
        'legacy-occurrence-adoption',
        `legacy usage Notification ${String(legacy.id)} lacks composed owner lookups`,
      ));
    }
    let resolvedSession: string | undefined;
    let resolvedRun: string | undefined;
    let resolvedAgent: string | undefined;
    let qualifiedAt: string | undefined;
    for (const ref of references) {
      if (!isProviderUsageEvidenceId(ref)) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy usage Notification ${String(legacy.id)} has non-usage evidence ${ref}`,
        ));
      }
      const evidence = await deps.evidence.getProviderUsageEvidence(principal, ref);
      if (!evidence.ok) return evidence;
      if (evidence.value === null) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy usage Notification ${String(legacy.id)} cannot validate evidence ${ref}`,
        ));
      }
      const source = await deps.runs.resolveUsageRunByProviderSession(
        principal,
        evidence.value.providerSessionId,
      );
      if (!source.ok) return source;
      if (source.value === null) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy usage Notification ${String(legacy.id)} names no retained Run for ${ref}`,
        ));
      }
      if (source.value.providerSessionId !== evidence.value.providerSessionId) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy usage Notification ${String(legacy.id)} has a Run/ProviderSession mismatch`,
        ));
      }
      if ((resolvedSession !== undefined
          && resolvedSession !== evidence.value.providerSessionId)
        || (resolvedRun !== undefined && resolvedRun !== source.value.agentRunId)
        || (resolvedAgent !== undefined && resolvedAgent !== source.value.agentId)
        || (qualifiedAt !== undefined && qualifiedAt !== evidence.value.observedAt)) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy usage Notification ${String(legacy.id)} has contradictory `
            + 'ProviderSession, Run, or evidence-time provenance',
        ));
      }
      resolvedSession = evidence.value.providerSessionId;
      resolvedRun = source.value.agentRunId;
      resolvedAgent = source.value.agentId;
      qualifiedAt = evidence.value.observedAt;
    }
    if (resolvedRun === undefined || qualifiedAt === undefined) {
      return b3fail(recovery(
        operationId,
        'legacy-occurrence-adoption',
        `legacy usage Notification ${String(legacy.id)} has absent owner provenance/time`,
      ));
    }
    const subjectMatches = rule.subject.kind === 'agent-run'
      ? resolvedRun === rule.subject.agentRunId
      : rule.subject.kind === 'agent'
        ? resolvedAgent === rule.subject.agentId
        : undefined;
    if (subjectMatches === false) {
      return b3fail(recovery(
        operationId,
        'legacy-occurrence-adoption',
        `legacy usage Notification ${String(legacy.id)} provenance does not match its subject`,
      ));
    }
    if (rule.subject.kind === 'children-of') {
      if (deps.relationships === undefined || resolvedAgent === undefined) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy usage Notification ${String(legacy.id)} lacks managed-child authority`,
        ));
      }
      const related = await deps.relationships.isDirectManagedChild(principal, {
        parentAgentId: rule.subject.agentId,
        childAgentId: resolvedAgent as never,
      });
      if (!related.ok) return related;
      if (!related.value) {
        return b3fail(recovery(
          operationId,
          'legacy-occurrence-adoption',
          `legacy usage Notification ${String(legacy.id)} provenance names a non-child Run`,
        ));
      }
    }
    const expectedLegacyId = deriveNotificationId({
      watchRuleId: rule.id,
      subjectKey: subjectKey(rule.subject),
      condition: rule.condition,
      activityGeneration: legacy.conditionGeneration as never,
      phase: 'condition',
    });
    return b3ok({
      qualifiedAt,
      activityGeneration: legacy.conditionGeneration,
      occurrenceKey: family === 'AR'
        ? `AR:${resolvedRun}`
        : `L:${String(legacy.conditionGeneration)}`,
      sameCondition: expectedLegacyId === legacy.id,
    });
  }

  for (const ref of references) {
    if (deps.runs?.getRunOccurrenceEvent !== undefined) {
      const source = await deps.runs.getRunOccurrenceEvent(principal, ref);
      if (!source.ok) return source;
      if (source.value !== null) {
        const key = eventOccurrenceKey(family, source.value);
        if (key === null) continue;
        const expectedLegacyId = deriveNotificationId({
          watchRuleId: rule.id,
          subjectKey: subjectKey(rule.subject),
          condition: rule.condition,
          activityGeneration: source.value.activityGeneration,
          phase: 'condition',
        });
        return b3ok({
          qualifiedAt: source.value.occurredAt,
          activityGeneration: Number(source.value.activityGeneration),
          occurrenceKey: key,
          sameCondition: expectedLegacyId === legacy.id,
        });
      }
    }

    const deadlineMatch = /^watch-deadline:(watchDeadline_[a-z2-7]{52}):due:/u.exec(ref);
    if (deadlineMatch !== null) {
      const deadline = await deps.store.read<import('../contract/index.js').WatchDeadline>(
        'watchDeadline', deadlineMatch[1]!,
      );
      if (!deadline.ok) return deadline;
      if (deadline.value !== null) {
        const expectedLegacyId = deriveNotificationId({
          watchRuleId: rule.id,
          subjectKey: subjectKey(rule.subject),
          condition: rule.condition,
          activityGeneration: deadline.value.activityGeneration,
          phase: 'condition',
        });
        return b3ok({
          qualifiedAt: deadline.value.dueAt,
          activityGeneration: Number(deadline.value.activityGeneration),
          occurrenceKey: `L:${String(deadline.value.activityGeneration)}`,
          sameCondition: expectedLegacyId === legacy.id,
        });
      }
    }
  }

  return b3fail(recovery(
    operationId,
    'legacy-occurrence-adoption',
    `legacy Notification ${String(legacy.id)} has absent or ambiguous owner provenance/time`,
  ));
}

function latestAnchor(
  anchors: readonly { readonly id: string; readonly qualifiedAt: string }[],
): { readonly id: string; readonly qualifiedAt: string } | null {
  return anchors.reduce<null | { readonly id: string; readonly qualifiedAt: string }>(
    (latest, candidate) => latest === null
      || candidate.qualifiedAt > latest.qualifiedAt
      || (candidate.qualifiedAt === latest.qualifiedAt && candidate.id > latest.id)
      ? candidate
      : latest,
    null,
  );
}

/**
 * AMD-003's complete owner decision. Callers invoke this only while holding
 * the shared Supervision owner linearizer.
 */
export async function commitOrdinaryNotification(
  deps: OrdinaryCommitDependencies,
  principal: AuthenticatedPrincipal,
  evaluatedRule: WatchRule,
  candidate: Persisted<Notification> & Record<string, unknown>,
  operationId: WatchEvaluationId,
): Promise<B3Result<OrdinaryCommitResult>> {
  const current = await deps.store.read<WatchRule>('watchRule', evaluatedRule.id);
  if (!current.ok) return current;
  if (current.value === null || current.value.status !== 'active') {
    return b3ok({ outcome: { kind: 'inactive-current-policy' } });
  }
  if (Number(current.value.recordVersion) !== Number(evaluatedRule.recordVersion)) {
    return b3fail(b3err(
      'VersionConflict',
      'WatchRule changed before its occurrence decision could commit',
      {
        operationId,
        stage: 'rule-version-fence',
        watchRuleId: evaluatedRule.id,
        expectedRecordVersion: evaluatedRule.recordVersion,
        actualRecordVersion: current.value.recordVersion,
      },
      true,
    ));
  }

  const all = await deps.store.list<Notification>('notification');
  if (!all.ok) return all;
  const keyedSubject = subjectKey(current.value.subject);
  const stream = all.value.filter((notification) => notification.phase === 'condition'
    && notification.watchRuleId === current.value!.id
    && subjectKey(notification.subject) === keyedSubject);

  const exact = stream.find((notification) => notification.id === candidate.id);
  if (exact !== undefined) {
    return b3ok({ outcome: { kind: 'adopted', notificationId: exact.id } });
  }

  const candidateKey = occurrenceKey(candidate);
  const legacyIds: Notification['id'][] = [];
  const anchors: { id: string; qualifiedAt: string }[] = [];
  for (const notification of stream) {
    if (isV2Ordinary(notification)) {
      anchors.push({ id: String(notification.id), qualifiedAt: notification.qualifiedAt });
      continue;
    }
    const resolved = await resolveLegacy(deps, principal, current.value, notification, operationId);
    if (!resolved.ok) return resolved;
    anchors.push({ id: String(notification.id), qualifiedAt: resolved.value.qualifiedAt });
    if (resolved.value.sameCondition && resolved.value.occurrenceKey === candidateKey) {
      legacyIds.push(notification.id);
    }
  }
  if (legacyIds.length > 0) {
    return b3ok({
      outcome: { kind: 'legacy-adopted', legacyIds: legacyIds.sort() },
    });
  }

  const qualifiedAt = String(candidate.qualifiedAt);
  const anchor = latestAnchor(anchors);
  if (current.value.cooldownMs > 0 && anchor !== null
    && Date.parse(qualifiedAt) < Date.parse(anchor.qualifiedAt) + current.value.cooldownMs) {
    return b3ok({ outcome: { kind: 'cooldown-suppressed', qualifiedAt: qualifiedAt as never } });
  }

  let committable = candidate;
  if (candidate.schemaVersion === 2
    && candidate.deliveryMode === 'next-turn-context'
    && candidate.subject.kind === 'agent'
    && candidate.occurrenceIdentity !== 'legacy-generation') {
    if (deps.runs?.resolveCurrentRunByAgent === undefined) {
      return b3fail(b3err(
        'RuntimeUnavailable', 'current-Run delivery-fence authority is not composed',
        { operationId, stage: 'occurrence-derivation', reason: 'current-run-query-not-composed' },
        true,
      ));
    }
    const target = await deps.runs.resolveCurrentRunByAgent(principal, candidate.subject.agentId);
    if (!target.ok) return target;
    const sourceRunId = (candidate.conditionOccurrence as ConditionOccurrence).agentRunId;
    if (target.value !== null && target.value.agentRunId !== sourceRunId) {
      committable = {
        ...candidate,
        deliveryFence: {
          targetAgentRunId: target.value.agentRunId,
          baselineActivityGeneration: target.value.activityGeneration,
          boundAt: candidate.qualifiedAt,
        },
      };
    }
  }

  const written = await deps.store.create<Notification>(
    'sys_supervision' as B3PrincipalId,
    committable,
    // The occurrence ID, not delivery/evaluation time, is the logical effect.
    deriveClientOpId(`b3v4:ordinary-notification:${String(candidate.id)}`),
  );
  if (!written.ok) {
    const raced = await deps.store.read<Notification>('notification', candidate.id);
    return raced.ok && raced.value !== null
      ? b3ok({ outcome: { kind: 'adopted', notificationId: raced.value.id } })
      : written;
  }
  return b3ok({
    notification: written.value,
    outcome: { kind: 'committed', notificationId: written.value.id },
  });
}
