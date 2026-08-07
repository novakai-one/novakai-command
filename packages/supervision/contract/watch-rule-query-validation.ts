import {
  isValidId,
  readBoundary,
  type AgentId,
  type AgentRunId,
  type EventCursor,
  type FieldReader,
} from '@novakai/foundation/contract';
import type { WatchRuleFilter } from './api.js';
import { isUrlSafeEventCursor } from './event-validation.js';
import type { WatchSubject } from './records.js';

const WATCH_RULE_STATUSES = ['active', 'paused', 'retired'] as const;

/** Runtime parser for the bounded visibility-aware WatchRule query. */
export function parseWatchRuleFilter(candidate: unknown) {
  return readBoundary<WatchRuleFilter>(candidate, (field) => {
    const rawStatuses = field.given('status');
    const statuses = rawStatuses === undefined
      ? undefined
      : readWatchRuleStatuses(rawStatuses, field);
    const cursor = field.optionalText('cursor') as EventCursor | undefined;
    if (cursor !== undefined && !isUrlSafeEventCursor(cursor)) {
      field.reject('cursor', 'must be a non-empty URL-safe string');
    }
    const rawSubject = field.given('subject');
    const subject = rawSubject === undefined ? undefined : readWatchSubject(rawSubject, field);
    return {
      ...(subject === undefined ? {} : { subject }),
      ...(statuses === undefined ? {} : { status: statuses }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: field.count('limit', 1, Number.MAX_SAFE_INTEGER),
    };
  });
}

function readWatchSubject(value: unknown, field: FieldReader): WatchSubject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    field.reject('subject', 'must be an object');
    return { kind: 'agent', agentId: '' as AgentId };
  }
  const subject = value as Readonly<Record<string, unknown>>;
  if (subject.kind === 'agent' || subject.kind === 'children-of') {
    if (!isValidId(subject.agentId, 'agent', 'uuidv4')) {
      field.reject('subject.agentId', 'must be an agent identifier');
    }
    return { kind: subject.kind, agentId: subject.agentId as AgentId };
  }
  if (subject.kind === 'agent-run') {
    if (!isValidId(subject.agentRunId, 'agentRun', 'uuidv7')) {
      field.reject('subject.agentRunId', 'must be an AgentRun identifier');
    }
    return { kind: 'agent-run', agentRunId: subject.agentRunId as AgentRunId };
  }
  field.reject('subject.kind', 'must be one of: agent, agent-run, children-of');
  return { kind: 'agent', agentId: '' as AgentId };
}

function readWatchRuleStatuses(value: unknown, field: FieldReader): WatchRuleFilter['status'] {
  if (!Array.isArray(value)) {
    field.reject('status', 'must be an array');
    return [];
  }
  const invalid = value.find((item) => !WATCH_RULE_STATUSES.includes(item as never));
  if (invalid !== undefined) field.reject('status', 'contains an unknown WatchRule status');
  return value as WatchRuleFilter['status'];
}
