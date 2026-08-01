// The field readers a role profile is built out of (§4.2, §5.2).
//
// Split from `validate.ts` so each file states one thing: this one knows what a
// POLICY looks like, that one knows what a BOUNDARY PAYLOAD looks like.
import type { FieldReader } from '@novakai/foundation/contract';
import type { AgentRoleProfileId } from '@novakai/foundation/contract';
import {
  CONTINUATION_MODES, PROVIDER_KINDS,
  type BudgetPolicy, type ContinuationMode, type EffortPolicy, type LifecyclePolicy,
  type ModelPolicy, type ProviderKind, type ProviderPolicy, type RoleSupervisionPolicy,
  type SkillsConfirmationGate, type SpawnPolicy, type VersionedRef,
} from './records.js';

/** A list of plain strings, reported as one issue rather than N. */
export function textList(field: FieldReader, path: string): readonly string[] {
  const value = field.given(path);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    field.reject(path, 'must be an array of non-empty strings');
    return [];
  }
  return value as readonly string[];
}

export function choiceList<Value extends string>(
  field: FieldReader, path: string, allowed: readonly Value[],
): readonly Value[] {
  const value = field.given(path);
  if (!Array.isArray(value) || value.some((item) => !allowed.includes(item as Value))) {
    field.reject(path, `must be an array of: ${allowed.join(', ')}`);
    return [];
  }
  return value as readonly Value[];
}

export function idList<Id extends string>(field: FieldReader, path: string, prefix: string): readonly Id[] {
  const value = field.given(path);
  const wrong = !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || !item.startsWith(`${prefix}_`));
  if (wrong) {
    field.reject(path, `must be an array of ${prefix} identifiers`);
    return [];
  }
  return value as readonly Id[];
}

export function refList(field: FieldReader, path: string): readonly VersionedRef[] {
  const value = field.given(path);
  const wrong = !Array.isArray(value) || value.some((item) => !isVersionedRef(item));
  if (wrong) {
    field.reject(path, 'must be an array of {id, version, digest}');
    return [];
  }
  return value as readonly VersionedRef[];
}

function isVersionedRef(candidate: unknown): boolean {
  if (candidate === null || typeof candidate !== 'object') return false;
  const item = candidate as Record<string, unknown>;
  return typeof item['id'] === 'string' && item['id'] !== ''
    && typeof item['version'] === 'number' && Number.isInteger(item['version'])
    && typeof item['digest'] === 'string' && item['digest'] !== '';
}

export function versionedRef(field: FieldReader, path: string): VersionedRef {
  const value = field.given(path);
  if (!isVersionedRef(value)) {
    field.reject(path, 'must be {id, version, digest}');
    return { id: '', version: 0, digest: '' };
  }
  return value as VersionedRef;
}

export function providerPolicy(field: FieldReader): ProviderPolicy {
  const nested = field.nested('providerPolicy');
  const allowed = choiceList<ProviderKind>(nested, 'allowed', PROVIDER_KINDS);
  const defaultProvider = nested.choice<ProviderKind>('defaultProvider', PROVIDER_KINDS);
  if (allowed.length === 0) nested.reject('allowed', 'must permit at least one provider');
  else if (!allowed.includes(defaultProvider)) {
    nested.reject('defaultProvider', 'must be one of the allowed providers');
  }
  return { allowed, defaultProvider };
}

export function modelPolicy(field: FieldReader): ModelPolicy {
  const nested = field.nested('modelPolicy');
  const allowedModelIds = textList(nested, 'allowedModelIds');
  const defaultModelId = nested.text('defaultModelId');
  if (allowedModelIds.length > 0 && !allowedModelIds.includes(defaultModelId)) {
    nested.reject('defaultModelId', 'must be one of the allowed models');
  }
  return {
    allowedModelIds,
    defaultModelId,
    allowNativeChange: flag(nested, 'allowNativeChange'),
    allowReplacementChange: flag(nested, 'allowReplacementChange'),
  };
}

export function effortPolicy(field: FieldReader): EffortPolicy {
  const nested = field.nested('effortPolicy');
  const allowed = textList(nested, 'allowed');
  const defaultEffort = nested.text('defaultEffort');
  if (allowed.length > 0 && !allowed.includes(defaultEffort)) {
    nested.reject('defaultEffort', 'must be one of the allowed efforts');
  }
  return { allowed, defaultEffort };
}

export function flag(field: FieldReader, path: string): boolean {
  const value = field.given(path);
  if (typeof value !== 'boolean') {
    field.reject(path, 'must be true or false');
    return false;
  }
  return value;
}

export function spawnPolicy(field: FieldReader): SpawnPolicy {
  const nested = field.nested('spawnPolicy');
  const maxDepth = nested.optionalCount('maxDepth', 1, 64);
  const maxLiveChildren = nested.optionalCount('maxLiveChildren', 0, 4096);
  return {
    allowedChildRoleIds: idList<AgentRoleProfileId>(nested, 'allowedChildRoleIds', 'agentRole'),
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(maxLiveChildren === undefined ? {} : { maxLiveChildren }),
    requireManagedSpawn: flag(nested, 'requireManagedSpawn'),
  };
}

/**
 * The gate is a discriminated union, and the discriminator decides which of two
 * completely different shapes must be present. Reading it as one flat object
 * would let a `disabled` gate smuggle in a marker it will never honour.
 */
export function skillsGate(field: FieldReader): SkillsConfirmationGate {
  const nested = field.nested('skillsConfirmationGate');
  const mode = nested.choice('mode', ['disabled', 'required-two-turn'] as const);
  if (mode === 'disabled') {
    return {
      mode: 'disabled',
      allowedFor: nested.choice('allowedFor', ['interactive-chat-only'] as const),
    };
  }
  return {
    mode: 'required-two-turn',
    confirmationMarker: nested.choice('confirmationMarker', ['SKILLS-CONFIRMED:'] as const),
    confirmationTokenFormat: nested.choice(
      'confirmationTokenFormat', ['skill-id@v<version>#<digest>'] as const,
    ),
    comparison: nested.choice('comparison', ['exact-set-canonical-order'] as const),
    subagentEvidenceMarker: nested.choice('subagentEvidenceMarker', ['SUBAGENT-SKILLS:'] as const),
    providerNativeSubagentPolicy: nested.choice('providerNativeSubagentPolicy',
      ['managed-only-for-supervised-work', 'observe-advisory'] as const),
    onFailure: nested.choice('onFailure', ['terminate-run-and-record-drift'] as const),
  };
}

export function lifecyclePolicy(field: FieldReader): LifecyclePolicy {
  const nested = field.nested('lifecyclePolicy');
  const allowedContinuationModes = choiceList<ContinuationMode>(
    nested, 'allowedContinuationModes', CONTINUATION_MODES,
  );
  return {
    onTaskComplete: nested.choice('onTaskComplete',
      ['keep-running', 'stop-run', 'request-decision'] as const),
    onSupervisorFinal: nested.choice('onSupervisorFinal',
      ['assign-human', 'assign-nearest-live-ancestor', 'remain-orphaned'] as const),
    allowedContinuationModes,
  };
}

export function supervisionPolicy(field: FieldReader): RoleSupervisionPolicy {
  const nested = field.nested('supervisionPolicy');
  return {
    requiredWatcherTemplates: refList(nested, 'requiredWatcherTemplates'),
    parentNotificationMode: nested.choice('parentNotificationMode',
      ['queue-only', 'next-turn-context', 'start-turn'] as const),
  };
}

export function budgetPolicy(field: FieldReader): BudgetPolicy {
  const nested = field.nested('budgetPolicy');
  const inputTokenSoftLimit = nested.optionalCount('inputTokenSoftLimit', 0, Number.MAX_SAFE_INTEGER);
  const outputTokenSoftLimit = nested.optionalCount('outputTokenSoftLimit', 0, Number.MAX_SAFE_INTEGER);
  const costSoftLimitMicros = nested.optionalCount('costSoftLimitMicros', 0, Number.MAX_SAFE_INTEGER);
  const turnSoftLimit = nested.optionalCount('turnSoftLimit', 0, Number.MAX_SAFE_INTEGER);
  return {
    ...(inputTokenSoftLimit === undefined ? {} : { inputTokenSoftLimit }),
    ...(outputTokenSoftLimit === undefined ? {} : { outputTokenSoftLimit }),
    ...(costSoftLimitMicros === undefined ? {} : { costSoftLimitMicros }),
    ...(turnSoftLimit === undefined ? {} : { turnSoftLimit }),
    hardStopEnabled: flag(nested, 'hardStopEnabled'),
  };
}

