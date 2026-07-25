/**
 * clock-seeded adapter (Messaging-Seams §5.3): deterministic test adapter.
 *
 * IDs are `<prefix><seed>-<counter>` — e.g. `message_test-000001`. The seam
 * doc's prose example `id_test_000001…` does NOT match the contract-source ID
 * patterns (§5.3 makes pattern conformity a hard obligation; the patterns'
 * body class is [A-Za-z0-9-], no underscore), so the seed replaces the prose's
 * fixed `id` infix and the separator is a hyphen; the counter keeps determinism.
 *
 * `now()` is fixed at construction and movable via advance()/setNow() — a
 * fixed/stepped clock per §5.3.
 */

import { idPrefixes } from "../public/contract/index.js";
import type { IdKind, IdTypeMap, Timestamp } from "../public/contract/index.js";
import { clockUnavailable } from "../seams/clock.js";
import type { ClockIds } from "../seams/clock.js";

export interface SeededClock extends ClockIds {
  /** Move the fixed clock forward. */
  advance(milliseconds: number): void;
  /** Move the fixed clock to an absolute instant (ISO 8601). */
  setNow(isoTimestamp: string): void;
}

export interface SeededClockOptions {
  /** Deterministic ID infix. Must match [A-Za-z0-9-]+ so minted IDs stay pattern-legal. */
  seed: string;
  /** Fixed starting instant (ISO 8601). Defaults to 2026-01-01T00:00:00.000Z. */
  now?: string;
}

const SEED_PATTERN = /^[A-Za-z0-9-]+$/;
const DEFAULT_NOW = "2026-01-01T00:00:00.000Z";

export function createSeededClock(options: SeededClockOptions): SeededClock {
  if (!SEED_PATTERN.test(options.seed)) {
    throw clockUnavailable(`seed ${JSON.stringify(options.seed)} is not [A-Za-z0-9-]+`);
  }
  let counter = 0;
  let nowMs = Date.parse(options.now ?? DEFAULT_NOW);
  if (Number.isNaN(nowMs)) {
    throw clockUnavailable(`unparseable fixed now ${JSON.stringify(options.now)}`);
  }

  return {
    now(): Timestamp {
      return new Date(nowMs).toISOString() as Timestamp;
    },
    newId<Kind extends IdKind>(kind: Kind): IdTypeMap[Kind] {
      counter += 1;
      const body = `${options.seed}-${String(counter).padStart(6, "0")}`;
      return `${idPrefixes[kind]}${body}` as IdTypeMap[Kind];
    },
    advance(milliseconds: number): void {
      nowMs += milliseconds;
    },
    setNow(isoTimestamp: string): void {
      const parsed = Date.parse(isoTimestamp);
      if (Number.isNaN(parsed)) {
        throw clockUnavailable(`unparseable timestamp ${JSON.stringify(isoTimestamp)}`);
      }
      nowMs = parsed;
    },
  };
}
