/**
 * messagingV2 spawn briefing text tests (slice N2). Run with
 * `npx tsx src/backend/messagingV2/briefing/index.test.ts`.
 */
import assert from 'node:assert/strict';
import { composeAgentBriefing } from './index.js';

const briefing = composeAgentBriefing({
  name: 'worker-b',
  peers: [{ name: 'chief-kimi', provider: 'kimi' }],
  messagingAvailable: true,
});

assert.match(briefing, /You are agent "worker-b"/, 'briefing states the agent name');
assert.match(briefing, /chief-kimi \(kimi\)/, 'briefing lists the live roster');
assert.match(briefing, /nvk-msg\.mjs send --to <peer>/, 'briefing teaches the authenticated send verb');
assert.match(briefing, /NVK_AGENT_TOKEN env var/, 'briefing names the injected CREDENTIAL source (D-N6-2)');
assert.match(briefing, /NVK_AGENT_ID is your identity, never a credential/, 'identity and credential are not conflated');
assert.match(briefing, /--interrupt ONLY for real urgency/, 'briefing teaches interrupt etiquette');
assert.match(briefing, /nvk-msg\.mjs read <name>/, 'briefing teaches the read verb');
assert.match(briefing, /send --to '#team'/, 'briefing teaches the fleet room post (N3)');
assert.match(briefing, /send --to '#mission'/, 'briefing teaches the mission room post (N3)');
assert.match(briefing, /shared fleet-wide history every member can read/i, 'FIX 5: #team is honestly a shared read lane');
assert.match(briefing, /push delivery reaches your team\/mission co-members \+ chris/i, 'FIX 5: honest delivery scope');
assert.match(briefing, /cross-team members terminally fail delivery by design/i, 'FIX 5: DEC-14 gate stated honestly');
assert.match(briefing, /read '#team'/, 'briefing teaches room reads');
assert.match(briefing, /\[nvk-msg from <name> id <msgId>\]/, 'briefing teaches the inbound DM prefix');
assert.match(briefing, /\[nvk-room <label> from <name> id <msgId>\]/, 'briefing teaches the inbound room prefix');
assert.match(briefing, /reply by sending a message back, not by answering inline/, 'reply discipline');
assert.ok(!briefing.includes('read-only for agents until the rooms slice'), 'the N2 interim line is gone');
assert.ok(!briefing.includes('\n'), 'briefing is one PTY submission — no raw newlines');

// The deleted surface must never be taught again.
assert.ok(!briefing.includes('--from'), 'no self-claimed sender');
assert.ok(!/\bNVK_AGENT\b/.test(briefing), 'no NVK_AGENT self-claim (NVK_AGENT_ID is the injected one)');
assert.ok(!briefing.includes('/api/messages'), 'no curl to the deleted agent route');
assert.ok(!briefing.includes('NVK_AGENT_ID=agent'), 'the token value is never printed');
console.log('messaging briefing tests passed');

const empty = composeAgentBriefing({ name: 'claude-1', peers: [], messagingAvailable: true });
assert.match(empty, /none yet/, 'empty roster says so');

const plain = composeAgentBriefing({ name: 'plain-1', peers: [], messagingAvailable: false });
assert.match(plain, /unavailable for non-mission agents/, 'plain spawns are told messaging is unavailable');
assert.ok(!plain.includes('send --to'), 'plain spawns are not taught the send verb');
console.log('unavailable-variant tests passed');
