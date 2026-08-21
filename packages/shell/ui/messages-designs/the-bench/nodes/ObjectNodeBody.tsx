import { Handle, Position } from '@xyflow/react';
import { useState } from 'react';
import { factsFor, summaryFor } from '../../record-content';
import { KIND_LABEL } from '../../contract';
import { field } from '../../graph';
import type { ObjectRecord } from '../../contract';
import type {
  BenchDecisionRequest,
  BenchNodeActions,
  BenchObjectRelation,
} from '../model/bench-model';
import { InlineDecisionForm } from './InlineDecisionForm';
import './ObjectNodeBody.css';

function displayTitle(record: ObjectRecord): string {
  return record.title === record.id ? KIND_LABEL[record.kind] : record.title;
}

/** Shared relationship rows and exact expansion handles for every inspectable record. */
export function ObjectRelationRows({
  relations,
  onExpand,
}: {
  readonly relations: readonly BenchObjectRelation[];
  readonly onExpand: (relation: BenchObjectRelation) => void;
}) {
  if (relations.length === 0) return null;
  return (
    <div className="bench-object-body__relations">
      {relations.map((relation) => (
        <div className="bench-relation-row" key={`${relation.relation}:${relation.record.id}`}>
          <button
            type="button"
            className="nodrag"
            onClick={(event) => {
              event.stopPropagation();
              onExpand(relation);
            }}
          >
            <strong title={relation.record.title === relation.record.id ? undefined : relation.record.title}>
              {displayTitle(relation.record)}
            </strong>
            <span>{KIND_LABEL[relation.record.kind]} · {relation.label}</span>
          </button>
          <Handle
            id={`relation:${relation.relation}:${relation.record.id}`}
            className="bench-relation-row__source"
            type="source"
            position={Position.Right}
          />
        </div>
      ))}
    </div>
  );
}

function DecisionRequestAnswer({
  request,
  actions,
}: {
  readonly request: BenchDecisionRequest;
  readonly actions: BenchNodeActions;
}) {
  const [isAnswering, setAnswering] = useState(false);
  return (
    <section className="bench-object-body__decision" onClick={(event) => event.stopPropagation()}>
      <span>Decision needed · {request.agentName}</span>
      <p className="bench-compact-copy">{request.question}</p>
      {isAnswering ? (
        <div className="bench-object-body__decision-form">
          <InlineDecisionForm
            requestId={`object:${request.record.id}`}
            onSubmit={(ruling) => actions.answerDecisionRequest(request.context, ruling)}
            onCancel={() => setAnswering(false)}
          />
        </div>
      ) : (
        <button type="button" className="nodrag" onClick={() => setAnswering(true)}>Answer</button>
      )}
    </section>
  );
}

/** Shared object identity, facts, summary, and guarded travel action. */
export function ObjectNodeBody({
  record,
  relations,
  decisionRequest,
  onExpand,
  actions,
}: {
  record: ObjectRecord;
  relations: readonly BenchObjectRelation[];
  decisionRequest: BenchDecisionRequest | null;
  onExpand: (relation: BenchObjectRelation) => void;
  actions: BenchNodeActions;
}) {
  const summary = summaryFor(record) || field(record, 'body') || field(record, 'result');
  const facts = factsFor(record);
  const canTravel = actions.canTravel(record.id);
  const title = displayTitle(record);
  const showsDistinctKind = title !== KIND_LABEL[record.kind];

  return (
    <div className="bench-object-body" data-kind={record.kind} onClick={() => actions.selectRecord(record.id)}>
      <header className="bench-object-body__identity">
        {showsDistinctKind && <span className="bench-object-body__kind">{KIND_LABEL[record.kind]}</span>}
        <strong title={record.title === record.id ? undefined : record.title}>{title}</strong>
      </header>
      {summary && <p>{summary}</p>}
      {facts.length > 0 && (
        <dl>
          {facts.map((fact) => (
            <div key={fact.from}>
              <dt>{fact.label}</dt>
              <dd>{field(record, fact.from)}</dd>
            </div>
          ))}
        </dl>
      )}
      {decisionRequest && <DecisionRequestAnswer request={decisionRequest} actions={actions} />}
      <ObjectRelationRows relations={relations} onExpand={onExpand} />
      {canTravel && (
        <button
          type="button"
          className="bench-object-body__travel nodrag"
          onClick={(event) => {
            event.stopPropagation();
            actions.travel(record.id);
          }}
          aria-label={`Open ${title}`}
        >
          Open <span aria-hidden="true">↗</span>
        </button>
      )}
    </div>
  );
}
