/** Environment channel set by Novakai before a provider CLI turn. */
export const novakaiAgentIdEnvironmentKey = 'NOVAKAI_AGENT_ID' as const;
export const novakaiStoreIdEnvironmentKey = 'NOVAKAI_STORE_ID' as const;

import type { AgentIdentityMarker } from './records/agent-identity.js';
export type { AgentIdentityMarker } from './records/agent-identity.js';

// INLINE_HOOK in adapters/provider-hooks/agent-identity-hook.ts re-states
// these two patterns as literals — the hook command must be self-contained,
// so a change here is only complete when the inline copy changes with it.
const AGENT_ID = /^agent_[A-Za-z0-9-]+$/;
const STORE_ID = /^store_[0-9a-f-]{36}$/u;

/**
 * The checked parse this module exists to own: its casts are the single
 * boundary where untrusted provider output becomes a branded marker.
 * `MarkerCandidate` types every field as unknown because nothing about an
 * untrusted value is guaranteed — not even the fields the union lacks.
 */
interface MarkerCandidate {
  readonly kind?: unknown;
  readonly schemaVersion?: unknown;
  readonly hookEvent?: unknown;
  readonly agentId?: unknown;
  readonly storeId?: unknown;
}

function hasMarkerShape(marker: MarkerCandidate): boolean {
  return marker.kind === 'novakai-agent-identity'
    && marker.hookEvent === 'UserPromptSubmit'
    && typeof marker.agentId === 'string'
    && AGENT_ID.test(marker.agentId);
}

function hasValidStoreId(marker: MarkerCandidate): boolean {
  return typeof marker.storeId === 'string' && STORE_ID.test(marker.storeId);
}

function versionedMarker(marker: MarkerCandidate): AgentIdentityMarker | undefined {
  if (marker.schemaVersion === 1) return marker as AgentIdentityMarker;
  if (marker.schemaVersion === 2 && hasValidStoreId(marker)) return marker as AgentIdentityMarker;
  return undefined;
}

/** Validates an untrusted provider value as Novakai assignment evidence. */
export function parseAgentIdentityMarker(value: unknown): AgentIdentityMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const marker = value as MarkerCandidate;
  if (!hasMarkerShape(marker)) return undefined;
  return versionedMarker(marker);
}

/** Parses a whole string as JSON; anything else is not a marker. */
function parseMarkerText(text: string): AgentIdentityMarker | undefined {
  try {
    return parseAgentIdentityMarker(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** Each `{ ... }` slice, widest first, from `start` — lazily, so parsing stops at the first hit. */
function* braceCandidates(text: string, start: number): Generator<string> {
  for (let close = text.indexOf('}', start); close >= 0; close = text.indexOf('}', close + 1)) {
    yield text.slice(start, close + 1);
  }
}

function firstMarker(candidates: Iterable<string>): AgentIdentityMarker | undefined {
  for (const candidate of candidates) {
    const marker = parseMarkerText(candidate);
    if (marker !== undefined) return marker;
  }
  return undefined;
}

/**
 * Provider wrappers often surround the JSON marker with hook tags, so the
 * whole string rarely parses. Walk closing braces from the first `{` near
 * the marker's kind string until one candidate parses.
 */
function scanBracesForMarker(text: string): AgentIdentityMarker | undefined {
  const start = text.indexOf('{', Math.max(0, text.indexOf('novakai-agent-identity') - 100));
  if (start < 0) return undefined;
  return firstMarker(braceCandidates(text, start));
}

function markerInsideText(text: string): AgentIdentityMarker | undefined {
  const direct = parseMarkerText(text);
  if (direct !== undefined) return direct;
  return scanBracesForMarker(text);
}

function markerInCandidate(candidate: unknown): AgentIdentityMarker | undefined {
  const direct = parseAgentIdentityMarker(candidate);
  if (direct !== undefined) return direct;
  if (typeof candidate !== 'string') return undefined;
  return markerInsideText(candidate);
}

/** Cycle guard for the traversal; also rejects anything without children. */
function isUnseenObject(candidate: unknown, seen: Set<object>): candidate is object {
  if (typeof candidate !== 'object' || candidate === null) return false;
  if (seen.has(candidate)) return false;
  seen.add(candidate);
  return true;
}

/** The cast is owned here: an object's children, array or record, are unknown by construction. */
function childrenOf(candidate: object): readonly unknown[] {
  if (Array.isArray(candidate)) return candidate;
  return Object.values(candidate as Record<string, unknown>);
}

function unseenChildren(candidate: unknown, seen: Set<object>): readonly unknown[] {
  if (!isUnseenObject(candidate, seen)) return [];
  return childrenOf(candidate);
}

/** Finds one marker inside any Claude, Codex or Kimi JSON wrapper. */
export function findAgentIdentityMarker(value: unknown): AgentIdentityMarker | undefined {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const candidate = pending.shift();
    const marker = markerInCandidate(candidate);
    if (marker !== undefined) return marker;
    pending.push(...unseenChildren(candidate, seen));
  }
  return undefined;
}
