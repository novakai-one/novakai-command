import type { Edge, Node } from '@xyflow/react';
import { RELATION_LABEL } from '../../contract';
import type { WorldPoint } from '../../../canvas/WorldCanvas';
import {
  BENCH_INSPECTOR_SIZE,
  BENCH_RELATED_OBJECT_SIZE,
  conversationPoint,
  layoutInspectionTrail,
  placementMapOf,
  type BenchPlacement,
} from './bench-layout';
import type {
  BenchInspectionTrail,
  BenchMessage,
  BenchModel,
  BenchNodeActions,
  BenchState,
  BenchTrailStep,
  InspectionWireData,
  MessageInspectorNodeData,
  RelatedObjectNodeData,
} from './bench-model';

type InspectionNode =
  | Node<MessageInspectorNodeData, 'bench-message-inspector'>
  | Node<RelatedObjectNodeData, 'bench-related-object'>;

type InspectionEdge = Edge<InspectionWireData, 'bench-inspection'>;

type TrailStepProjectionInput = {
  readonly trail: BenchInspectionTrail;
  readonly step: BenchTrailStep;
  readonly position: WorldPoint;
  readonly message: BenchMessage;
  readonly model: BenchModel;
  readonly actions: BenchNodeActions;
};

type InspectionProjection = {
  readonly nodes: readonly InspectionNode[];
  readonly edges: readonly InspectionEdge[];
};

function relationInspectorProjection({
  trail,
  step,
  position,
  message,
  actions,
}: TrailStepProjectionInput): InspectionProjection {
  return {
    nodes: [{
      id: step.id,
      type: 'bench-message-inspector',
      position,
      data: { kind: 'message-inspector', selectionId: message.record.id, trail, step, message, actions },
      style: { width: BENCH_INSPECTOR_SIZE.width },
      zIndex: 1200,
    }],
    edges: [{
      id: `wire:${trail.id}:${step.id}`,
      type: 'bench-inspection',
      source: trail.threadId,
      sourceHandle: `message:${trail.rootMessageId}:inspect`,
      target: step.id,
      targetHandle: 'trail-target',
      data: { trailId: trail.id, label: 'Message relations', emphasized: true },
    }],
  };
}

function relatedObjectProjection(input: TrailStepProjectionInput): InspectionProjection {
  const { trail, step, position, model, actions } = input;
  const record = model.recordsById.get(step.recordId);
  if (!record || !step.parentStepId) return { nodes: [], edges: [] };
  const request = model.decisionRequestsById.get(record.id);
  const decisionRequest = request ? {
    ...request,
    context: {
      ...request.context,
      threadId: trail.threadId,
      rootMessageId: trail.rootMessageId,
      requestId: record.id,
      requestRelation: step.relation ?? request.context.requestRelation,
      trailId: trail.id,
      requestStepId: step.id,
    },
  } : null;

  return {
    nodes: [{
      id: step.id,
      type: 'bench-related-object',
      position,
      data: {
        kind: 'related-object',
        selectionId: record.id,
        trail,
        step,
        record,
        relations: model.relationsByRecordId.get(record.id) ?? [],
        decisionRequest,
        actions,
      },
      style: { width: BENCH_RELATED_OBJECT_SIZE.width },
      zIndex: 1190,
    }],
    edges: [{
      id: `wire:${trail.id}:${step.id}`,
      type: 'bench-inspection',
      source: step.parentStepId,
      sourceHandle: `relation:${step.relation}:${record.id}`,
      target: step.id,
      targetHandle: 'trail-target',
      data: {
        trailId: trail.id,
        label: step.relation ? RELATION_LABEL[step.relation] ?? step.relation : 'Related',
        emphasized: false,
      },
    }],
  };
}

/** Projects semantic inspection trails into independently placed canvas nodes and labelled wires. */
export function projectInspectionTrails(
  model: BenchModel,
  state: BenchState,
  placements: readonly BenchPlacement[],
  actions: BenchNodeActions,
): InspectionProjection {
  const nodes: InspectionNode[] = [];
  const edges: InspectionEdge[] = [];
  const placementMap = placementMapOf(placements);
  const trailOrdinalByThread = new Map<string, number>();

  state.session.trails.forEach((trail) => {
    const conversationIndex = model.conversations.findIndex((item) => item.thread.id === trail.threadId);
    const message = model.messagesById.get(trail.rootMessageId);
    if (conversationIndex < 0 || !message) return;
    const conversationPosition = conversationPoint(trail.threadId, conversationIndex, placementMap);
    const trailOrdinal = trailOrdinalByThread.get(trail.threadId) ?? 0;
    trailOrdinalByThread.set(trail.threadId, trailOrdinal + 1);
    const layout = layoutInspectionTrail(
      trail,
      state,
      conversationPosition,
      trailOrdinal,
      placementMap,
    );

    for (const step of trail.steps) {
      const position = placementMap.get(step.id)?.position ?? layout.get(step.id);
      if (!position) continue;
      const input = { trail, step, position, message, model, actions };
      const addition = step.kind === 'relations'
        ? relationInspectorProjection(input)
        : relatedObjectProjection(input);
      nodes.push(...addition.nodes);
      edges.push(...addition.edges);
    }
  });
  return { nodes, edges };
}
