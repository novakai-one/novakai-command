/**
 * store-memory adapter (Store-Seam §8, A4): test/harness only.
 *
 * Full §2–§7 contract, trivially atomic in-process. NO durability claims —
 * capability-wide durability guarantees are scoped to durable adapters.
 */

import type { ClockIds } from "../contract/ports/clock.js";
import type { MessagingStore } from "../contract/ports/store.js";
import { StoreCore } from "./store-shared.js";

export function createMemoryStore(clock: ClockIds): MessagingStore {
  return new StoreCore(clock);
}
