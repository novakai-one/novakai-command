/**
 * clock-system adapter (Messaging-Seams §5.3): the v1 production adapter.
 * 128-bit random IDs via node:crypto; real wall clock.
 *
 * Any failure to mint or read time is halt-class: it throws
 * DependencyUnavailable{dependency: "clock"} (seams/clock.ts).
 */

import { randomBytes } from "node:crypto";
import { idPrefixes } from "../contract/schemas.js";
import type { IdKind, IdTypeMap, Timestamp } from "../contract/schemas.js";
import { clockUnavailable } from "../contract/ports/clock.js";
import type { ClockIds } from "../contract/ports/clock.js";

export function createSystemClock(): ClockIds {
  return {
    now(): Timestamp {
      try {
        return new Date().toISOString() as Timestamp;
      } catch (cause) {
        throw clockUnavailable(cause instanceof Error ? cause.message : String(cause));
      }
    },
    newId<Kind extends IdKind>(kind: Kind): IdTypeMap[Kind] {
      try {
        // 128 bits of randomness, hex-encoded — matches every id pattern's [A-Za-z0-9-]+ body.
        const body = randomBytes(16).toString("hex");
        return `${idPrefixes[kind]}${body}` as IdTypeMap[Kind];
      } catch (cause) {
        throw clockUnavailable(cause instanceof Error ? cause.message : String(cause));
      }
    },
  };
}
