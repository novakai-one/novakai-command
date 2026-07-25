// Free-room archive shim tests (N3): read fold + create writer over the
// archived rooms.jsonl. The RoomStore class is deleted — member mutation
// (addMembers) and the append listener went with it. Run with
// `npx tsx src/backend/messaging/rooms/rooms.test.ts`.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRoom, getRoom, listRooms } from './index.js';

function freshPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'nvk-rooms-')), 'rooms.jsonl');
}

function testCreateRoundtrip(): void {
  const storePath = freshPath();
  const room = createRoom(storePath, {
    name: 'Tunnel Builders',
    members: ['codex-1', 'codex-1'],
    createdBy: 'chris',
  });

  assert.match(room.roomId, /^room_/);
  assert.deepEqual(room.members, ['codex-1', 'chris'], 'the creator joins, deduped');
  assert.equal(room.archived, false);
  assert.deepEqual(getRoom(storePath, room.roomId), room);
  assert.deepEqual(listRooms(storePath), [room]);
}

function testFoldLastLineWinsAndArchivedFilter(): void {
  const storePath = freshPath();
  const first = createRoom(storePath, { name: 'First Room', members: ['chris'], createdBy: 'chris' });
  createRoom(storePath, { name: 'Second Room', members: ['codex-1'], createdBy: 'codex-1' });
  writeFileSync(
    storePath,
    `${JSON.stringify(first)}\n${JSON.stringify({ ...first, archived: true })}\n`,
    { flag: 'a' },
  );
  assert.equal(getRoom(storePath, first.roomId)?.archived, true, 'last line wins');
  assert.equal(listRooms(storePath).length, 1, 'archived rooms are filtered from the list');
  assert.equal(getRoom(storePath, 'room_unknown'), null);
}

function testCorruptLinesAreSkipped(): void {
  const storePath = freshPath();
  const room = createRoom(storePath, { name: 'Valid Room', members: ['chris'], createdBy: 'chris' });
  writeFileSync(storePath, `{ torn line\n${JSON.stringify(room)}\n`);
  assert.deepEqual(listRooms(storePath), [room]);
}

testCreateRoundtrip();
testFoldLastLineWinsAndArchivedFilter();
testCorruptLinesAreSkipped();
console.log('PASS');
