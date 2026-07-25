import assert from 'node:assert/strict';
import type { AgentInfo } from '../../../../lib/agentSocket/index.js';
import type { Conversation, TunnelEnvelope } from '../../../../lib/messagingV2/index.js';
import { buildConversations, dmId, registeredRoster } from '../../../../lib/messagingV2/index.js';
import { createLaneFlows } from '../flows/index.js';
import {
  DEFAULT_RAIL_WIDTHS,
  DENSITY_SCALE,
  MESSAGING_SETTINGS,
  capRailLanes,
  clampRailWidth,
  composerTargetsFor,
  dayLabelFor,
  displayNameFor,
  distinctRailLabels,
  visibleLanesFor,
  dmLaneFor,
  filterRailLanes,
  groupByDay,
  initialFor,
  isCollapsible,
  isOwnFreshSend,
  knownAgentsFor,
  laneStatsFor,
  mentionQueryAt,
  mentionSuggestions,
  parseRailWidths,
  recapNotesFor,
  replyLabelFor,
  resolveSelectedLane,
  reviewLanesFor,
  roleFor,
  roomIdentityFor,
  roomLabelFor,
  rowDeliveryFor,
  snippetFor,
  splitRailSections,
  windowMessages,
  userScrollActive,
  workingAgentFor,
  WORKING_WINDOW_MS,
} from '../model.js';
import { FOLD_STYLE, NEW_ACTION_STYLE, PICKER_STYLE, SHELL_STYLE, resolveStyle } from '../styles/index.js';

function envelope(overrides: Partial<TunnelEnvelope>): TunnelEnvelope {
  return {
    id: 'msg_1',
    from: 'claude-1',
    'to': 'chris',
    delivery: 'normal',
    body: 'hello',
    createdAt: '2026-07-19T09:00:00.000Z',
    status: 'delivered',
    ...overrides,
  };
}

function agent(overrides: Partial<AgentInfo>): AgentInfo {
  return {
    agentId: 'a1',
    title: 'claude-1',
    provider: 'claude',
    sessionId: 's1',
    projectDir: '/tmp',
    cwd: '/tmp',
    status: 'running',
    createdAt: '2026-07-19T08:00:00.000Z',
    ...overrides,
  } as AgentInfo;
}

function lane(id: string, kind: Conversation['kind'], title: string): Conversation {
  return { id, kind, title };
}

// Density-as-data: the three locked scale factors.
assert.equal(DENSITY_SCALE.low, 1.0);
assert.equal(DENSITY_SCALE.normal, 1.3);
assert.equal(DENSITY_SCALE.high, 1.7);

// Rail sections: #team pinned first, rooms next, dms separate (TEAMS hidden).
const sections = splitRailSections([
  lane('room_b', 'room', 'beta'),
  lane('dm:claude-1', 'dm', 'claude-1'),
  lane('#team', 'channel', '#team'),
  lane('room_a', 'room', 'alpha'),
]);
assert.deepEqual(sections.rooms.map((entry) => entry.id), ['#team', 'room_b', 'room_a']);
assert.deepEqual(sections.directs.map((entry) => entry.id), ['dm:claude-1']);
assert.equal(roomLabelFor(lane('#team', 'channel', '#team')), 'team');

// Identity labels.
assert.equal(displayNameFor('chris'), 'Chris');
assert.equal(displayNameFor('claude-1'), 'claude-1');
assert.equal(initialFor('chris'), 'C');
assert.equal(initialFor('maya'), 'M');
assert.equal(roleFor('chris', []), 'Product owner');
assert.equal(roleFor('claude-1', [agent({})]), 'claude');
assert.equal(roleFor('ghost', [agent({})]), 'agent');

// Working heuristic: newest envelope TO a running agent, fresh → working.
const nowMs = Date.parse('2026-07-19T09:05:00.000Z');
const toAgent = [envelope({ from: 'chris', 'to': 'claude-1', createdAt: '2026-07-19T09:01:00.000Z' })];
assert.equal(workingAgentFor(toAgent, [agent({})], nowMs), 'claude-1');
// …cleared the moment the agent answers (newest envelope is FROM them).
const agentAnswered = [...toAgent, envelope({ id: 'msg_2', from: 'claude-1', 'to': 'chris' })];
assert.equal(workingAgentFor(agentAnswered, [agent({})], nowMs), null);
// …never fires for exited agents, stale envelopes, rooms, or #team.
assert.equal(workingAgentFor(toAgent, [agent({ status: 'exited' })], nowMs), null);
const stale = [envelope({ from: 'chris', 'to': 'claude-1', createdAt: '2026-07-19T08:00:00.000Z' })];
assert.equal(workingAgentFor(stale, [agent({})], nowMs), null);
assert.ok(WORKING_WINDOW_MS < nowMs - Date.parse('2026-07-19T08:00:00.000Z'));
const toRoom = [envelope({ from: 'chris', 'to': 'room_abc' })];
assert.equal(workingAgentFor(toRoom, [agent({})], nowMs), null);
const toTeam = [envelope({ from: 'chris', 'to': '#team' })];
assert.equal(workingAgentFor(toTeam, [agent({})], nowMs), null);

// Day grouping: TODAY label, per-day splits, stable order.
const nowDate = new Date('2026-07-19T12:00:00');
const mixed = [
  envelope({ createdAt: '2026-07-18T23:00:00' }),
  envelope({ id: 'msg_2', createdAt: '2026-07-19T08:00:00' }),
  envelope({ id: 'msg_3', createdAt: '2026-07-19T09:00:00' }),
];
const groups = groupByDay(mixed, nowDate);
assert.equal(groups.length, 2);
assert.equal(groups[1].label, 'TODAY');
assert.equal(groups[1].messages.length, 2);
assert.equal(dayLabelFor('2026-07-18T23:00:00', nowDate), 'JUL 18');

// Reply context only when the parent envelope is actually known.
const parent = envelope({ id: 'msg_parent', from: 'claude-1' });
const reply = envelope({ id: 'msg_reply', threadId: 'msg_parent' });
assert.equal(replyLabelFor(reply, [parent, reply]), 'Replying to claude-1');
assert.equal(replyLabelFor(reply, [reply]), null);
assert.equal(replyLabelFor(envelope({}), [parent]), null);

// Stats: real derived counts per lane.
const laneMessages = [
  envelope({ from: 'chris', 'to': 'claude-1', status: 'delivered' }),
  envelope({ id: 'msg_2', from: 'claude-1', 'to': 'chris', status: 'delivered' }),
  envelope({ id: 'msg_3', from: 'chris', 'to': 'claude-1', status: 'failed' }),
];
assert.deepEqual(laneStatsFor(laneMessages), { sent: 2, received: 1, delivered: 2, queued: 0, failed: 1 });

// Recap notes: unread, members, last word — all derived.
const room = lane('room_a', 'room', 'alpha');
room.members = ['chris', 'claude-1'];
const notes = recapNotesFor(room, laneMessages, 2);
assert.equal(notes[0], '2 unread here.');
assert.equal(notes[1], '2 members in this room.');
assert.ok(notes[2].startsWith('Last word '));
assert.equal(recapNotesFor(room, [], 0)[2], 'Nothing said yet.');

// Room identity header (M4): kind + honest member count. The #team channel
// carries no member list, so it shows its kind alone — no invented number.
assert.equal(roomIdentityFor(lane('#team', 'channel', '#team')), 'Channel');
assert.equal(roomIdentityFor(room), 'Mission room · 2 members');
assert.equal(
  roomIdentityFor({ id: 'room_solo', kind: 'room', title: 'solo', members: ['chris'] }),
  'Mission room · 1 member',
);

// Review resilience (M4): the target's lanes are derived from the envelope;
// a stale notice (envelope gone from the feed) resolves to null honestly.
// N4: a row's `to` IS its lane (one thread, one lane).
const reviewFeed = [
  envelope({ id: 'msg_room_fail', 'to': '#team' }),
  envelope({ id: 'msg_dm_fail', 'to': 'dm:claude-1' }),
];
assert.deepEqual(reviewLanesFor(reviewFeed, 'msg_room_fail'), ['#team']);
assert.deepEqual(reviewLanesFor(reviewFeed, 'msg_dm_fail'), ['dm:claude-1']);
assert.equal(reviewLanesFor(reviewFeed, 'msg_gone'), null);

// Collapsible messages: threshold is typed data; snippets flatten whitespace.
const longBody = 'word '.repeat(120).trim(); // 600 chars > 280
assert.equal(isCollapsible(longBody), true);
assert.equal(isCollapsible('short note'), false);
const snippet = snippetFor(longBody);
assert.ok(snippet.endsWith('…'));
assert.ok(snippet.length <= 282); // 280 + ellipsis, trimmed
assert.equal(snippetFor('line one\n\nline   two'), 'line one line   two'.replace('   ', ' '));
assert.equal(isCollapsible('x'.repeat(280)), false);
assert.equal(isCollapsible('x'.repeat(281)), true);

// Rail widths: clamps, parse fallbacks, round-trip honesty.
assert.equal(clampRailWidth('rail', 100), 180);
assert.equal(clampRailWidth('rail', 999), 360);
assert.equal(clampRailWidth('rail', 240.4), 240);
assert.equal(clampRailWidth('context', 50), 220);
assert.equal(clampRailWidth('context', 999), 440);
assert.equal(clampRailWidth('rail', Number.NaN), DEFAULT_RAIL_WIDTHS.rail);
assert.deepEqual(parseRailWidths(null), DEFAULT_RAIL_WIDTHS);
assert.deepEqual(parseRailWidths('not json'), DEFAULT_RAIL_WIDTHS);
assert.deepEqual(parseRailWidths('{"rail":250}'), { rail: 250, context: 280 });
assert.deepEqual(parseRailWidths('{"rail":1,"context":9999}'), { rail: 180, context: 440 });

// @ mention picker: query detection + suggestion ranking.
assert.deepEqual(mentionQueryAt('hello @may', 10), { start: 6, query: 'may' });
assert.deepEqual(mentionQueryAt('@', 1), { start: 0, query: '' });
assert.equal(mentionQueryAt('email a@b.com', 9), null);        // @ mid-word
assert.equal(mentionQueryAt('done @maya now', 13), null);      // caret past a space
assert.equal(mentionQueryAt('no sign', 7), null);
// A fresh second @ opens a new empty query (picker shows all members).
assert.deepEqual(mentionQueryAt('two @ma @', 9), { start: 8, query: '' });
assert.deepEqual(mentionQueryAt('two @ma @x', 10), { start: 8, query: 'x' });
assert.deepEqual(mentionQueryAt(' @@op', 5), { start: 2, query: 'op' }); // abandoned @ restarts
const mentionTargets = [
  { objectId: 'agent:maya', label: 'maya', kind: 'agent' as const },
  { objectId: 'agent:atlas', label: 'atlas', kind: 'agent' as const },
  { objectId: 'agent:maverick', label: 'maverick', kind: 'agent' as const },
  { objectId: 'thread:t1', label: 'maya-thread', kind: 'thread' as const },
];
assert.deepEqual(
  mentionSuggestions(mentionTargets, 'ma', 6).map((target) => target.label),
  ['maya', 'maverick'], // prefix first, threads excluded
);
assert.deepEqual(
  mentionSuggestions(mentionTargets, 'la', 6).map((target) => target.label),
  ['atlas'], // substring match
);
assert.equal(mentionSuggestions(mentionTargets, '', 2).length, 2); // limit caps the open picker
// Duplicate roster names (real-data collision) collapse to one option.
const colliding = [
  { objectId: 'agent:Worlds Greatest Team · claude', label: 'Worlds Greatest Team · claude', kind: 'agent' as const },
  { objectId: 'agent:Worlds Greatest Team · claude', label: 'Worlds Greatest Team · claude', kind: 'agent' as const },
];
assert.equal(mentionSuggestions(colliding, '', 6).length, 1);

// Delivery grammar: queued is transient; stale queued settles honestly.
const windowMs = MESSAGING_SETTINGS.delivery.sendingWindowMs;
const freshQueued = envelope({ status: 'queued', from: 'chris', createdAt: '2026-07-19T09:04:55.000Z' });
assert.equal(rowDeliveryFor(freshQueued, nowMs), 'sending');
const staleOwn = envelope({ status: 'queued', from: 'chris', createdAt: '2026-07-19T08:00:00.000Z' });
assert.ok(nowMs - Date.parse(staleOwn.createdAt) > windowMs);
assert.equal(rowDeliveryFor(staleOwn, nowMs), 'undelivered');
const staleOther = envelope({ status: 'queued', from: 'claude-1', createdAt: '2026-07-19T08:00:00.000Z' });
assert.equal(rowDeliveryFor(staleOther, nowMs), 'quiet');
assert.equal(rowDeliveryFor(envelope({ status: 'failed' }), nowMs), 'failed');
assert.equal(rowDeliveryFor(envelope({ status: 'delivered' }), nowMs), 'quiet');
// The boundary: exactly at the window edge is no longer "Sending…".
const edge = envelope({ status: 'queued', from: 'chris', createdAt: new Date(nowMs - windowMs).toISOString() });
assert.equal(rowDeliveryFor(edge, nowMs), 'undelivered');

// Style blocks (doctrine §B): frozen typed attachments, ONE resolver seam.
assert.ok(Object.isFrozen(SHELL_STYLE.base));
assert.ok(Object.isFrozen(SHELL_STYLE.contextClosed));
assert.ok(Object.isFrozen(FOLD_STYLE.fold));
assert.ok(Object.isFrozen(FOLD_STYLE.open));
assert.ok(Object.isFrozen(NEW_ACTION_STYLE.base));
assert.ok(Object.isFrozen(PICKER_STYLE.agentPicked));
assert.equal(resolveStyle(NEW_ACTION_STYLE.base, NEW_ACTION_STYLE.active), 'msg-new-action is-active');
assert.equal(resolveStyle(PICKER_STYLE.agent, PICKER_STYLE.agentPicked), 'msg-picker-agent is-picked');
assert.equal(SHELL_STYLE.base.className, 'msg-view');
assert.equal(SHELL_STYLE.contextClosed.className, 'msg-context-closed');
assert.ok(Object.isFrozen(SHELL_STYLE.railCollapsed));
assert.equal(SHELL_STYLE.railCollapsed.className, 'msg-rail-collapsed');
// resolveStyle combines only the attached blocks, in order, no duplicates logic.
assert.equal(resolveStyle(SHELL_STYLE.base), 'msg-view');
assert.equal(
  resolveStyle(SHELL_STYLE.base, SHELL_STYLE.contextClosed, false, SHELL_STYLE.railOverlayOpen),
  'msg-view msg-context-closed msg-rail-open',
);
assert.equal(resolveStyle(FOLD_STYLE.fold, FOLD_STYLE.open), 'msg-row-fold is-open');
assert.equal(resolveStyle(FOLD_STYLE.fold, false, null, undefined), 'msg-row-fold');
assert.equal(resolveStyle(), '');

// Known agents (M5): the pickers' union of registered agents (any status)
// and feed-history names — live first, then alphabetical.
assert.deepEqual(knownAgentsFor([], []), []);
const known = knownAgentsFor(
  [
    agent({ title: 'zeta', status: 'exited' }),
    agent({ title: 'maya', status: 'running', provider: 'claude' }),
  ],
  [
    envelope({ from: 'atlas', 'to': 'chris' }),
    envelope({ from: 'chris', 'to': 'room_1' }),
    envelope({ from: 'chris', 'to': '#team' }),
  ],
);
assert.deepEqual(
  known,
  [
    { name: 'maya', provider: 'claude', live: true },      // live sorts first
    { name: 'atlas', provider: null, live: false },        // feed-only: name is all history knows
    { name: 'zeta', provider: 'claude', live: false },     // exited stays known, provider kept
  ],
);
// A live record beats an exited duplicate of the same title.
assert.deepEqual(
  knownAgentsFor(
    [agent({ title: 'maya', status: 'exited' }), agent({ title: 'maya', status: 'running' })],
    [],
  ),
  [{ name: 'maya', provider: 'claude', live: true }],
);
// chris, rooms, and channels are never agent candidates.
assert.deepEqual(
  knownAgentsFor([], [envelope({ from: 'chris', 'to': 'room_x' }), envelope({ from: 'chris', 'to': '#team' })]),
  [],
);
// An agent record already known is not re-derived from the feed.
assert.deepEqual(
  knownAgentsFor([agent({ title: 'maya' })], [envelope({ from: 'maya', 'to': 'chris' })]),
  [{ name: 'maya', provider: 'claude', live: true }],
);

// DM lane overlay (M5): a not-yet-derived lane resolves through the overlay.
const openedDm = dmLaneFor('nova');
assert.deepEqual(openedDm, { id: 'dm:nova', kind: 'dm', title: 'nova' });
assert.equal(resolveSelectedLane([lane('#team', 'channel', '#team')], openedDm, 'dm:nova'), openedDm);
const derivedDm = lane('dm:maya', 'dm', 'maya');
assert.equal(resolveSelectedLane([derivedDm], openedDm, 'dm:maya'), derivedDm); // the derived lane wins
assert.equal(resolveSelectedLane([derivedDm], openedDm, 'dm:other'), null); // stale overlay never leaks
assert.equal(resolveSelectedLane([], null, null), null);

// Send-and-know (M7): only Chris's own FRESH send pulls a scrolled-up feed.
const sendWindow = MESSAGING_SETTINGS.sendFollow.ownSendWindowMs;
const ownFresh = envelope({ from: 'chris', 'to': 'claude-1', createdAt: '2026-07-19T09:04:58.000Z' });
assert.ok(nowMs - Date.parse(ownFresh.createdAt) < sendWindow);
assert.equal(isOwnFreshSend(ownFresh, nowMs), true);
assert.equal(isOwnFreshSend(envelope({ from: 'claude-1' }), nowMs), false); // incoming never yanks
assert.equal(isOwnFreshSend(envelope({ from: 'chris', createdAt: '2026-07-19T08:00:00.000Z' }), nowMs), false);
assert.equal(isOwnFreshSend(undefined, nowMs), false);
// Active-scroll guard: a gesture inside the window means "hands on the feed".
const guardMs = MESSAGING_SETTINGS.sendFollow.scrollGuardMs;
assert.equal(userScrollActive(null, nowMs), false);
assert.equal(userScrollActive(nowMs - guardMs + 1, nowMs), true);
assert.equal(userScrollActive(nowMs - guardMs, nowMs), false); // boundary: no longer active

// Rail search (M8c): case-insensitive substring over titles; empty query passes through.
const searchable = [lane('#team', 'channel', '#team'), lane('room_a', 'room', 'alpha'), lane('dm:maya', 'dm', 'maya')];
assert.equal(filterRailLanes(searchable, ''), searchable);
assert.equal(filterRailLanes(searchable, '   '), searchable);
assert.deepEqual(filterRailLanes(searchable, 'MAY').map((entry) => entry.id), ['dm:maya']);
assert.deepEqual(filterRailLanes(searchable, 'a').map((entry) => entry.id), ['#team', 'room_a', 'dm:maya']);
assert.deepEqual(filterRailLanes(searchable, 'zzz'), []);

// Composer mention universe (M8a): known agents (live or not) become agent
// targets — the picker opens on a bare @ even with an empty live roster.
assert.deepEqual(composerTargetsFor([]), []);
assert.deepEqual(
  composerTargetsFor([
    { name: 'maya', provider: 'claude', live: true },
    { name: 'atlas', provider: null, live: false },
  ]),
  [
    { objectId: 'agent:maya', label: 'maya', kind: 'agent' },
    { objectId: 'agent:atlas', label: 'atlas', kind: 'agent' },
  ],
);
// …and those targets feed the picker on an EMPTY query (bare @), not just
// with filter text — the review miss was the universe, not the trigger.
const offlineTargets = composerTargetsFor([{ name: 'atlas', provider: null, live: false }]);
assert.deepEqual(mentionSuggestions(offlineTargets, '', 6).map((target) => target.label), ['atlas']);


// ---- C1 (audit S4): hard rail bound, +page to ceiling, #team pinned --------
{
  const many: Conversation[] = [];
  for (let index = 0; index < 120; index += 1) many.push(lane(`dm:agent-${index}`, 'dm', `agent-${index}`));
  many.splice(60, 0, lane('#team', 'channel', '#team')); // channel buried mid-list
  for (let index = 120; index < 220; index += 1) many.push(lane(`room_${index}`, 'room', `room-${index}`));

  const first = capRailLanes(many, MESSAGING_SETTINGS.rail.cap);
  assert.equal(first.lanes.length, 50);
  assert.equal(first.lanes[0].id, '#team'); // pinned above the cap, never displaced
  assert.equal(first.hiddenCount, many.length - 50);

  const paged = capRailLanes(many, MESSAGING_SETTINGS.rail.cap + MESSAGING_SETTINGS.rail.page);
  assert.equal(paged.lanes.length, 100);
  assert.equal(paged.lanes[0].id, '#team');

  // The ceiling is HARD: any visibleCount beyond it renders exactly 150.
  assert.equal(capRailLanes(many, 150).lanes.length, 150);
  assert.equal(capRailLanes(many, 200).lanes.length, 150);
  assert.equal(capRailLanes(many, 99999).lanes.length, 150);
  assert.equal(capRailLanes(many, 99999).hiddenCount, many.length - 150);

  // Under the bound: everything renders, nothing hidden, #team still first.
  const fewLanes = [lane('dm:a', 'dm', 'a'), lane('#team', 'channel', '#team')];
  const small = capRailLanes(fewLanes, MESSAGING_SETTINGS.rail.cap);
  assert.equal(small.lanes.length, 2);
  assert.equal(small.lanes[0].id, '#team');
  assert.equal(small.hiddenCount, 0);

  // No channel present (filtered search result): plain bounded slice.
  const noTeam = capRailLanes(many.filter((entry) => entry.kind !== 'channel'), 50);
  assert.equal(noTeam.lanes.length, 50);
  assert.equal(noTeam.lanes[0].id, 'dm:agent-0');
}

// ---- C1 thread window + M3 anchored window ---------------------------------
{
  const feed: TunnelEnvelope[] = [];
  for (let index = 0; index < 250; index += 1) {
    feed.push(envelope({ id: `env-${index}`, createdAt: new Date(1700000000000 + index * 1000).toISOString() }));
  }
  const tail = windowMessages(feed, MESSAGING_SETTINGS.thread.windowSize);
  assert.equal(tail.messages.length, 100);
  assert.equal(tail.messages[0].id, 'env-150');
  assert.equal(tail.earlierCount, 150);
  assert.equal(tail.laterCount, 0);

  const short = windowMessages(feed.slice(0, 5), 100);
  assert.equal(short.messages.length, 5);
  assert.equal(short.earlierCount, 0);
  assert.equal(short.laterCount, 0);

  // Anchored (review reaches a target older than the tail window): the
  // window is bounded AROUND the anchor, with honest earlier/later counts.
  const anchored = windowMessages(feed, 100, 'env-20');
  assert.equal(anchored.messages.length, 100);
  assert.ok(anchored.messages.some((entry) => entry.id === 'env-20'));
  assert.equal(anchored.earlierCount, 0);
  assert.equal(anchored.laterCount, 150);

  const midWindow = windowMessages(feed, 100, 'env-125');
  assert.equal(midWindow.messages.length, 100);
  assert.ok(midWindow.messages.some((entry) => entry.id === 'env-125'));
  assert.equal(midWindow.earlierCount + midWindow.laterCount, 150);

  // Unknown anchor falls back to the tail window.
  const missing = windowMessages(feed, 100, 'env-nope');
  assert.equal(missing.messages[0].id, 'env-150');
  assert.equal(missing.earlierCount, 150);
}

// ---- C2 (audit M1): shortest progressively-extended unique suffix ----------
{
  // Two rooms sharing a name, ids differing early but SHARING the last 4
  // chars — last-4 alone cannot disambiguate; the suffix must extend.
  const collide = [
    lane('room_aaaa-1234', 'room', 'triage'),
    lane('room_bbbb-1234', 'room', 'triage'),
    lane('dm:maya', 'dm', 'maya'),
  ];
  const labels = distinctRailLabels(collide);
  const labelOne = labels.get('room_aaaa-1234');
  const labelTwo = labels.get('room_bbbb-1234');
  assert.ok(labelOne && labelTwo && labelOne !== labelTwo, 'colliding rooms must render distinct labels');
  assert.ok(labelOne.startsWith('triage · ') && labelTwo.startsWith('triage · '));
  // Shortest-first: 4 chars tie ("1234"), 5 chars tie ("-1234"), 6 disambiguate.
  assert.equal(labelOne, 'triage · a-1234');
  assert.equal(labelTwo, 'triage · b-1234');
  assert.equal(labels.get('dm:maya'), 'maya'); // unique labels untouched

  // A room literally named 'team' collides with the #team channel label —
  // both get suffixed (collisions span sections).
  const teamClash = [
    lane('#team', 'channel', '#team'),
    lane('room_cafe-0001', 'room', 'team'),
  ];
  const teamLabels = distinctRailLabels(teamClash);
  assert.notEqual(teamLabels.get('#team'), teamLabels.get('room_cafe-0001'));
  assert.ok(teamLabels.get('room_cafe-0001')?.startsWith('team · '));

  // Full-id fallback: ids whose every same-length suffix ties (one id is a
  // suffix of the other) — the longer id's full length disambiguates.
  const nested = [
    lane('room_x-77', 'room', 'ops'),
    lane('room_xx-77', 'room', 'ops'),
  ];
  const nestedLabels = distinctRailLabels(nested);
  assert.notEqual(nestedLabels.get('room_x-77'), nestedLabels.get('room_xx-77'));
}

// ---- C3 (audit S2): lane pruning, composed through buildConversations ------
// N4 semantics: (a) direct threads are the human's OWN by contract (R3) —
// chris-party is the only kind of DM history the capability serves; (b)
// empty lane → registered agent, ANY status; (c) #team always; (d) room
// lanes carry members: [chris] (D-N3-1 host policy: the human is in every
// roster). Agent↔agent DM lanes are UNSERVABLE (R3) and never appear.
{
  const agents = [
    agent({ agentId: 'ag-c', title: 'worker-c', status: 'exited' }),   // empty, exited
    agent({ agentId: 'ag-d', title: 'worker-d', status: 'running' }),  // empty, running
    agent({ agentId: 'agent_e', title: 'worker-e', status: 'running' }),  // chris-party thread
  ];
  const threads = [
    { id: 'thread_fleet', threadKind: 'team' as const, label: '#team' },
    { id: 'thread_crew', threadKind: 'team' as const, label: '#Crew Room' },
    { id: 'thread_dm_e', threadKind: 'direct' as const, direct: { pair: ['person_user-chris', 'person_agent-e'] as [string, string] } },
  ];
  const feed = [
    envelope({ id: 'p1', from: 'worker-e', 'to': 'dm:worker-e', body: 'hello chris' }),
    envelope({ id: 'p2', from: 'chris', 'to': 'dm:worker-e', body: 'hi' }),
  ];
  const lanes = buildConversations(threads, feed, agents);
  assert.ok(lanes.some((entry) => entry.id === 'dm:worker-c'), 'exited empty lane must materialize');
  assert.ok(lanes.some((entry) => entry.id === 'dm:worker-e' && entry.threadId === 'thread_dm_e'), 'the direct thread derives its dm lane');
  const visible = visibleLanesFor(lanes, feed, agents).map((entry) => entry.id);
  assert.ok(visible.includes('#team'), '(c) #team always');
  assert.ok(visible.includes('#Crew Room'), '(d) the human is a member of every roster (D-N3-1)');
  assert.ok(visible.includes('dm:worker-e'), '(a) chris-party history kept');
  assert.ok(visible.includes('dm:worker-c'), '(b) empty exited registered kept');
  assert.ok(visible.includes('dm:worker-d'), '(b) empty running registered kept');
  assert.ok(!visible.includes('dm:worker-f'), 'unregistered empty names stay hidden');
}

// ---- C4 (audit S1): spawn lane renders from the 201 ALONE ------------------
// Composed through the same seams the view uses. Phase 1 — the roster frame
// is WITHHELD: buildConversations knows nothing of the spawned agent, so the
// lane exists only as the overlay spawnAgent created before selecting.
{
  const spawnedTitle = 'claude-7'; // as minted by the POST /api/agents 201
  const overlay = dmLaneFor(spawnedTitle);
  const selectedId = overlay.id;
  const withheld = visibleLanesFor(buildConversations([], [], []), [], []);
  assert.equal(withheld.some((entry) => entry.id === overlay.id), false, 'no derived lane before the frame');
  const rendered = resolveSelectedLane(withheld, overlay, selectedId);
  assert.ok(rendered, 'the overlay lane renders from the 201 alone');
  assert.equal(rendered.id, dmId(spawnedTitle));
  assert.equal(rendered.kind, 'dm');

  // Phase 2 — the agents-changed frame lands: the lane derives for real,
  // survives pruning (registered + empty), and reconciliation prefers the
  // DERIVED lane over the overlay.
  const roster = [agent({ agentId: 'ag-7', title: spawnedTitle, status: 'running' })];
  const derived = visibleLanesFor(buildConversations([], [], roster), [], roster);
  const reconciled = resolveSelectedLane(derived, overlay, selectedId);
  assert.ok(reconciled, 'lane still selected after the frame');
  assert.equal(reconciled.id, dmId(spawnedTitle));
  assert.ok(derived.includes(reconciled), 'reconciled to the derived lane, not the overlay');
}

// ---- C4 (audit S1 + evidence correction): spawnAgent through the REAL
// composition — createLaneFlows drives the actual POST /api/agents fetch
// seam (faked at globalThis) with the agents-changed frame withheld; the
// assertions check the SEQUENCE, not a hand-assembled postcondition.
{
  const spawnCalls: string[] = [];
  let overlay: Conversation | null = null;
  let overlayAtSelection: Conversation | null = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (requestUrl: unknown, init?: { method?: string; body?: string }) => {
    spawnCalls.push(`${init?.method ?? 'GET'} ${String(requestUrl)} ${init?.body ?? ''}`);
    return new Response(
      JSON.stringify({ agentId: 'ag-99', title: 'claude-9', provider: 'claude', status: 'running' }),
      { status: 201 },
    );
  }) as typeof fetch;
  try {
    const flows = createLaneFlows({
      setOverlay: (lane) => { overlay = lane; },
      openLane: (laneId) => {
        overlayAtSelection = overlay; // capture ordering: overlay must already exist
        spawnCalls.push(`open ${laneId}`);
      },
    });
    await flows.spawnAgent('claude');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(
    spawnCalls.some((entry) => entry.startsWith('POST /api/agents') && entry.includes('"provider":"claude"')),
    'spawn goes through the real POST /api/agents seam',
  );
  assert.equal((overlayAtSelection as Conversation | null)?.id, dmId('claude-9'), 'overlay derived from the 201 title BEFORE selection (S1)');
  assert.ok(spawnCalls.includes('open dm:claude-9'), 'lane selected from the 201 alone — roster frame withheld');
}

console.log('messages/model tests passed');
