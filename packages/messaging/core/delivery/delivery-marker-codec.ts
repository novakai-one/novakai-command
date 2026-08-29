import type { AgentDeliveryMarker } from '../../contract/agent-delivery-marker.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';

const PREFIX = 'NOVAKAI_DELIVERY_V1:';
const TOKEN = /NOVAKAI_DELIVERY_V1:([A-Za-z0-9_-]+)/gu;
const AGENT_ID = /^agent_[A-Za-z0-9-]+$/u;

const valid = (value: unknown): value is AgentDeliveryMarker => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.version === 1
    && typeof marker.recipientAgentId === 'string'
    && AGENT_ID.test(marker.recipientAgentId)
    && typeof marker.text === 'string'
    && marker.text.trim().length > 0
    && Buffer.byteLength(marker.text, 'utf8') <= 32_768
    && typeof marker.clientOpId === 'string'
    && marker.clientOpId.length > 0
    && marker.clientOpId.length <= 128
    && (marker.screenContext === undefined
      || typeof marker.screenContext === 'object'
      && marker.screenContext !== null
      && !Array.isArray(marker.screenContext));
};

/**
 * Serializes one delivery instruction into a single-line marker token that
 * can ride inside provider transcript text. Agents hand messages to each
 * other through the transcript itself, so the instruction must survive as
 * plain text that any provider will echo back verbatim.
 */
export function agentDeliveryMarker(marker: AgentDeliveryMarker): string {
  if (!valid(marker)) throw new Error('Invalid Agent delivery marker');
  return `${PREFIX}${Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url')}`;
}

/** Decodes and fully validates one candidate token; look-alikes decode to undefined. */
const decodeMarkerCandidate = (token: string): AgentDeliveryMarker | undefined => {
  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as unknown;
    return valid(decoded) ? decoded : undefined;
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return undefined;
  }
};

/**
 * Extracts the first valid delivery marker from transcript text, or undefined
 * when there is none. Provider output is untrusted — it may be partial,
 * mangled, or contain look-alikes — so every candidate token is decoded and
 * fully validated before it counts.
 */
export function findAgentDeliveryMarker(evidence: string): AgentDeliveryMarker | undefined {
  TOKEN.lastIndex = 0;
  for (const match of evidence.matchAll(TOKEN)) {
    const marker = decodeMarkerCandidate(match[1] ?? '');
    if (marker !== undefined) return marker;
  }
  return undefined;
}

/**
 * Finds the delivery marker on one transcript line, searching its normalized
 * text and its verbatim raw form together — the marker may survive in either
 * representation depending on how the provider echoed the turn.
 */
export function findAgentDeliveryMarkerInLine(
  line: Pick<TranscriptLine, 'text' | 'raw'>,
): AgentDeliveryMarker | undefined {
  return findAgentDeliveryMarker(`${line.text}\n${line.raw}`);
}
