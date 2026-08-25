/** Provider-transcript marker emitted by the authenticated Novakai Agent CLI. */
export interface AgentDeliveryMarker {
  readonly version: 1;
  readonly recipientAgentId: string;
  readonly text: string;
  readonly clientOpId: string;
  readonly threadId?: string;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

/** CLI result whose provider-native tool result becomes delivery evidence. */
export interface AgentDeliveryInstruction {
  readonly kind: 'transcript-addressed-delivery';
  readonly recipientAgentId: string;
  readonly clientOpId: string;
  readonly transcriptMarker: string;
}

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
    && (marker.threadId === undefined
      || typeof marker.threadId === 'string' && /^thread_[A-Za-z0-9-]+$/u.test(marker.threadId))
    && (marker.screenContext === undefined
      || typeof marker.screenContext === 'object'
      && marker.screenContext !== null
      && !Array.isArray(marker.screenContext));
};

/** Encodes one shell-safe marker; its base64url payload survives JSON escaping. */
export function agentDeliveryMarker(marker: AgentDeliveryMarker): string {
  if (!valid(marker)) throw new Error('Invalid Agent delivery marker');
  return `${PREFIX}${Buffer.from(JSON.stringify(marker), 'utf8').toString('base64url')}`;
}

/** Finds and validates the first Novakai delivery marker in provider evidence. */
export function findAgentDeliveryMarker(evidence: string): AgentDeliveryMarker | undefined {
  TOKEN.lastIndex = 0;
  for (const match of evidence.matchAll(TOKEN)) {
    try {
      const decoded = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as unknown;
      if (valid(decoded)) return decoded;
    } catch (cause) {
      if (!(cause instanceof SyntaxError)) throw cause;
      // Malformed provider text is handled as an ordinary non-marker.
    }
  }
  return undefined;
}
