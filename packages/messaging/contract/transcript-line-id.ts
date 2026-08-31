import { idPatterns, type TranscriptLineId } from './types.js';

const transcriptLineIdPattern = new RegExp(idPatterns.TranscriptLineId, 'u');

/** The single runtime parser for Transcript Line IDs accepted by the contract. */
export function parseTranscriptLineId(value: unknown): TranscriptLineId | undefined {
  return typeof value === 'string' && transcriptLineIdPattern.test(value)
    ? value as TranscriptLineId
    : undefined;
}
