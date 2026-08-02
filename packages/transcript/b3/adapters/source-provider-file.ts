/**
 * Reading a real provider transcript file — §24.2, §27.
 *
 * This is the production `TranscriptSourcePort`. It opens the provider's own
 * file READ-ONLY and never writes, moves, truncates or locks it (§27: "provider
 * originals remain untouched"). Everything Novakai keeps about that file lives
 * under `.novakai`.
 *
 * It does not re-implement provider parsing. `normalizeProviderLine` is the
 * B2b normaliser that already handles all three providers, their legacy
 * shapes, and their subagent relationships — running a second parser beside it
 * would be exactly the "second Transcript authority" red gate 25 forbids.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { normalizeProviderLine } from '../../adapters/provider-normalizers.js';
import type { ProviderName } from '../../contract/schemas.js';
import type {
  SourceLine, SourceReadOutcome, TranscriptSourcePort,
} from '../contract/api.js';
import type { TranscriptBinding } from '../contract/records.js';

export interface ProviderFileSourceOptions {
  /**
   * Where a binding's provider file is. A function rather than a map because
   * the answer depends on provider AND session, and a Run bound before its
   * file exists must be able to ask again later.
   */
  readonly locate: (binding: TranscriptBinding) => string | null;
}

/**
 * Line ordinals, zero-padded, so the watermark orders lexically as well as
 * numerically. `"10"` sorting before `"9"` would make a resumed mirror skip
 * everything between them.
 */
const positionOf = (ordinal: number): string => String(ordinal).padStart(10, '0');

const digestOf = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

export function createProviderFileSource(
  options: ProviderFileSourceOptions,
): TranscriptSourcePort {
  return {
    async read(binding, fromPosition, maxLines): Promise<SourceReadOutcome> {
      const filePath = options.locate(binding);
      if (filePath === null || !existsSync(filePath)) return { kind: 'missing' };
      let contents: string;
      try {
        contents = readFileSync(filePath, 'utf8');
      } catch (cause) {
        return {
          kind: 'unavailable',
          reason: cause instanceof Error ? cause.message : String(cause),
        };
      }
      return readWindow(binding.provider as ProviderName, contents, fromPosition, maxLines);
    },
  };
}

/** One row's byte extent, so the normaliser sees the offsets it expects. */
interface Extent {
  readonly position: string;
  readonly text: string;
  readonly startByte: number;
  readonly endByte: number;
}

function extentsOf(contents: string): readonly Extent[] {
  const extents: Extent[] = [];
  let startByte = 0;
  for (const [ordinal, text] of contents.split('\n').entries()) {
    const endByte = startByte + Buffer.byteLength(text) + 1;
    extents.push({ position: positionOf(ordinal), text, startByte, endByte });
    startByte = endByte;
  }
  return extents;
}

function readWindow(
  provider: ProviderName, contents: string,
  fromPosition: string | undefined, maxLines: number,
): SourceReadOutcome {
  const lines: SourceLine[] = [];
  let more = false;
  for (const extent of extentsOf(contents)) {
    if (extent.text.trim() === '') continue;
    // INCLUSIVE of the watermark line — see TranscriptSourcePort.read.
    if (fromPosition !== undefined && extent.position < fromPosition) continue;
    if (lines.length >= maxLines) {
      more = true;
      break;
    }
    lines.push(lineOf(provider, extent));
  }
  return { kind: 'lines', lines, more };
}

/**
 * One source line. A row the normaliser SKIPS is still a position: recording
 * it as system noise keeps the watermark contiguous, where dropping it would
 * leave a hole a later pass would try to re-read forever.
 */
function lineOf(provider: ProviderName, extent: Extent): SourceLine {
  const item = normalizeProviderLine(
    provider, extent.text, extent.startByte, extent.endByte,
  );
  const normalised = item.kind === 'candidate' ? item.line : null;
  return {
    position: extent.position,
    role: normalised?.role ?? 'system',
    text: normalised?.text ?? '',
    digest: digestOf(extent.text),
    ...(normalised?.agentId === undefined
      ? {} : { nativeSubagentId: normalised.agentId }),
    ...(normalised?.parentAgentId === undefined
      ? {} : { parentNativeSubagentId: normalised.parentAgentId }),
  };
}
