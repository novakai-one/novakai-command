// shell/ui/screens/agents/CommunicationsScreen.tsx — §19.2 inspection: what has
// this Agent been sent, and did it arrive (FZ-VIEW-013/014). Kit-composed only.
//
// It renders the projection Messaging returns, row for row, in the order the
// owner sent them. Three things it deliberately does NOT do, each because doing
// it would be a lie the Shell has told before:
//
//   - it never supplies a `screenContext` (FZ-VIEW-014). Where one did not
//     arrive it says so, and it tells apart "the contract says there is none
//     here" from "the field did not come".
//   - it never re-orders. The owner's order is what its cursor means.
//   - it never lets a full page read as a complete one (L-11).
//
// House rules: near-monochrome, no accent, no badge on a healthy row. The one
// row that is an exception — an echo that contradicts itself — gets air and
// ink, not a chip.
import React, { useEffect, useState } from 'react';
import type { ShellServices } from '../../../contract/index.js';
import {
  COMMUNICATION_FACTS, communicationFact, describeEchoProblems,
  describePageCompleteness, describeScope,
  type AgentCommunicationItemView, type AgentCommunicationsPageView,
  type ListAgentCommunicationsRequest,
} from '../../../contract/communications.js';
import { answerFrom, type AnswerFailure } from '../../../contract/listAnswer.js';
import {
  DescriptionList, EmptyState, InlineError, ListRow, Panel, ScrollArea, Stack, Text,
} from '../../kit/index.js';
import './communications.css';

/** Pure presentational — every value arrives as a prop, nothing is derived. */
export function CommunicationsView(props: {
  page: AgentCommunicationsPageView | null;
  error: AnswerFailure | null;
  request: ListAgentCommunicationsRequest;
}) {
  const answer = answerFrom({
    source: props.page,
    failure: props.error,
    rowsOf: (page: AgentCommunicationsPageView) => page.items,
  });
  const completeness = props.page === null
    ? ''
    : describePageCompleteness(props.request, props.page);

  return (
    <ScrollArea className="nv-comms__scroll">
      <Panel head="Communications">
        <Stack className="nv-comms">
          {/* Whose. Never "all" — a scope the screen cannot vouch for is the
              same overclaim as the totals row that said "All sessions" — and
              never half a sentence when there is no scope yet. */}
          {describeScope(props.request) !== '' && (
            <Text as="p" className="nv-comms__scope">{describeScope(props.request)}</Text>
          )}
          {answer.kind === 'failed' && (
            <InlineError>{`${answer.failure.code}: ${answer.failure.message}`}</InlineError>
          )}
          {answer.kind === 'waiting' && <EmptyState>Reading communications…</EmptyState>}
          {answer.kind === 'none' && <EmptyState>No communications for these Agents</EmptyState>}
          {answer.kind === 'rows' && (
            <Stack gap={0} className="nv-comms__rows">
              {answer.rows.map((item) => (
                <CommunicationRow key={item.messageId} item={item} />
              ))}
            </Stack>
          )}
          {completeness !== '' && (
            <Text as="p" className="nv-comms__completeness">{completeness}</Text>
          )}
        </Stack>
      </Panel>
    </ScrollArea>
  );
}

function CommunicationRow(props: { item: AgentCommunicationItemView }) {
  const item = props.item;
  const broken = describeEchoProblems(item) !== '';
  // A fact with nothing to say is dropped; a fact the projection could have
  // supplied and did not is NOT — its absence is the thing to see. The headline
  // fact is drawn once, above, rather than twice.
  const facts = COMMUNICATION_FACTS
    .filter((fact) => fact.headline !== true)
    .map((fact) => [fact, fact.describe(item)] as const)
    .filter(([, said]) => said !== '');

  return (
    <Stack gap={0} className="nv-comms__row" data-problem={broken ? 'true' : 'false'}>
      <ListRow
        label={item.textPreview ?? item.messageId}
        meta={communicationFact('delivery').describe(item)}
      />
      <Text as="p" className="nv-comms__id">{item.messageId}</Text>
      <DescriptionList
        className="nv-comms__facts"
        items={facts.map(([fact, said]) => [
          <Text key={`${fact.id}-t`} data-fact={fact.id} data-source={fact.sourceOf(item)}>
            {fact.term}
          </Text>,
          said,
        ])}
      />
    </Stack>
  );
}

/**
 * The connected screen. Its subjects are the Agents this host knows about —
 * stated on screen, because "communications" with no named subject would be a
 * claim about a scope nobody established.
 */
export function CommunicationsScreen(props: { services: ShellServices }) {
  const [page, setPage] = useState<AgentCommunicationsPageView | null>(null);
  const [error, setError] = useState<AnswerFailure | null>(null);
  const [request, setRequest] = useState<ListAgentCommunicationsRequest>({ agentIds: [] });
  const door = props.services.agentRuns;
  const roster = props.services.agents;

  useEffect(() => {
    let live = true;
    if (door === undefined) {
      setError({
        code: 'MessagingUnavailable',
        message: 'this host has no Novakai Runtime to read communications from',
      });
      return () => { live = false; };
    }
    void (async () => {
      const agents = roster === undefined ? [] : await roster.listAgents();
      if (!live) return;
      const asked: ListAgentCommunicationsRequest = {
        agentIds: agents.map((agent) => agent.id),
        limit: 200,
      };
      setRequest(asked);
      if (asked.agentIds.length === 0) {
        setError({
          code: 'NoSubject',
          message: 'this host knows no Agents, so there is nobody to ask about',
        });
        return;
      }
      const result = await door.communications.listAgentCommunications(asked);
      if (!live) return;
      if (result.ok) {
        setPage(result.value);
        setError(null);
        return;
      }
      setPage(null);
      setError(result.error);
    })();
    return () => { live = false; };
  }, [door, roster]);

  return <CommunicationsView page={page} error={error} request={request} />;
}
