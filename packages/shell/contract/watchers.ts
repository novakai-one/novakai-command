/** Shell-owned projection of Supervision watcher truth. */
export type WatcherSubjectView =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'agent-run'; readonly agentRunId: string }
  | { readonly kind: 'children-of'; readonly agentId: string };

export interface WatchRuleView {
  readonly id: string;
  readonly subject: WatcherSubjectView;
  readonly condition: { readonly kind: string };
  readonly recipient:
    | { readonly kind: 'agent'; readonly agentId: string }
    | { readonly kind: 'human'; readonly principalId: string };
  readonly deliveryMode: string;
  readonly status: string;
  readonly recordVersion: number;
}

export interface WatchDeadlineView {
  readonly id: string;
  readonly watchRuleId: string;
  readonly state: string;
  readonly dueAt: string;
  readonly activityGeneration: number;
  readonly driftPhase?: string;
}

export interface WatcherListView {
  readonly rules: readonly WatchRuleView[];
  readonly deadlines: readonly WatchDeadlineView[];
  readonly omissions: readonly {
    readonly reason: 'permission' | 'unsupported-version';
    readonly count: number;
  }[];
}
