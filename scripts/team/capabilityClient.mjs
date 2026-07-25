// capabilityClient.mjs — THE client half of the @novakai/messaging
// capability for standalone scripts (N5, D-N5-2): never a journal-file
// reader. This is the N7 bridge seed — the two-way Slack bridge grows out of
// these seams, so they are deliberately small and importable.
//
//   resolveRoster()          → name lookup (personId → display name)
//   resolveThreadLanes()     → threadId → lane label ('#team', '#<name>')
//   fetchThreadMessages(id)  → trailing window for one thread (backlog)
//   openCapabilitySocket()   → the browser dialect as a CLIENT:
//                              ws /ws + {type:'messaging-v2-sub', since?} →
//                              {event:'messaging-v2', payload:<frame>} stream
//
// Auth: NONE of this needs a token — the browser dialect and the
// server-owned /user routes are the same trust boundary the app uses.

import { WebSocket } from 'ws';

export const HUMAN_NAME = 'chris';
export const HUMAN_PERSON_ID = 'person_user-chris';

const DEFAULT_SERVER = process.env.NVK_COMMAND_URL || 'http://127.0.0.1:3031';

function serverUrl(override) {
  return (override || DEFAULT_SERVER).replace(/\/$/, '');
}

async function getJson(base, path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
  return response.json();
}

/** personId → agentId: the exact inverse of the authority's derivation
 * (person_${agentId.replaceAll('_','-')}), for agent_<uuid> ids.
 * FRAGILE (F7, accepted): stringly-typed by construction — any change to the
 * authority's derivation silently breaks name resolution (unknown personIds
 * pass through raw). Left as-is until the roster route exposes personIds. */
function agentIdForPersonId(personId) {
  if (!personId.startsWith('person_agent-')) return null;
  return personId.slice('person_'.length).replace('-', '_');
}

/** personId → display name: the human is chris; agents forward-derive
 * against the live roster (never guessed — unknown personIds pass through). */
export async function resolveRoster(server) {
  const base = serverUrl(server);
  const { agents = [] } = await getJson(base, '/api/agents');
  const byId = new Map(agents.map((agent) => [agent.agentId, agent.title]));
  return (personId) => {
    if (personId === HUMAN_PERSON_ID) return HUMAN_NAME;
    const agentId = agentIdForPersonId(personId);
    return (agentId && byId.get(agentId)) || personId;
  };
}

/** threadId → lane label: the server-owned threads route (labels enriched). */
export async function resolveThreadLanes(server) {
  const base = serverUrl(server);
  const { threads = [] } = await getJson(base, '/api/messaging/v2/user/threads');
  const lanes = new Map();
  for (const thread of threads) {
    lanes.set(thread.id, thread.label ?? (thread.room ? `#${thread.room.externalId}` : thread.id));
  }
  return lanes;
}

/** The trailing window for one thread (server-owned human route). */
export async function fetchThreadMessages(server, threadId) {
  const base = serverUrl(server);
  const { messages = [] } = await getJson(base, `/api/messaging/v2/user/messages?threadId=${encodeURIComponent(threadId)}`);
  return messages;
}

const wsUrlFor = (base) => base.replace(/^http/, 'ws') + '/ws';

/**
 * Open the browser-dialect subscription as a CLIENT. Frames arrive as
 * {event:'messaging-v2', payload:<SubscriptionMessage>} — onFrame gets the
 * payload verbatim. Reconnects with 500ms→8s backoff, resuming from the
 * caller's cursor each time (at-least-once; the caller dedupes by sequence).
 */
export function openCapabilitySocket({ server, since, onFrame, onOpen, onRetryWait, log = () => {} }) {
  const base = serverUrl(server);
  let socket;
  let attempts = 0;
  let closed = false;

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(wsUrlFor(base));
    socket.on('open', () => {
      attempts = 0;
      log('connected; subscribing', since ? `(since ${since()})` : '(from tip)');
      socket.send(JSON.stringify({ type: 'messaging-v2-sub', ...(since && since() ? { since: since() } : {}) }));
      onOpen?.();
    });
    socket.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        return; // malformed frames never reach the consumer
      }
      if (frame.event === 'messaging-v2') onFrame(frame.payload);
    });
    socket.on('close', () => {
      if (closed) return;
      attempts += 1;
      const waitMs = Math.min(500 * 2 ** (attempts - 1), 8000);
      onRetryWait?.(waitMs);
      setTimeout(connect, waitMs);
    });
    socket.on('error', () => socket.close());
  };

  connect();
  return {
    close() {
      closed = true;
      socket?.close();
    },
  };
}
