// shell/ui/screens/agents/RunsScreen.tsx — the B3e tracer's one Shell view of
// a Run. Kit-composed only (red gate 3 — tools/lint-kit.mjs).
//
// It renders the frozen `AgentRunView` projection that `nvk agent list --json`
// prints, field for field, and that is the whole point: a screen that quietly
// re-derived a Run's state is how the Shell and the CLI came to disagree about
// the same record (FZ-VIEW-034).
//
// House rules it is held to:
//   - Near-monochrome. No badge, chip or dot on a healthy row. Only a Run
//     carrying uncertainty is marked, because only that one is the exception.
//   - The screen never TELLS Chris where to look. Ordering does that:
//     uncertain first, then working, then unknown, then quiet.
//   - A measurement we do not have is an em dash. "Unavailable" is not zero.
//   - What could not be shown is SAID. A page with omitted rows draws the
//     count; hiding them silently is the dishonesty `Page.omissions` exists
//     to prevent.
import React, { useEffect, useState } from 'react';
import type { ShellServices } from '../../../contract/index.js';
import {
  AGENT_RUN_MUST_SHOW, describeRunState, orderRuns,
  type AgentRunRowView, type AgentRunsPageView,
} from '../../../contract/agentRuns.js';
import { answerFrom, type AnswerFailure } from '../../../contract/listAnswer.js';
import {
  DescriptionList, EmptyState, InlineError, ListRow, Panel, ScrollArea, Stack, Text,
} from '../../kit/index.js';
import './runs.css';

/**
 * An ALIAS, not a second declaration. B0 wrote this rule here first; B2.1 moved
 * it to contract/listAnswer.ts when the audit found four more screens breaking
 * it, and two structurally-identical copies of one rule is exactly the drift
 * that made the rule necessary.
 */
export type RunsViewError = AnswerFailure;

/** Pure presentational — every value arrives as a prop, nothing is derived. */
export function RunsView(props: {
  page: AgentRunsPageView | null;
  error: RunsViewError | null;
}) {
  const omissions = props.page?.omissions ?? [];
  // Four states, not two. "Nobody has answered yet" is a different fact from
  // "the answer was none", and drawing the first as the second is the same lie
  // as drawing an unavailable measurement as a zero (FZ-VIEW-010).
  const answer = answerFrom({
    source: props.page,
    failure: props.error,
    rowsOf: (page: AgentRunsPageView) => orderRuns(page.items),
  });
  const rows = answer.kind === 'rows' ? answer.rows : [];

  return (
    <ScrollArea className="nv-runs__scroll">
      <Panel head="Agent Runs">
        <Stack className="nv-runs">
          {answer.kind === 'failed' && (
            <InlineError>{`${answer.failure.code}: ${answer.failure.message}`}</InlineError>
          )}
          {answer.kind === 'waiting' && <EmptyState>Reading Runs…</EmptyState>}
          {answer.kind === 'none' && <EmptyState>No agent runs yet</EmptyState>}
          {answer.kind === 'rows' && (
            <Stack gap={0} className="nv-runs__rows">
              {rows.map((view) => <RunRow key={view.run.id} view={view} />)}
            </Stack>
          )}
          {omissions.map((omission) => (
            // Not an error and not a warning — a fact about this page, stated
            // quietly, so "12 runs" never silently means "12 of 14".
            <Text
              as="p"
              key={omission.reason}
              className="nv-runs__omission"
            >
              {`${omission.count} run(s) not shown: ${omission.reason}`}
            </Text>
          ))}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

function RunRow(props: { view: AgentRunRowView }) {
  const view = props.view;
  const uncertain = view.run.uncertainty.length > 0;
  // FZ-VIEW-003, from the manifest rather than from memory. A fact with nothing
  // to say (no warnings) is dropped; a fact this projection cannot supply is
  // NOT — its absence is the thing Chris needs to see.
  const facts = AGENT_RUN_MUST_SHOW
    .map((fact) => [fact, fact.describe(view)] as const)
    .filter(([, said]) => said !== '');

  return (
    <Stack gap={0} className="nv-runs__row" data-uncertain={uncertain ? 'true' : 'false'}>
      <ListRow
        label={view.agent.displayName}
        meta={describeRunState(view)}
      />
      <Text as="p" className="nv-runs__id">{view.run.id}</Text>
      <Text as="p" className="nv-runs__origin">
        {`${view.provider.provider} ${view.provider.modelId}`}
      </Text>
      <DescriptionList
        className="nv-runs__facts"
        items={facts.map(([fact, said]) => [
          <Text key={`${fact.id}-t`} data-fact={fact.id} data-source={fact.source}>
            {fact.term}
          </Text>,
          said,
        ])}
      />
    </Stack>
  );
}

/**
 * The connected screen. It reads through `services.agentRuns` — FZ-VIEW-001's
 * door — and through nothing else; a host with no Runtime simply has no door,
 * which the screen draws rather than guesses at.
 */
export function RunsScreen(props: { services: ShellServices }) {
  const [page, setPage] = useState<AgentRunsPageView | null>(null);
  const [error, setError] = useState<RunsViewError | null>(null);
  const door = props.services.agentRuns;

  useEffect(() => {
    let live = true;
    if (door === undefined) {
      setError({
        code: 'RuntimeUnavailable',
        message: 'this host has no Novakai Runtime to read Runs from',
      });
      return () => { live = false; };
    }
    void door.runs.listAgentRuns({ state: 'all' }).then((result) => {
      if (!live) return;
      if (result.ok) {
        setPage(result.value);
        setError(null);
        return;
      }
      setPage(null);
      setError(result.error);
    });
    return () => { live = false; };
  }, [door]);

  return <RunsView page={page} error={error} />;
}
