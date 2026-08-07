import React, { useEffect, useState } from 'react';
import type {
  ShellServices, WatchDeadlineView, WatcherListView, WatcherSubjectView,
} from '../../../contract/index.js';
import { answerFrom } from '../../../contract/listAnswer.js';
import {
  EmptyState, ListRow, Panel, ScrollArea, Stack, Text,
} from '../../kit/index.js';
import './watchers.css';

function subjectLabel(subject: WatcherSubjectView): string {
  if (subject.kind === 'agent-run') return subject.agentRunId;
  if (subject.kind === 'children-of') return `children of ${subject.agentId}`;
  return subject.agentId;
}

const words = (value: string): string => value.replaceAll('-', ' ');

function deadlineLabel(deadline: WatchDeadlineView | undefined): string {
  if (deadline === undefined) return 'no current deadline';
  const phase = deadline.driftPhase === undefined ? '' : ` · ${words(deadline.driftPhase)}`;
  return `${words(deadline.state)}${phase} · generation ${String(deadline.activityGeneration)}`
    + ` · due ${new Date(deadline.dueAt).toLocaleString()}`;
}

function omissionLabel(listing: WatcherListView): string | null {
  const hidden = listing.omissions
    .filter((item) => item.reason === 'permission')
    .reduce((total, item) => total + item.count, 0);
  if (hidden === 0) return null;
  return `${String(hidden)} watcher ${hidden === 1 ? 'rule is' : 'rules are'} hidden by permissions.`;
}

export function WatchersView(props: { listing: WatcherListView | null }) {
  // Not-yet-answered is not "no rules": a watcher list that reads empty while
  // it is still being fetched says nothing is being watched, which is the
  // opposite of what a watcher screen is for (contract/listAnswer.ts).
  const answer = answerFrom({
    source: props.listing,
    failure: null,
    rowsOf: (listing: WatcherListView) => listing.rules,
  });
  const rules = answer.kind === 'rows' ? answer.rows : [];
  const omission = props.listing === null ? null : omissionLabel(props.listing);
  return (
    <ScrollArea className="nv-watchers__scroll">
      <Panel head="Watchers">
        <Stack className="nv-watchers">
          {answer.kind === 'waiting' && <EmptyState>Reading watchers…</EmptyState>}
          {answer.kind === 'none' && <EmptyState>No watcher rules yet</EmptyState>}
          {answer.kind === 'rows' && (
            <Stack gap={0} className="nv-watchers__rows">
              {rules.map((rule) => {
                const deadline = props.listing?.deadlines.find(
                  (candidate) => candidate.watchRuleId === rule.id,
                );
                return (
                  <ListRow
                    key={rule.id}
                    label={subjectLabel(rule.subject)}
                    meta={`${words(rule.condition.kind)} · ${words(rule.status)}`
                      + ` · ${words(rule.deliveryMode)} · ${deadlineLabel(deadline)}`}
                  />
                );
              })}
            </Stack>
          )}
          {omission !== null && <Text as="p" className="nv-watchers__omission">{omission}</Text>}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

export function WatchersScreen(props: { services: ShellServices }) {
  const [listing, setListing] = useState<WatcherListView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void props.services.listWatchers?.()
      .then((next) => { if (live) setListing(next); })
      .catch((cause: unknown) => {
        if (live) setFailure(cause instanceof Error ? cause.message : String(cause));
      });
    return () => { live = false; };
  }, [props.services]);

  if (!props.services.listWatchers) {
    return <EmptyState>Watcher listing is not available in this host.</EmptyState>;
  }
  if (failure !== null) {
    return <EmptyState>Watcher listing could not be loaded: {failure}</EmptyState>;
  }
  return <WatchersView listing={listing} />;
}
