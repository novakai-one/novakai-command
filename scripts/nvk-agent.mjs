#!/usr/bin/env node
// nvk agent — the M1 operator control path. ONE dependable surface for:
//   spawn + brief an agent (with automatic post-spawn communication check)
//   verify its process and actual activity
//   show its latest useful message/status
//   stop or retire it
//
// Every verb tells the truth from primary evidence (the process table and the
// agent's own session transcript), never from "the bytes were written".
//
//   node scripts/nvk-agent.mjs spawn --provider kimi --title "Name" [--cwd D] [--brief "line"|--brief-file F]
//   node scripts/nvk-agent.mjs register --provider kimi --title "Name" --session <id> --mission <id> [--team <id>] [--project-dir <slug>] [--no-announce]
//   node scripts/nvk-agent.mjs send <agent> "single-line message"
//   node scripts/nvk-agent.mjs status <agent>
//   node scripts/nvk-agent.mjs tail <agent>
//   node scripts/nvk-agent.mjs kill <agent>
//   node scripts/nvk-agent.mjs mailbox <agent>     (report-only until org-rails)
//
// Server: NVK_COMMAND_URL (default http://127.0.0.1:3031).

import { discoverAgents, normalizeBackends, resolveAgent } from './team/channel.mjs';
import { sendAndConfirm } from './team/confirm.mjs';
import { activityProof, checkProcess, latestUseful } from './team/liveness.mjs';
import { locateTranscript } from './team/transcripts.mjs';

const SERVER = process.env.NVK_COMMAND_URL || 'http://127.0.0.1:3031';

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const takeAll = (name) => { const v = []; while (args.includes(name)) v.push(opt(name)); return v.filter(Boolean); };

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message, extra) {
  console.error(`FAIL ${message}`);
  if (extra) console.error(JSON.stringify(extra, null, 2));
  process.exit(2);
}

async function roster() {
  const discovery = await discoverAgents(normalizeBackends([SERVER]));
  if (discovery.unavailable.length > 0) fail(`backend unavailable: ${discovery.unavailable[0].error}`);
  return discovery.agents;
}

async function findAgent(query) {
  try {
    return resolveAgent(await roster(), query);
  } catch (error) {
    fail(error.message);
  }
}

async function waitForSession(agentId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const agents = await roster();
    const agent = agents.find((entry) => entry.agentId === agentId);
    if (!agent) return null;
    if (agent.sessionId) return agent;
    if (agent.status !== 'running') return agent;
    await wait(1000);
  }
  return (await roster()).find((entry) => entry.agentId === agentId) ?? null;
}

function fmtAge(ageMs) {
  if (ageMs === null || ageMs === undefined) return 'unknown';
  const seconds = Math.round(ageMs / 1000);
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}min ago`;
}

async function cmdSpawn() {
  const provider = opt('--provider');
  const title = opt('--title');
  const cwd = opt('--cwd') ?? process.cwd();
  const brief = opt('--brief');
  const briefFile = opt('--brief-file');
  if (!provider || !title) fail('spawn requires --provider and --title');
  if (brief && /\r|\n/.test(brief)) fail('--brief must be single-line (use --brief-file for long briefs)');
  const briefText = brief ?? (briefFile ? `Your briefing is at ${briefFile} — read it first.` : null);

  const response = await fetch(`${SERVER}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, title, cwd }),
  });
  const body = await response.json();
  if (!response.ok) fail(`spawn rejected: ${body.error ?? response.status}`);

  const checks = [];
  // 1. process truth: alive and actually the provider we asked for.
  const proc = checkProcess(body);
  checks.push({ name: 'process-alive', ok: proc.alive });
  checks.push({ name: 'process-is-requested-provider', ok: proc.providerMatch, command: proc.command });

  // 2. session resolved (async for kimi/codex — poll, never assume).
  const agent = await waitForSession(body.agentId);
  checks.push({ name: 'session-resolved', ok: Boolean(agent?.sessionId), sessionId: agent?.sessionId ?? null });

  // 3. post-spawn communication check: brief delivery confirmed via transcript.
  let confirmation = null;
  if (briefText && agent?.sessionId) {
    confirmation = await sendAndConfirm({ agent, body: briefText, from: 'nvk-agent-spawn' });
    checks.push({ name: 'brief-delivery-confirmed', ok: confirmation.status === 'confirmed' });
  } else if (briefText) {
    checks.push({ name: 'brief-delivery-confirmed', ok: false, note: 'no sessionId — cannot confirm' });
  }

  const ok = checks.every((check) => check.ok);
  const report = {
    ok, agentId: body.agentId, title, provider, terminalPid: body.terminalPid,
    sessionId: agent?.sessionId ?? null, checks,
    confirmation: confirmation ? { status: confirmation.status, latencyMs: confirmation.latencyMs, evidence: confirmation.evidence } : null,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) process.exit(2);
}

async function cmdSend(query, body) {
  const agent = await findAgent(query);
  const result = await sendAndConfirm({ agent, body, from: process.env.NVK_AGENT ?? 'nvk-agent' });
  if (result.status === 'confirmed') {
    console.log(`CONFIRMED ${agent.title} received it (${result.latencyMs}ms, id ${result.messageId})`);
  } else {
    fail(`UNCONFIRMED — ${agent.title} shows no new user turn containing the message`, { messageId: result.messageId, ...result.evidence });
  }
}

async function cmdStatus(query) {
  const agent = await findAgent(query);
  const proc = checkProcess(agent);
  const activity = activityProof(agent);
  const latest = latestUseful(agent);
  console.log(`${agent.title} · ${agent.provider} · roster:${agent.status}`);
  console.log(`  process: ${proc.alive ? `pid ${proc.pid} alive` : 'DEAD'}${proc.alive ? (proc.providerMatch ? ' (matches provider)' : ` (MISMATCH — command is: ${proc.command})`) : ''}`);
  console.log(`  activity: ${activity.transcript ? `${activity.events} events, ${activity.userTurns} user turns, last event ${fmtAge(activity.lastEventAgeMs)}` : 'no transcript found'}`);
  console.log(`  latest: ${latest.text ?? '(nothing yet)'}`);
  if (!proc.alive || !proc.providerMatch) process.exit(2);
}

async function cmdTail(query) {
  const agent = await findAgent(query);
  const latest = latestUseful(agent);
  if (!latest.text) fail(`no assistant messages found for ${agent.title}`, { transcript: latest.transcript });
  console.log(latest.text);
}

async function cmdKill(query) {
  const agent = await findAgent(query);
  const response = await fetch(`${SERVER}/api/agents/${agent.agentId}/kill`, { method: 'POST' });
  if (!response.ok) fail(`kill rejected: HTTP ${response.status}`);
  const deadline = Date.now() + 15_000;
  while (Date.now() <= deadline) {
    const proc = checkProcess(agent);
    if (!proc.alive) {
      console.log(`KILLED ${agent.title} — pid ${agent.terminalPid} exited (verified)`);
      return;
    }
    await wait(500);
  }
  fail(`kill unverified — pid ${agent.terminalPid} still alive after 15s`);
}

async function cmdMailbox(query) {
  const agent = await findAgent(query).catch(() => null);
  // Durable mailbox for a persistent role (org rails): registers with the
  // backend's file-loaded registry so replies route without a live PTY.
  const memberName = agent?.title ?? query;
  const response = await fetch(`${SERVER}/api/mailboxes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: memberName, memberName }),
  });
  const body = await response.json();
  if (response.status === 409) {
    console.log(`mailbox "${memberName}" already registered — nothing to do`);
    return;
  }
  if (!response.ok) fail(`mailbox registration rejected: ${body.error ?? response.status}`);
  console.log(`REGISTERED durable mailbox for ${memberName}:`);
  console.log(JSON.stringify(body.identity, null, 2));
}

// Register an externally-spawned session (a terminal-spawned chief or agent)
// into the durable mission graph: Agent record + Presence attach + mailbox,
// so Mission Control's DM lane is backed by durable identity. The pre-flight
// proves the transcript exists BEFORE any store write — registering a
// Presence that cannot be located would be a lie the stores have to keep.
async function cmdRegister() {
  const provider = opt('--provider');
  const title = opt('--title');
  const session = opt('--session');
  const mission = opt('--mission');
  const team = opt('--team');
  const projectDir = opt('--project-dir');
  const noAnnounce = args.includes('--no-announce');
  if (!provider || !title || !session || !mission) {
    fail('register requires --provider, --title, --session, and --mission');
  }
  const transcript = locateTranscript({ provider, sessionId: session, projectDir });
  if (!transcript) {
    fail(`no ${provider} transcript found for session ${session}${provider === 'claude' && !projectDir ? ' (claude needs --project-dir)' : ''} — refusing to register an unlocatable Presence`);
  }
  const response = await fetch(`${SERVER}/api/external-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: title, provider, sessionId: session, missionId: mission,
      ...(team ? { teamId: team } : {}), announce: !noAnnounce,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`register rejected: ${body.error ?? response.status}`);
  console.log(`REGISTERED ${title} — agentId=${body.agentId} team=${body.teamId} mailbox=${body.mailbox} announcement=${body.announcement}`);
  console.log(`  transcript: ${transcript}`);
  console.log(`  DM lane "${title}" — the session reads mail with: node scripts/nvk-msg.mjs read "${title}"`);
  if (body.announcement === 'failed') {
    console.error(`WARN announcement failed: ${body.announcementError}`);
    process.exit(2);
  }
}

// --- D-N6-2: agent messaging tokens (issue/revoke/list) ------------------------
// The backend owns the store; this CLI is a thin REST client. `issue` prints
// the raw token EXACTLY ONCE — it is hash-only at rest afterwards, so a lost
// token means revoke + re-issue, never a lookup.

async function cmdTokenIssue(agentId) {
  const response = await fetch(`${SERVER}/api/messaging/v2/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`token issue rejected: ${body.error ?? response.status}`);
  console.log(body.token);
  console.error(`(shown once — hash-only at rest. Hand it to the foreign agent as: nvk-connect --token <token>)`);
}

async function cmdTokenRevoke(agentId) {
  const response = await fetch(`${SERVER}/api/messaging/v2/tokens/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`token revoke rejected: ${body.error ?? response.status}`);
  console.log(`REVOKED ${body.revoked} live token(s) for ${agentId} — sessions die at their next revalidate`);
}

async function cmdTokenList(agentId) {
  const response = await fetch(`${SERVER}/api/messaging/v2/tokens?agentId=${encodeURIComponent(agentId)}`);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`token list rejected: ${body.error ?? response.status}`);
  const tokens = body.tokens ?? [];
  if (tokens.length === 0) console.log(`(no tokens for ${agentId})`);
  for (const record of tokens) {
    console.log(`${record.id} · created ${record.createdAt} · ${record.revoked ? 'REVOKED' : 'live'}`);
  }
}

if (cmd === 'spawn') await cmdSpawn();
else if (cmd === 'register') await cmdRegister();
else if (cmd === 'send') {
  const query = args.shift();
  const body = args.join(' ');
  if (!query || !body.trim()) fail('usage: nvk-agent.mjs send <agent> "single-line message"');
  await cmdSend(query, body);
} else if (cmd === 'status') await cmdStatus(args[0] ?? fail('status requires an agent'));
else if (cmd === 'tail') await cmdTail(args[0] ?? fail('tail requires an agent'));
else if (cmd === 'kill') await cmdKill(args[0] ?? fail('kill requires an agent'));
else if (cmd === 'mailbox') await cmdMailbox(args[0] ?? fail('mailbox requires an agent'));
else if (cmd === 'token') {
  const verb = args.shift();
  const agentId = opt('--agent') ?? fail('token requires --agent <agentId>');
  if (verb === 'issue') await cmdTokenIssue(agentId);
  else if (verb === 'revoke') await cmdTokenRevoke(agentId);
  else if (verb === 'list') await cmdTokenList(agentId);
  else fail('usage: nvk-agent.mjs token <issue|revoke|list> --agent <agentId>');
} else {
  console.error('usage: nvk-agent.mjs <spawn|register|send|status|tail|kill|mailbox|token> ...');
  process.exit(1);
}
