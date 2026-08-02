// Where a pinned `VersionedRef` becomes an actual watcher (Q5, §13.5).
//
// The frozen contract publishes ONE implicit template body — activity-drift —
// and rules that every other role watcher arrives as an explicit
// `requiredWatcherTemplates` ref. It does not publish the catalogue those refs
// resolve against, because the catalogue is role-profile data rather than
// contract. So resolution is a SEAM: the tracer ships the smallest catalogue
// that can carry current, and lane B replaces it with the real role catalogue
// without the engine above it changing.
//
// A ref is honoured only when its pinned digest matches the body this
// catalogue holds. A launch plan pinned to a template body that has since
// changed is refused rather than silently launched against the new one.
import { createHash } from 'node:crypto';
import {
  ACTIVITY_DRIFT_TEMPLATE, ACTIVITY_DRIFT_TEMPLATE_REF,
  type DriftCheckPolicy, type VersionedRef, type WatchCondition, type WatchRule,
} from '../contract/index.js';

/** One resolvable watcher body. Bindings are resolved by the installer. */
export interface WatcherTemplate {
  readonly templateRef: VersionedRef;
  readonly condition: WatchCondition;
  readonly deliveryMode: WatchRule['deliveryMode'];
  readonly cooldownMs: number;
  readonly driftPolicy?: DriftCheckPolicy;
}

/** The seam lane B replaces with the real role-profile catalogue. */
export interface WatcherTemplatePort {
  resolve(wanted: VersionedRef): WatcherTemplate | null;
}

/** RFC 8785-shaped canonical JSON — the encoding Q5 pins its digests over. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record).sort().map((name) => (
    `${JSON.stringify(name)}:${canonicalJson(record[name])}`
  )).join(',')}}`;
}

/** Q5's digest rule: lowercase SHA-256 over the canonical template payload. */
export function templateDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * The tracer's idle watcher.
 *
 * `idle-for-ms` is a first-class frozen `WatchCondition`, it needs no drift
 * policy and no elevated start-turn scope, and it is the thinnest thing that
 * can arm a durable deadline and fire it. The exact §9.2 activity-drift
 * algorithm is lane B's, and shallow-faking it here would freeze a guess in
 * front of the lane that owns it.
 */
const IDLE_TEMPLATE_PAYLOAD = {
  id: 'watch-template/idle-for-ms',
  version: 1,
  status: 'active',
  subjectBinding: 'current-run',
  condition: { kind: 'idle-for-ms', value: 300_000 },
  recipientBinding: 'current-supervision-assignment-for-escalation',
  deliveryBinding: 'queue-only',
  cooldownMs: 0,
} as const;

/** The pinned reference an explicit `requiredWatcherTemplates` entry carries. */
export const IDLE_WATCH_TEMPLATE_REF: VersionedRef = {
  id: IDLE_TEMPLATE_PAYLOAD.id,
  version: IDLE_TEMPLATE_PAYLOAD.version,
  digest: templateDigest(IDLE_TEMPLATE_PAYLOAD),
};

export const IDLE_WATCH_TEMPLATE: WatcherTemplate = {
  templateRef: IDLE_WATCH_TEMPLATE_REF,
  condition: IDLE_TEMPLATE_PAYLOAD.condition,
  deliveryMode: 'queue-only',
  cooldownMs: IDLE_TEMPLATE_PAYLOAD.cooldownMs,
};

/** The frozen implicit template, resolved through the same one path. */
export const ACTIVITY_DRIFT_WATCH_TEMPLATE: WatcherTemplate = {
  templateRef: ACTIVITY_DRIFT_TEMPLATE_REF,
  condition: ACTIVITY_DRIFT_TEMPLATE.condition,
  deliveryMode: 'queue-only',
  cooldownMs: ACTIVITY_DRIFT_TEMPLATE.cooldownMs,
  driftPolicy: ACTIVITY_DRIFT_TEMPLATE.driftPolicy,
};

const keyOf = (pinned: VersionedRef): string => `${pinned.id}@${String(pinned.version)}`;

/** The catalogue the tracer composes with; extra entries override by ref key. */
export function createTemplateCatalogue(
  extra: readonly WatcherTemplate[] = [],
): WatcherTemplatePort {
  const held = new Map<string, WatcherTemplate>();
  for (const template of [IDLE_WATCH_TEMPLATE, ACTIVITY_DRIFT_WATCH_TEMPLATE, ...extra]) {
    held.set(keyOf(template.templateRef), template);
  }
  return {
    resolve(wanted) {
      const found = held.get(keyOf(wanted));
      if (found === undefined) return null;
      return found.templateRef.digest === wanted.digest ? found : null;
    },
  };
}
