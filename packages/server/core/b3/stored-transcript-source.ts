import { createHash } from "node:crypto";
import type { MessagingRuntimeApi } from "../../../messaging/contract/index.js";
import type {
  SourceLine,
  SourcePositionDigest,
  SourcePrefixOutcome,
  SourceReadOutcome,
  TranscriptBinding,
  TranscriptSourcePort,
} from "../../../transcript/b3/contract/index.js";

export interface StoredTranscriptSourceOptions {
  readonly messaging: Pick<MessagingRuntimeApi, "listTranscriptLines">;
  readonly resumeIdOf: (binding: TranscriptBinding) => Promise<string | null>;
}

const positionOf = (turnIndex: number, offset: number): string =>
  `${String(turnIndex).padStart(10, "0")}:${String(offset).padStart(20, "0")}`;

const digestOf = (raw: string): string =>
  createHash("sha256").update(raw, "utf8").digest("hex");

/** B3 compatibility reads committed Messaging facts, never provider files. */
export function createStoredTranscriptSource(
  options: StoredTranscriptSourceOptions,
): TranscriptSourcePort {
  const linesFor = async (binding: TranscriptBinding): Promise<readonly SourceLine[] | null> => {
    const resumeId = await options.resumeIdOf(binding);
    if (resumeId === null) return null;
    const listed = await options.messaging.listTranscriptLines({ resumeId });
    if (listed.kind !== "ok") throw new Error(listed.error.message);
    return listed.value.map((line) => ({
      position: positionOf(line.turnIndex, line.sourcePosition.offset),
      role: line.role === "hook" || line.role === "attachment" ? "system" : line.role,
      text: line.text,
      digest: digestOf(line.raw),
    }));
  };
  return {
    async read(binding, fromPosition, maxLines): Promise<SourceReadOutcome> {
      try {
        const stored = await linesFor(binding);
        if (stored === null || stored.length === 0) return { kind: "missing" };
        const eligible = stored.filter((line) =>
          fromPosition === undefined || line.position >= fromPosition);
        return {
          kind: "lines",
          lines: eligible.slice(0, maxLines),
          more: eligible.length > maxLines,
        };
      } catch (cause) {
        return {
          kind: "unavailable",
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
    async readPrefixDigests(binding, throughPosition): Promise<SourcePrefixOutcome> {
      try {
        const stored = await linesFor(binding);
        if (stored === null || stored.length === 0) return { kind: "missing" };
        const digests: SourcePositionDigest[] = stored
          .filter((line) => line.position <= throughPosition)
          .map((line) => ({ position: line.position, digest: line.digest }));
        return { kind: "digests", digests };
      } catch (cause) {
        return {
          kind: "unavailable",
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  };
}
