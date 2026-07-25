// slackFormat.mjs — Slack payload formatting for the slack-mirror (and the
// N7 bridge, which reuses it for app→Slack). Pure presentation: envelope-ish
// rows in, webhook payloads out. Extracted from nvk-slack-mirror.mjs in N5 —
// byte for byte the old grammar.

const BODY_MAX = 500;

const timeOf = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '??:??'
    : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

const truncate = (body) => {
  const flat = String(body ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= BODY_MAX ? flat : `${flat.slice(0, BODY_MAX)}… (truncated)`;
};

const STATUS_ICON = { delivered: '↳', partial: '⚠', failed: '✗', queued: '…' };

const COLOR_FAILED = '#B05A5A';
const COLOR_AMENDMENT = '#9E9E9E';

const SENDER_COLORS = [
  '#5B7A99', '#7A9B76', '#9B7B8C', '#B0816A', '#8A8B5C', '#5F8B8B',
  '#8C8377', '#7E6B8F', '#6E86A0', '#A08A6B', '#6B9B8A', '#96778A',
];

const KNOWN_EMOJI = [
  ['fable', '🦊'],
  ['scribe', '📜'],
  ['watchdog', '🐶'],
  ['chief', '🎖️'],
  ['chris', '👤'],
  ['manager', '🧭'],
  ['kimi', '🌙'],
  ['claude', '🎻'],
];
const FALLBACK_EMOJI = ['🤖', '🛰️', '📡', '🧪', '🦉', '🐙', '🌿', '🔧', '📐', '🧵'];

function hashName(name) {
  let h = 0x811c9dc5;
  for (const ch of String(name)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const senderColor = (name) => SENDER_COLORS[hashName(name) % SENDER_COLORS.length];

function senderEmoji(name) {
  const lower = String(name).toLowerCase();
  for (const [needle, emoji] of KNOWN_EMOJI) {
    if (lower.includes(needle)) return emoji;
  }
  return FALLBACK_EMOJI[hashName(lower) % FALLBACK_EMOJI.length];
}

function recipientEmoji(to) {
  const t = String(to).toLowerCase();
  if (t === '#team' || t.startsWith('#')) return '📣';
  if (t.startsWith('room')) return '🏠';
  return senderEmoji(to);
}

/** env: { id, from, to, body, createdAt, delivery?, status? } */
export function formatNew(env) {
  const flags = env.delivery === 'interrupt' ? ' · ⚡interrupt' : '';
  const text = `${senderEmoji(env.from)} *${env.from}* → ${recipientEmoji(env.to)} *${env.to}* · ${timeOf(env.createdAt)}${flags}\n${truncate(env.body)}`;
  return {
    username: env.from,
    icon_emoji: senderEmoji(env.from),
    text,
    attachments: [{ color: senderColor(env.from), fallback: text }],
  };
}

export function formatStatus(env) {
  const icon = STATUS_ICON[env.status] ?? '↳';
  const bad = env.status === 'failed' || env.status === 'partial';
  const attachments = bad
    ? [{ color: COLOR_FAILED, fallback: `${env.id} → ${env.status}` }]
    : [{ color: COLOR_AMENDMENT, fallback: `${env.id} → ${env.status}` }];
  return {
    text: `${icon} \`${env.id}\` → *${env.status}* (${env.from} → ${env.to}, ${timeOf(env.createdAt)})`,
    attachments,
  };
}
