/** Environment channel set by Novakai before a provider CLI turn. */
export const novakaiAgentIdEnvironmentKey = 'NOVAKAI_AGENT_ID' as const;

import type { AgentIdentityMarker } from './records/agent-identity.js';
export type { AgentIdentityMarker } from './records/agent-identity.js';

const AGENT_ID = /^agent_[A-Za-z0-9-]+$/;

/** Validates an untrusted provider value as Novakai assignment evidence. */
export function parseAgentIdentityMarker(value: unknown): AgentIdentityMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const marker = value as Partial<AgentIdentityMarker>;
  return marker.kind === 'novakai-agent-identity'
    && marker.schemaVersion === 1
    && marker.hookEvent === 'UserPromptSubmit'
    && typeof marker.agentId === 'string'
    && AGENT_ID.test(marker.agentId)
    ? marker as AgentIdentityMarker
    : undefined;
}

function markerInsideText(text: string): AgentIdentityMarker | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    const direct = parseAgentIdentityMarker(parsed);
    if (direct !== undefined) return direct;
  } catch {
    // Provider wrappers often surround the JSON marker with hook tags.
  }
  const start = text.indexOf('{', Math.max(0, text.indexOf('novakai-agent-identity') - 100));
  if (start < 0) return undefined;
  for (let end = text.indexOf('}', start); end >= 0; end = text.indexOf('}', end + 1)) {
    try {
      const marker = parseAgentIdentityMarker(JSON.parse(text.slice(start, end + 1)));
      if (marker !== undefined) return marker;
    } catch {
      // Keep extending to the next closing brace.
    }
  }
  return undefined;
}

/** Finds one marker inside any Claude, Codex or Kimi JSON wrapper. */
export function findAgentIdentityMarker(value: unknown): AgentIdentityMarker | undefined {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    const direct = parseAgentIdentityMarker(candidate);
    if (direct !== undefined) return direct;
    if (typeof candidate === 'string') {
      const nested = markerInsideText(candidate);
      if (nested !== undefined) return nested;
      continue;
    }
    if (typeof candidate !== 'object' || candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    if (Array.isArray(candidate)) pending.push(...candidate);
    else pending.push(...Object.values(candidate as Record<string, unknown>));
  }
  return undefined;
}
