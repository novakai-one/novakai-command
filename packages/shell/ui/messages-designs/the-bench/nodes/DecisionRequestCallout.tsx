import { useState } from 'react';
import type { BenchDecisionRequest, BenchNodeActions } from '../model/bench-model';
import { InlineDecisionForm } from './InlineDecisionForm';
import './DecisionRequestCallout.css';

/** Restrained normal-mode lift-out for the first pending Decision Request. */
export function DecisionRequestCallout({
  request,
  requestCount,
  actions,
}: {
  readonly request: BenchDecisionRequest;
  readonly requestCount: number;
  readonly actions: BenchNodeActions;
}) {
  const [isAnswering, setAnswering] = useState(false);
  const inspect = () => {
    actions.openConversation(request.context.threadId);
    actions.expandMessageRelation(
      request.context.threadId,
      request.context.rootMessageId,
      request.context.requestRelation,
      request.context.requestId,
    );
  };

  return (
    <aside className="bench-decision-callout nodrag" aria-label="Pending Decision Request">
      <header className="bench-action-row">
        <span className="bench-danger-eyebrow">Decision needed</span>
        {requestCount > 1 && <small className="bench-danger-eyebrow bench-muted-eyebrow">{requestCount} pending</small>}
      </header>
      <strong className="bench-danger-eyebrow">{request.agentName}</strong>
      <p className="bench-compact-copy">{request.question}</p>
      {isAnswering ? (
        <div className="bench-decision-callout__form">
          <InlineDecisionForm
            requestId={request.record.id}
            onSubmit={(ruling) => actions.answerDecisionRequest(request.context, ruling)}
            onCancel={() => setAnswering(false)}
          />
        </div>
      ) : (
        <footer className="bench-action-row">
          <button type="button" className="bench-control-button bench-danger-action" onClick={() => setAnswering(true)}>Answer</button>
          <button type="button" className="bench-control-button" onClick={inspect}>Inspect</button>
        </footer>
      )}
    </aside>
  );
}
