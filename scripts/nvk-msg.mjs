#!/usr/bin/env node
// nvk msg — agent-to-agent messaging through the sealed messaging capability
// (slice N2, the agent direct lane). A thin adapter over the authenticated v2
// REST routes: sender identity comes from the server-injected credential
// (NVK_AGENT_TOKEN env — the D-N6-2 issued token, or --token) — there is NO
// --from, no self-claim, no file fallback, and NO agentId-as-token fallback
// (D-N2-2 is retired: the raw agentId is NOT a credential). A dead server is
// an honest error with a non-zero exit.
//
//   node scripts/nvk-msg.mjs send --to <name> [--interrupt] [--thread <id>] "body"
//   node scripts/nvk-msg.mjs read <name|#team> [--since ISO]
//   node scripts/nvk-msg.mjs names
//
// Token: --token or NVK_AGENT_TOKEN (injected into every spawned PTY's env).
// Server: NVK_COMMAND_URL (default http://127.0.0.1:3031).

import crypto from 'node:crypto';

const SERVER = process.env.NVK_COMMAND_URL || 'http://127.0.0.1:3031';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 1) && true : false; };
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };

const token = opt('--token') || process.env.NVK_AGENT_TOKEN;
if (!token) {
  console.error('nvk-msg: no identity token — pass --token <nvkt_…> or run inside a spawned agent (NVK_AGENT_TOKEN is set for you)');
  process.exit(1);
}

const fail = (message) => { console.error(`nvk-msg: ${message}`); process.exit(1); };

async function api(pathname, init = {}) {
  let response;
  try {
    response = await fetch(SERVER + pathname, {
      signal: AbortSignal.timeout(5000),
      ...init,
      headers: { 'authorization': `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  } catch (error) {
    fail(`server unreachable at ${SERVER} (${error?.cause?.code ?? error?.message ?? 'unknown'}) — no fallback, nothing was sent`);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) fail(`${response.status}: ${payload.error || 'unknown error'}`);
  return payload;
}

const printV2Message = (message, nameFor) => console.log(
  `[nvk-msg from ${nameFor(message.senderId)} id ${message.id}] ${message.createdAt}` +
  `${message.priority === 'urgent' ? ' (interrupt)' : ''}\n  ${message.body.text.replace(/\n/g, '\n  ')}`);

async function addressBookNames() {
  const { agents = [], humans = [] } = await api('/api/messaging/v2/address-book');
  return new Map([...agents, ...humans].map((entry) => [entry.personId, entry.name]));
}

if (cmd === 'send') {
  const interrupt = flag('--interrupt');
  const to = opt('--to');
  const threadId = opt('--thread');
  // audit #4: stale flags must fail loudly — never misdeliver "--from X hi"
  // as the body. Sender identity comes from NVK_AGENT_TOKEN; there is no --from.
  const unknown = args.find((token) => token.startsWith('--'));
  if (unknown) {
    console.error(`nvk-msg: unknown flag "${unknown}" — sender identity comes from NVK_AGENT_TOKEN (there is no --from); run: nvk-msg send --to <name> "body"`);
    process.exit(1);
  }
  if (threadId) {
    console.error("nvk-msg: --thread is not supported by the v2 lane — use --to '#team' / '#mission' for rooms (explicit thread ids are not accepted)");
    process.exit(1);
  }
  const body = args.join(' ').trim();
  if (!to || !body) { console.error('usage: nvk-msg send --to <name> [--interrupt] [--thread <id>] "body"'); process.exit(1); }
  const result = await api('/api/messaging/v2/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to, body, interrupt, clientMessageId: `msg_${crypto.randomUUID()}` }),
  });
  console.log(`${result.messageId} → ${to} (accepted${result.urgentDowngraded ? ', urgent downgraded' : ''})`);

} else if (cmd === 'read') {
  const since = opt('--since');
  const who = args[0];
  if (!who) { console.error('usage: nvk-msg read <name|#team> [--since ISO]'); process.exit(1); }

  const names = await addressBookNames();
  const { messages = [] } = await api(`/api/messaging/v2/messages?with=${encodeURIComponent(who)}`);
  const visible = since ? messages.filter((m) => m.createdAt >= since) : messages;
  if (!visible.length) { console.log('(no messages)'); process.exit(0); }
  const nameFor = (personId) => names.get(personId) ?? personId;
  for (const message of visible) printV2Message(message, nameFor);
  // The v2 route exposes no cursor — a full page (contract pageLimitMax 200)
  // means older history exists beyond this read; say so honestly.
  if (messages.length >= 200) console.log('(page is full at 200 — older messages exist beyond this read)');

} else if (cmd === 'names') {
  const { agents = [], humans = [] } = await api('/api/messaging/v2/address-book');
  const lines = agents.map((agent) => `${agent.name} (${agent.provider})${agent.status ? ` [${agent.status}]` : ''}`);
  for (const human of humans) lines.push(`${human.name} (human)`);
  console.log(lines.join('\n') || '(no live agents)');

} else {
  console.error('usage: nvk-msg <send|read|names>'); process.exit(1);
}
