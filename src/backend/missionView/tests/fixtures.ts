// Mission Room V1 — shared test fixtures: fabricated roots in temp dirs with
// cleanup (repo test style: plain tsx + node:assert). Store/journal lines are
// raw JSON text so fixtures mirror real store bytes exactly and keep JSON keys
// (e.g. `ts`) out of lint scope.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MissionViewRoots } from '../sources/index.js';

/** A fabricated read-root rig in a temp dir; call cleanup() when done. */
export interface Rig {
  root: string;
  roots: MissionViewRoots;
  cleanup: () => void;
}

/** Run a test body against a fresh rig, always cleaning up. */
export function withRig(body: (env: Rig) => void | Promise<void>): Promise<void> {
  const env = makeRig();
  return Promise.resolve()
    .then(() => body(env))
    .finally(() => env.cleanup());
}

export function makeRig(): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'mission-view-'));
  const roots: MissionViewRoots = {
    storesDir: path.join(root, 'stores'),
    workDir: path.join(root, 'work'),
    journalPath: path.join(root, 'journal', 'messages.jsonl'),
    registryPath: path.join(root, 'registry', 'agents.json'),
    roomsPath: path.join(root, 'rooms', 'rooms.jsonl'),
  };
  mkdirSync(roots.storesDir, { recursive: true });
  mkdirSync(roots.workDir, { recursive: true });
  return { root, roots, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Write one store file from raw JSONL lines. */
export function writeStore(env: Rig, file: string, lines: string[]): void {
  writeFileSync(path.join(env.roots.storesDir, file), lines.map((line) => `${line}\n`).join(''));
}

/** Write the message journal from raw JSONL lines. */
export function writeJournal(env: Rig, lines: string[]): void {
  mkdirSync(path.dirname(env.roots.journalPath), { recursive: true });
  writeFileSync(env.roots.journalPath, lines.map((line) => `${line}\n`).join(''));
}

/** Write the agent registry from entry objects (keys satisfy the lint rules). */
export function writeRegistry(env: Rig, entries: Array<Record<string, unknown>>): void {
  mkdirSync(path.dirname(env.roots.registryPath), { recursive: true });
  writeFileSync(env.roots.registryPath, JSON.stringify(entries, null, 2));
}

/** Write one packet file for a mission. */
export function writePacketFile(env: Rig, missionId: string, name: string, content: string): void {
  const folder = path.join(env.roots.workDir, missionId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, name), content);
}

/** A valid mission block line; extra raw fields appended verbatim. */
export function missionLine(missionId: string, extra = ''): string {
  const base = `"id":"${missionId}","kind":"mission","ts":"2026-07-21T10:00:00+10:00",`
    + `"title":"Mission ${missionId}","status":"done","stage":"step-6-closed",`
    + `"owner":"chief-kimi","updated":"2026-07-21T12:00:00+10:00"`;
  return `{${base}${extra}}`;
}

/** A valid task block line ref'ing a mission (reverse ref). */
export function taskLine(taskId: string, missionId: string): string {
  return `{"id":"${taskId}","kind":"task","ts":"2026-07-21T10:30:00+10:00","title":"Task ${taskId}",`
    + `"status":"done","refs":[{"kind":"mission","value":"${missionId}"}],"updated":"2026-07-21T11:00:00+10:00"}`;
}

/** A valid captains-log block line ref'ing a mission (reverse ref). */
export function logLine(logId: string, missionId: string): string {
  return `{"id":"${logId}","kind":"log","ts":"2026-07-21T11:00:00+10:00","body":"did work on the mission",`
    + `"refs":[{"kind":"mission","value":"${missionId}"}]}`;
}

/** A valid issue block line ref'ing a task (the one bounded hop, M4). */
export function issueLine(issueId: string, taskId: string): string {
  return `{"id":"${issueId}","kind":"issue","ts":"2026-07-21T11:10:00+10:00","title":"Issue ${issueId}",`
    + `"status":"open","refs":[{"kind":"task","value":"${taskId}"}]}`;
}

/** A valid objective block line. */
export function okrLine(okrId: string, title: string): string {
  return `{"id":"${okrId}","kind":"objective","ts":"2026-07-21T09:00:00+10:00","title":"${title}","horizon":"now"}`;
}

/** A valid request block line ref'ing a mission; status 'pending' or 'answered'. */
export function requestLine(requestId: string, missionId: string, status: string): string {
  return `{"id":"${requestId}","kind":"request","ts":"2026-07-21T09:30:00+10:00","status":"${status}",`
    + `"question":"q?","refs":[{"kind":"mission","value":"${missionId}"}]}`;
}

/** A capability-journal acceptance line (N5): the journal the sources
 * reader folds. `to` = threadId, `from` = senderId. */
export function envelopeLine(envelopeId: string, body: string, threadId?: string): string {
  const thread = threadId ?? 'thread_fixture';
  return `{"op":"acceptance","thread":{"id":"${thread}","kind":"thread","schemaVersion":1,`
    + `"createdAt":"2026-07-21T11:30:00+10:00","threadKind":"direct"},`
    + `"message":{"id":"${envelopeId}","kind":"message","schemaVersion":1,`
    + `"createdAt":"2026-07-21T11:30:00+10:00","threadId":"${thread}","senderId":"person_agent-agent-a",`
    + `"clientMessageId":"cm-${envelopeId}","sequence":1,"priority":"normal","body":{"text":"${body}"}}}`;
}

/** Write the room store from raw JSONL lines. */
export function writeRooms(env: Rig, lines: string[]): void {
  mkdirSync(path.dirname(env.roots.roomsPath), { recursive: true });
  writeFileSync(env.roots.roomsPath, lines.map((line) => `${line}\n`).join(''));
}

/** A room record line; optional typed refs appended verbatim (C1 resolution). */
export function roomLine(roomId: string, name: string, extra = ''): string {
  return `{"roomId":"${roomId}","name":"${name}","members":["agent-a"],`
    + `"createdBy":"agent-a","createdAt":"2026-07-21T11:45:00.000Z","archived":false${extra}}`;
}

/** A valid durable agent block line refing team + mission (S2 team join). */
export function agentLine(agentId: string, name: string, missionId: string, status = 'live', sessionId?: string): string {
  const session = sessionId ? `,"sessionId":"${sessionId}"` : '';
  return `{"id":"${agentId}","kind":"agent","ts":"2026-07-21T10:00:00+10:00","name":"${name}",`
    + `"provider":"kimi","status":"${status}"${session},`
    + `"refs":[{"kind":"team","value":"team_a"},{"kind":"mission","value":"${missionId}"}]}`;
}

/** A task line refing mission AND agent (assignment, ruling S2.2). */
export function assignedTaskLine(taskId: string, missionId: string, agentId: string, status: string, blockedReason?: string): string {
  const reason = blockedReason ? `,"blockedReason":"${blockedReason}"` : '';
  return `{"id":"${taskId}","kind":"task","ts":"2026-07-21T10:30:00+10:00","title":"Task ${taskId}",`
    + `"status":"${status}"${reason},"refs":[{"kind":"mission","value":"${missionId}"},{"kind":"agent","value":"${agentId}"}],`
    + `"updated":"2026-07-21T11:00:00+10:00"}`;
}

/** A minimal registry entry object (AgentInfo-shaped). */
export function agentEntry(agentId: string, archived = false, projectId?: string): Record<string, unknown> {
  return {
    agentId, title: `Agent ${agentId}`, provider: 'kimi', sessionId: `sess-${agentId}`,
    projectDir: '/tmp/proj', cwd: '/tmp/proj', status: 'running',
    createdAt: '2026-07-21T00:00:00.000Z', archived, projectId,
  };
}
