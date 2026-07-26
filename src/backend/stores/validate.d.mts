// Typed surface of the pure validator for TypeScript hosts. The .mjs is the
// single authority; this describes only what a host needs to check its own
// candidate blocks BEFORE handing them to the store.
import type { Snapshot, Violation } from './store.d.mts';

/** Opaque cross-store id index; build it from a snapshot, pass it to validateBlock. */
export type StoreIndex = unknown;

/** Parse raw store texts ({filename: text}) into a Snapshot. Pure. */
export function parseSnapshot(files: Record<string, string>): Snapshot;

/** Build the id/ref resolution index a snapshot implies. Pure. */
export function buildIndex(snapshot: Snapshot): StoreIndex;

/** Every way a block breaks the schema law. Empty means the store will take it. */
export function validateBlock(
  block: Record<string, unknown>,
  context: { storeFile: string; index: StoreIndex },
): Violation[];

/** Validate a raw candidate line against a live snapshot (append path). */
export function validateCandidate(
  rawLine: string,
  context: { storeFile: string; snapshot: Snapshot },
): { violations: Violation[] };

/** Audit a whole snapshot. */
export function auditSnapshot(snapshot: Snapshot): { findings: Violation[] };
