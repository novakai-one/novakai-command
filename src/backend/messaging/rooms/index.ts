// Free-room archive shim (N3, dies in N4): the old RoomStore class is
// deleted — free rooms never joined the capability, and .novakai-command/
// rooms.jsonl is now an ARCHIVE. What survives until N4 is read access
// (GET /api/rooms, the /api/threads existence check) and browser room
// creation (POST /api/user/rooms), served by this minimal tolerant fold
// (same last-line-wins discipline as people/index.ts foldRoomsWithArchived)
// plus a tiny append writer with the old create semantics. There is NO
// member mutation here — POST /api/rooms and /api/rooms/:id/members are
// gone with the router's room arms.
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

export function listRooms(storePath: string): Room[] {
  return Array.from(foldRooms(storePath).values()).filter((room) => !room.archived);
}

export function getRoom(storePath: string, roomId: string): Room | null {
  return foldRooms(storePath).get(roomId) ?? null;
}

/** Browser room creation (old RoomStore.create semantics, minus the class). */
export function createRoom(
  storePath: string,
  input: { name: string; members: string[]; createdBy: string },
): Room {
  const room: Room = {
    roomId: `room_${randomUUID()}`,
    name: input.name,
    members: Array.from(new Set([...input.members, input.createdBy])),
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
    archived: false,
  };
  mkdirSync(path.dirname(storePath), { recursive: true });
  appendFileSync(storePath, JSON.stringify(room) + '\n');
  return room;
}
