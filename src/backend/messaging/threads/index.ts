// POST /api/threads — the mission↔room link route (plan v2 §1.5). One typed
// thread block per room; the mission graph owns the write, the hub passes its
// room lookup in so this module stays free of hub internals. N4: MissionGraph
// and the room-not-found error live here now (the router/identity dirs are
// deleted); room existence reads the archived rooms.jsonl fold.
import type { Request, Response } from 'express';

/** The slice of the durable mission graph the thread link needs
 * (ObjectModel satisfies this structurally). */
export interface MissionGraph {
  missionForRoom(roomId: string): string | null;
  createThread(input: { roomId: string; missionId: string }): string;
}

/** The archived free-room shape the fold returns (types.ts owns Room). */
import type { Room } from '../types.js';

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function createThreadRoute(
  request: Request,
  response: Response,
  graph: MissionGraph | undefined,
  roomFor: (roomId: string) => Room | null | undefined,
): void {
  if (!graph) {
    response.status(501).json({ error: 'no mission graph configured on this backend' });
    return;
  }
  const payload = (request.body ?? {}) as { roomId?: unknown; missionId?: unknown };
  try {
    const roomId = requireText(payload.roomId, 'roomId');
    const missionId = requireText(payload.missionId, 'missionId');
    if (!roomFor(roomId)) {
      response.status(404).json({ error: `room "${roomId}" was not found` });
      return;
    }
    const existing = graph.missionForRoom(roomId);
    if (existing) {
      response.status(409).json({ error: `room ${roomId} is already linked to ${existing}` });
      return;
    }
    response.status(201).json({ threadId: graph.createThread({ roomId, missionId }) });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
}
