/**
 * store-jsonl adapter (Store-Seam §8): the production default.
 *
 * Durability discipline:
 *   - Every mutation is ONE self-describing JSON line (the StoreOp), appended
 *     with write-then-fsync before the in-memory state changes — a crash
 *     between fsync and apply is recovered by replay on open.
 *   - Open performs a full rebuild by replaying every line in order. The
 *     sequence counter is recovered by max-scan of replayed ops (Store-Seam §3
 *     explicitly allows max-scan at open; reissuing a number is a violation).
 *   - A trailing partial line is a torn write from a crash mid-append: the
 *     file is truncated to the last complete line and replay continues.
 *     Corruption anywhere else halts with StoreCorrupt (§6 — operator
 *     intervention, never a silent wrong state).
 *   - Single-writer: one process, one open handle. Durability per mutation is
 *     the sync write+fsync pair; write SERIALIZATION (Store-Seam §1 rule 3)
 *     is enforced by the StoreCore mutation queue, not by this hook — the
 *     hook returns a Promise, and `await` always yields, so without the queue
 *     check-then-act and apply would interleave across in-flight mutations.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ClockIds } from "../contract/ports/clock.js";
import type { MessagingStore } from "../contract/ports/store.js";
import { StoreCore, StoreException, storeOpNames } from "./store-shared.js";
import type { StoreOp } from "./store-shared.js";

export interface JsonlStoreOptions {
  /** Path of the JSONL file. Parent directories are created. */
  path: string;
}

function isStoreOp(value: unknown): value is StoreOp {
  return (
    typeof value === "object" &&
    value !== null &&
    "op" in value &&
    typeof (value as { op: unknown }).op === "string" &&
    (storeOpNames as readonly string[]).includes((value as { op: string }).op)
  );
}

export async function openJsonlStore(
  clock: ClockIds,
  options: JsonlStoreOptions,
): Promise<MessagingStore> {
  mkdirSync(dirname(options.path), { recursive: true });
  const core = new StoreCore(clock);

  // --- full rebuild on open ---------------------------------------------------
  if (existsSync(options.path)) {
    const raw = readFileSync(options.path, "utf8");
    const lines = raw.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined || line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        const isTail = lines
          .slice(index + 1)
          .every((rest) => rest === undefined || rest.trim() === "");
        if (isTail) {
          // Torn tail write: truncate to the end of the last complete line.
          const goodPrefix = lines.slice(0, index).join("\n");
          const truncateTo = Buffer.byteLength(goodPrefix) + (index > 0 ? 1 : 0);
          const fd = openSync(options.path, "r+");
          try {
            ftruncateSync(fd, truncateTo);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          break;
        }
        throw new StoreException({
          name: "StoreCorrupt",
          message: `unparseable journal line ${index + 1} in ${options.path}`,
        });
      }
      if (!isStoreOp(parsed)) {
        throw new StoreException({
          name: "StoreCorrupt",
          message: `journal line ${index + 1} in ${options.path} is not a known store op`,
        });
      }
      core.applyOp(parsed);
    }
  }

  // --- write-then-fsync per mutation ------------------------------------------
  const fd = openSync(options.path, "a");
  core.attachPersistence(
    (op: StoreOp) => {
      writeSync(fd, `${JSON.stringify(op)}\n`);
      fsyncSync(fd);
      return Promise.resolve();
    },
    () => {
      fsyncSync(fd);
      closeSync(fd);
      return Promise.resolve();
    },
  );

  return core;
}
