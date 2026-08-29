import { idPatterns, type TranscriptSourceId } from './types.js';

const transcriptSourceIdPattern = new RegExp(idPatterns.TranscriptSourceId, 'u');

/** The single runtime parser for Transcript Source IDs accepted by the contract. */
export function parseTranscriptSourceId(value: unknown): TranscriptSourceId | undefined {
  return typeof value === 'string' && transcriptSourceIdPattern.test(value)
    ? value as TranscriptSourceId
    : undefined;
}
