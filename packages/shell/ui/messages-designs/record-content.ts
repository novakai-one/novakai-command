/**
 * What an inspector shows, chosen by object kind.
 *
 * Without this table the inspector degrades into an unlabelled attribute dump — every
 * object rendered as the same list of whatever fields it happened to carry. The kind
 * decides which facts matter and in what order.
 */
import type { ObjectKind, ObjectRecord, RelationType } from './contract';

export type FactSpec = { label: string; from: string };

const FACTS: Partial<Record<ObjectKind, readonly FactSpec[]>> = {
  mission: [
    { label: 'Status', from: 'status' },
    { label: 'Priority', from: 'priority' },
    { label: 'Updated', from: 'updated' },
  ],
  project: [
    { label: 'Status', from: 'status' },
    { label: 'Focus', from: 'focus' },
    { label: 'Path', from: 'path' },
  ],
  stage: [
    { label: 'Status', from: 'status' },
    { label: 'Done when', from: 'condition' },
  ],
  task: [
    { label: 'Status', from: 'status' },
    { label: 'Priority', from: 'priority' },
    { label: 'Blocked by', from: 'blockedReason' },
  ],
  agent: [
    { label: 'Status', from: 'status' },
    { label: 'Provider', from: 'provider' },
    { label: 'Session', from: 'sessionId' },
  ],
  agentRun: [
    { label: 'Status', from: 'status' },
    { label: 'Started', from: 'startedAt' },
    { label: 'Ended', from: 'endedAt' },
  ],
  loop: [
    { label: 'Status', from: 'status' },
    { label: 'Goal', from: 'goal' },
  ],
  step: [
    { label: 'Status', from: 'status' },
    { label: 'Action', from: 'action' },
    { label: 'Context', from: 'context' },
    { label: 'Result', from: 'result' },
  ],
  request: [
    { label: 'Status', from: 'status' },
    { label: 'Answer', from: 'answer' },
  ],
  decision: [{ label: 'Recorded', from: 'ts' }],
  issue: [
    { label: 'Status', from: 'status' },
    { label: 'Severity', from: 'severity' },
  ],
  artifact: [
    { label: 'Path', from: 'path' },
    { label: 'Link', from: 'url' },
  ],
  evidence: [
    { label: 'Method', from: 'method' },
    { label: 'Result', from: 'result' },
  ],
  agentRoleProfile: [
    { label: 'Status', from: 'status' },
    { label: 'Permission', from: 'permissionLevel' },
  ],
  teamSeat: [],
  team: [],
  thread: [],
  message: [{ label: 'Sent', from: 'createdAt' }],
};

/** The one-line summary under the title. Kind-specific, and never a repeat of the title. */
const SUMMARY: Partial<Record<ObjectKind, string>> = {
  mission: 'notes',
  project: 'focus',
  stage: 'condition',
  task: 'notes',
  issue: 'body',
  decision: 'body',
  request: 'question',
  evidence: 'claim',
  agentRoleProfile: 'description',
  loop: 'goal',
  step: 'prompt',
  message: 'body',
};

/** Relations worth a section, in the order a person reads them, by kind. */
const RELATIONS: Partial<Record<ObjectKind, readonly RelationType[]>> = {
  mission: ['belongsTo', 'contains', 'staffedBy', 'discussedIn', 'produces', 'blockedBy', 'hasIssue', 'createdFrom'],
  project: ['contains', 'pinnedBy'],
  stage: ['belongsTo', 'contains', 'blockedBy'],
  task: ['belongsTo', 'assignedTo', 'attemptedBy', 'pursuedBy', 'blockedBy', 'produces', 'citedBy'],
  agent: ['staffedBy', 'occupies', 'contains', 'assigned', 'discussedIn'],
  agentRoleProfile: ['requestedBy', 'assigned', 'pinnedBy'],
  teamSeat: ['belongsTo', 'requests', 'occupiedBy'],
  team: ['belongsTo', 'contains'],
  agentRun: ['belongsTo', 'attempts', 'contains'],
  loop: ['belongsTo', 'pursues', 'contains'],
  step: ['belongsTo'],
  request: ['blocks', 'resolvedBy'],
  decision: ['resolves'],
  issue: ['raisedAgainst'],
  artifact: ['producedBy', 'citedBy'],
  evidence: ['cites'],
  thread: ['discusses', 'contains'],
  message: ['belongsTo', 'references', 'producedBy'],
  notification: ['about'],
  pin: ['pins'],
  missionTemplate: ['originOf'],
};

export function factsFor(record: ObjectRecord): FactSpec[] {
  return (FACTS[record.kind] ?? [{ label: 'Created', from: 'ts' }]).filter((fact) => {
    const value = record.fields[fact.from];
    return typeof value === 'string' && value.length > 0;
  });
}

export function summaryFor(record: ObjectRecord): string {
  const key = SUMMARY[record.kind];
  if (!key) return '';
  const value = record.fields[key];
  return typeof value === 'string' && value !== record.title ? value : '';
}

export function relationsFor(kind: ObjectKind): readonly RelationType[] {
  return RELATIONS[kind] ?? ['belongsTo', 'contains', 'references'];
}
