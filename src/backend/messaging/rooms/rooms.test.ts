// Free-room archive fold tests (N4): the read-only fold over the archived
// rooms.jsonl — the old RoomStore class, the create writer, and the room
// routes are deleted; the fold survives for /api/threads' existence check.
// Run with `npx tsx src/backend/messaging/rooms/rooms.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRoom } from './index.js';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'nvk-rooms-')), 'rooms.jsonl');
}

function roomLine(roomId: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    roomId, name: 'Room', members: ['chris'], createdBy: 'chris', createdAt: 'T', archived: false,
    ...overrides,
  });
}

{
  const storePath = freshPath();
  writeFileSync(storePath, `${roomLine('room_a')}\n${roomLine('room_b', { name: 'Beta' })}\n`);
  assert.equal(getRoom(storePath, 'room_a')?.roomId, 'room_a');
  assert.equal(getRoom(storePath, 'room_b')?.name, 'Beta');
  assert.equal(getRoom(storePath, 'room_ghost'), null);
  console.log('fold read tests passed');
}

{
  const storePath = freshPath();
  // Last line wins; torn lines never block the rest.
  writeFileSync(storePath, `{ torn\n${roomLine('room_a', { archived: true })}\n${roomLine('room_a', { archived: false })}\n`);
  assert.equal(getRoom(storePath, 'room_a')?.archived, false, 'last line wins over a torn prefix and an amendment');
  console.log('last-line-wins + tolerance tests passed');
}

{
  const storePath = join(mkdtempSync(join(tmpdir(), 'nvk-rooms-missing-')), 'rooms.jsonl');
  assert.equal(getRoom(storePath, 'room_a'), null, 'a missing file is an empty archive, never a crash');
  console.log('missing-file test passed');
}

console.log('PASS');
