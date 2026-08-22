import type { Node } from '@xyflow/react';

/** A framework-neutral point in the canvas world. */
export type WorldPoint = { readonly x: number; readonly y: number };

/** Grid steps applied by the shared canvas while a node is dragged. */
export type CanvasDragGrid = { readonly xStep: number; readonly yStep: number };

/** One settled node placement emitted without exposing a React Flow node. */
export type CanvasNodePlacement = {
  readonly id: string;
  readonly position: WorldPoint;
  readonly parentId?: string;
};

/** A complete placement snapshot after restore or one settled drag. */
export type CanvasPlacementChange = {
  readonly cause: 'restore' | 'drag-end';
  readonly movedNodeId: string | null;
  readonly placements: readonly CanvasNodePlacement[];
};

/** A semantic placement mutation that never exposes coordinates to callers. */
export type CanvasPlacementMutation =
  | {
      readonly type: 'set-node-position';
      readonly nodeId: string;
      readonly position: WorldPoint;
    }
  | {
      readonly type: 'remove-node';
      readonly nodeId: string;
    }
  | {
      readonly type: 'replace-node-identity';
      readonly fromNodeId: string;
      readonly toNodeId: string;
    }
  | {
      readonly type: 'set-node-parent';
      readonly nodeId: string;
      readonly parentId: string | null;
    };

/** One atomic, idempotent request to mutate shared-canvas placement ownership. */
export type CanvasPlacementCommand = {
  readonly type: 'apply-placement-mutations';
  readonly key: string;
  readonly mutations: readonly CanvasPlacementMutation[];
};

/** Typed result of applying a placement command. */
export type CanvasPlacementCommandOutcome =
  | { readonly key: string; readonly status: 'applied' }
  | {
      readonly key: string;
      readonly status: 'rejected';
      readonly reason: 'node-missing' | 'parent-missing' | 'duplicate-target' | 'invalid-command';
    };

function absoluteNodePosition<NodeType extends Node>(
  node: NodeType,
  nodesById: ReadonlyMap<string, NodeType>,
  resolving: ReadonlySet<string>,
): WorldPoint {
  if (!node.parentId) return { x: node.position.x, y: node.position.y };
  if (resolving.has(node.id)) return { x: node.position.x, y: node.position.y };

  const parent = nodesById.get(node.parentId);
  if (!parent) return { x: node.position.x, y: node.position.y };
  const nextResolving = new Set(resolving).add(node.id);
  const parentPosition = absoluteNodePosition(parent, nodesById, nextResolving);
  return {
    x: parentPosition.x + node.position.x,
    y: parentPosition.y + node.position.y,
  };
}

/** Copies framework nodes into the neutral placement contract. */
export function placementsFromNodes<NodeType extends Node>(
  nodes: readonly NodeType[],
): CanvasNodePlacement[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => ({
    id: node.id,
    position: absoluteNodePosition(node, nodesById, new Set()),
    ...(node.parentId ? { parentId: node.parentId } : {}),
  }));
}
