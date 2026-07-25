// Free-room archive fold (N4): .novakai-command/rooms.jsonl is an ARCHIVE —
// nothing creates or mutates rooms anymore (the old RoomStore, the create
// routes, and the router's room arms are all deleted). The ONE surviving
// reader is POST /api/threads' room-existence check, served by this
// tolerant last-line-wins fold (same discipline as people/index.ts
// foldRoomsWithArchived).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Room } from '../types.js';

export const DEFAULT_ROOMS_PATH = path.join(process.cwd(), '.novakai-command', 'rooms.jsonl');

/** Tolerant fold by roomId, last line wins; torn lines never block replay. */
function foldRooms(storePath: string): Map<string, Room> {
  const folded = new Map<string, Room>();
  if (!existsSync(storePath)) return folded;
  for (const line of readFileSync(storePath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line) as Room;
      if (typeof parsed?.roomId === 'string') folded.set(parsed.roomId, parsed);
    } catch {
      // A torn line never blocks replaying the remaining room record.
    }
  }
  return folded;
}

/** The archived room, or null — the /api/threads existence check. */
export function getRoom(storePath: string | undefined, roomId: string): Room | null {
  return foldRooms(storePath ?? DEFAULT_ROOMS_PATH).get(roomId) ?? null;
}
