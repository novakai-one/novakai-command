// Seat-watch tests (D-N5-6): the revived in-app seat half of the old
// nvk-watchdog script. Real transcript fixtures on a tmp disk, injected
// clock/pid/roster — no PTYs, no timers. Run with
// `npx tsx src/backend/terminal/seatWatch/index.test.ts`.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentInfo } from '../manager.js';
import {
  boundaryFor,
  createSeatWatch,
  loadWatchdogConfig,
  pendingPrompt,
  tickSafely,
  transcriptPathFor,
  type SeatRoster,
} from './index.js';

const NOW_MS = 1_700_000_000_000;
const tmpDir = mkdtempSync(path.join(tmpdir(), 'seatwatch-'));
const claudeDir = path.join(tmpDir, 'claude-projects');
const configFile = path.join(tmpDir, 'watchdog.json');

function makeSeat(partial: Partial<AgentInfo>): AgentInfo {
  return {
    agentId: 'agent_alpha', title: 'Alpha · claude', provider: 'claude',
    sessionId: 'sess_alpha', projectDir: 'proj-alpha', cwd: '/tmp',
    status: 'running', createdAt: new Date(NOW_MS).toISOString(),
    ...partial,
  };
}

function writeTranscript(seat: AgentInfo, entries: unknown[], mtimeMs: number): string {
  const seatDir = path.join(claudeDir, seat.projectDir);
  mkdirSync(seatDir, { recursive: true });
  const file = path.join(seatDir, `${seat.sessionId}.jsonl`);
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const stamp = new Date(mtimeMs);
  utimesSync(file, stamp, stamp);
  return file;
}

function rosterOf(seats: AgentInfo[]): SeatRoster {
  return { list: () => seats };
}

function writeConfig(overrides: Record<string, unknown>): void {
  writeFileSync(configFile, JSON.stringify({
    intervalSec: 60,
    defaults: { quietAfterSec: 1200, escalate: 'team' },
    seats: [{ title: 'Message Man · claude', quietAfterSec: 900, escalate: 'chris' }],
    ignoreTitles: ['chris'],
    ...overrides,
  }, null, 2));
}

const textEntry = { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } };
const toolEntry = (name: string) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name }] } });
const resultEntry = { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } };

// --- config: missing file gets the default written; on-disk shape honored ----

const missingPath = path.join(tmpDir, 'never-written.json');
const defaulted = loadWatchdogConfig(missingPath);
assert.equal(defaulted.defaults.quietAfterSec, 900, 'default quietAfterSec is 900');
assert.equal(defaulted.intervalSec, 60, 'default interval is 60s');
assert.deepEqual(defaulted.ignoreTitles, ['chris'], 'default ignores chris');
assert.ok(existsSync(missingPath), 'a missing config file is created with defaults');

writeConfig({});
const loaded = loadWatchdogConfig(configFile);
assert.equal(loaded.defaults.quietAfterSec, 1200, 'on-disk default honored');
assert.equal(loaded.seats[0]?.title, 'Message Man · claude', 'on-disk seat override honored');

// --- boundaryFor: agentId match beats title match, defaults underneath -------

const seatByTitle = makeSeat({ title: 'Message Man · claude' });
assert.equal(boundaryFor(seatByTitle, loaded).quietAfterSec, 900, 'title override wins over defaults');
assert.equal(boundaryFor(seatByTitle, loaded).escalate, 'chris', 'override escalate honored');
const seatByAgent = makeSeat({ agentId: 'agent_x', title: 'Message Man · claude' });
const agentConfig = loadWatchdogConfig(configFile);
agentConfig.seats = [{ agentId: 'agent_x', quietAfterSec: 300 }, ...agentConfig.seats];
assert.equal(boundaryFor(seatByAgent, agentConfig).quietAfterSec, 300, 'agentId match beats title match');
assert.equal(boundaryFor(makeSeat({}), loaded).quietAfterSec, 1200, 'no override → defaults');

// --- pendingPrompt: the 16 KiB tail sniff, all branches ----------------------

const seat = makeSeat({});
const askFile = writeTranscript(seat, [textEntry, toolEntry('AskUserQuestion')], NOW_MS);
assert.equal(pendingPrompt(askFile), 'a question for a human', 'AskUserQuestion → human question');
const planFile = writeTranscript(makeSeat({ sessionId: 'sess_plan' }), [toolEntry('ExitPlanMode')], NOW_MS);
assert.equal(pendingPrompt(planFile), 'plan approval', 'ExitPlanMode → plan approval');
const bashFile = writeTranscript(makeSeat({ sessionId: 'sess_bash' }), [toolEntry('Bash')], NOW_MS);
assert.equal(pendingPrompt(bashFile), 'a possible permission stop (Bash)', 'other tool → permission stop');
const doneFile = writeTranscript(makeSeat({ sessionId: 'sess_done' }), [toolEntry('AskUserQuestion'), resultEntry], NOW_MS);
assert.equal(pendingPrompt(doneFile), null, 'a tool_result after the tool_use clears the prompt');
const plainFile = writeTranscript(makeSeat({ sessionId: 'sess_plain' }), [textEntry], NOW_MS);
assert.equal(pendingPrompt(plainFile), null, 'assistant text without tool_use is not pending');

// --- transcriptPathFor --------------------------------------------------------

assert.equal(transcriptPathFor(seat, claudeDir), askFile, 'existing transcript resolves');
const ghostSeat = makeSeat({ sessionId: 'sess_ghost' });
assert.equal(transcriptPathFor(ghostSeat, claudeDir), null, 'missing transcript → null');
assert.equal(transcriptPathFor(makeSeat({ sessionId: '' }), claudeDir), null, 'no sessionId → null');

// --- quiet detection + alert-once --------------------------------------------

writeConfig({});
const alerts: string[] = [];
const quietSeat = makeSeat({ agentId: 'agent_quiet', sessionId: 'sess_quiet' });
writeTranscript(quietSeat, [textEntry], NOW_MS - 1_300_000);
const quietWatch = createSeatWatch({
  terminals: rosterOf([quietSeat]), claudeDir, configPath: configFile,
  onAlert: (body) => alerts.push(body), nowMs: () => NOW_MS, pidAlive: () => false,
});
quietWatch.tick();
quietWatch.tick();
assert.equal(alerts.length, 0, 'first tick baselines silently — no alert for a seat already quiet');
assert.equal(quietWatch.stateFor('agent_quiet')?.kind, 'quiet', 'baseline still annotates the quiet seat');
assert.equal(quietWatch.events().at(-1)?.baselined, true, 'baseline event is marked');

// --- recovery → re-quiet re-alerts --------------------------------------------

writeTranscript(quietSeat, [textEntry, textEntry], NOW_MS);
quietWatch.tick();
assert.equal(alerts.length, 0, 'recovery itself never posts');
assert.equal(quietWatch.stateFor('agent_quiet')?.kind, 'recovered', 'recovery annotates for one tick');
assert.ok(quietWatch.events().some((event) => event.type === 'seat-recovered'), 'recovery event recorded');
quietWatch.tick();
assert.equal(quietWatch.stateFor('agent_quiet'), null, 'a live seat carries no annotation');
writeTranscript(quietSeat, [textEntry], NOW_MS - 1_300_000);
quietWatch.tick();
assert.equal(alerts.length, 1, 'a NEW quiet episode after recovery alerts');
assert.match(alerts[0] ?? '', /has gone quiet for ~22 min with nothing pending — worth a look\./);
quietWatch.tick();
assert.equal(alerts.length, 1, 'alert-once: a continuing episode does not re-post');

// --- waiting-on-human line + escalate: chris ----------------------------------

const waitingSeat = makeSeat({ agentId: 'agent_mm', title: 'Message Man · claude', sessionId: 'sess_mm' });
writeTranscript(waitingSeat, [toolEntry('AskUserQuestion')], NOW_MS - 1_300_000);
const waitingAlerts: string[] = [];
createSeatWatch({
  terminals: rosterOf([waitingSeat]), claudeDir, configPath: configFile,
  onAlert: (body) => waitingAlerts.push(body), nowMs: () => NOW_MS, pidAlive: () => false,
}).tick();
assert.equal(waitingAlerts.length, 0, 'escalated seat also baselines silently');
writeTranscript(waitingSeat, [textEntry], NOW_MS);
const waitingWatch = createSeatWatch({
  terminals: rosterOf([waitingSeat]), claudeDir, configPath: configFile,
  onAlert: (body) => waitingAlerts.push(body), nowMs: () => NOW_MS, pidAlive: () => false,
});
waitingWatch.tick();
writeTranscript(waitingSeat, [toolEntry('AskUserQuestion')], NOW_MS - 1_300_000);
waitingWatch.tick();
assert.equal(waitingAlerts.length, 1, 'fresh episode for the escalated seat alerts');
assert.match(waitingAlerts[0] ?? '', /^@chris Message Man · claude has been waiting ~22 min on a question for a human/);

// --- dead seat: no transcript + no live pid; Codex pid fallback ----------------

const deadSeat = makeSeat({ agentId: 'agent_dead', sessionId: 'sess_dead', terminalPid: 4242 });
const deadAlerts: string[] = [];
const deadWatch = createSeatWatch({
  terminals: rosterOf([deadSeat]), claudeDir, configPath: configFile,
  onAlert: (body) => deadAlerts.push(body), nowMs: () => NOW_MS, pidAlive: () => false,
});
deadWatch.tick();
assert.equal(deadAlerts.length, 0, 'dead seat baselines silently too');
assert.equal(deadWatch.stateFor('agent_dead')?.kind, 'dead', 'dead annotation set at baseline');
const relaunchedWatch = createSeatWatch({
  terminals: rosterOf([deadSeat]), claudeDir, configPath: configFile,
  onAlert: (body) => deadAlerts.push(body), nowMs: () => NOW_MS, pidAlive: () => false,
});
relaunchedWatch.tick();
assert.equal(deadAlerts.length, 0, 'backend restart re-baselines silently (in-memory state)');
const codexSeat = makeSeat({ agentId: 'agent_codex', provider: 'codex', sessionId: 'sess_codex', terminalPid: 7777 });
const codexAlerts: string[] = [];
createSeatWatch({
  terminals: rosterOf([codexSeat]), claudeDir, configPath: configFile,
  onAlert: (body) => codexAlerts.push(body), nowMs: () => NOW_MS, pidAlive: () => true,
}).tick();
assert.equal(codexAlerts.length, 0, 'Codex seat with a live pid is not dead');

// --- skips: exited, ignoreTitles, extraIgnoreTitles -----------------------------

const skipAlerts: string[] = [];
const exitedSeat = makeSeat({ agentId: 'agent_ex', sessionId: 'sess_ex', status: 'exited' });
const chrisSeat = makeSeat({ agentId: 'agent_ch', title: 'chris', sessionId: 'sess_ch' });
const watchSeat = makeSeat({ agentId: 'agent_wd', title: 'nvk-watchdog', sessionId: 'sess_wd' });
for (const skipped of [exitedSeat, chrisSeat, watchSeat]) {
  writeTranscript(skipped, [textEntry], NOW_MS - 9_000_000);
}
const skipWatch = createSeatWatch({
  terminals: rosterOf([exitedSeat, chrisSeat, watchSeat]), claudeDir, configPath: configFile,
  onAlert: (body) => skipAlerts.push(body), nowMs: () => NOW_MS, pidAlive: () => false,
  extraIgnoreTitles: ['nvk-watchdog'],
});
skipWatch.tick();
assert.equal(skipAlerts.length, 0, 'exited / ignored / watchdog seats never alert');
assert.equal(skipWatch.events().length, 0, 'skipped seats record no events at all (not even baselined)');
assert.equal(skipWatch.stateFor('agent_ch'), null, 'ignored seats carry no annotation');

// --- F1: a throwing tick never propagates; the next tick still runs ----------

let rosterThrows = true;
const guardedAlerts: string[] = [];
const guardLogs: string[] = [];
const throwingSeat = makeSeat({ agentId: 'agent_throw', sessionId: 'sess_throw' });
writeTranscript(throwingSeat, [textEntry], NOW_MS - 1_300_000);
const guardedWatch = createSeatWatch({
  terminals: { list: () => { if (rosterThrows) throw new Error('registry gone'); return [throwingSeat]; } },
  claudeDir, configPath: configFile,
  onAlert: (body) => guardedAlerts.push(body), nowMs: () => NOW_MS, pidAlive: () => false,
});
tickSafely(guardedWatch, (line) => guardLogs.push(line));
assert.equal(guardLogs.length, 1, 'a throwing tick is logged, not propagated');
assert.match(guardLogs[0] ?? '', /registry gone/);
rosterThrows = false;
tickSafely(guardedWatch, (line) => guardLogs.push(line));
assert.equal(guardLogs.length, 1, 'the next tick runs clean — no further log');
assert.equal(guardedWatch.events().length, 1, 'the recovered tick did its work');

console.log('PASS');
