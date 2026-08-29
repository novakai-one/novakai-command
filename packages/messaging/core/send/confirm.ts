import type { SendJournal } from '../../contract/records/send-journal.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { TranscriptLineQuery } from '../../contract/ports/transcript-store.js';
import type { ProviderSessionId, Timestamp } from '../../contract/types.js';

/** The store surface send confirmation needs: journals, lines, and the confirm write. */
export interface ConfirmStore {
  listSendJournals(): Promise<readonly SendJournal[]>;
  listTranscriptLines(query?: TranscriptLineQuery): Promise<readonly TranscriptLine[]>;
  confirmSendForLines(
    sessionId: ProviderSessionId,
    lines: readonly TranscriptLine[],
    updatedAt: Timestamp,
  ): Promise<number>;
}

/**
 * Marks waiting sends as confirmed once their text shows up in the provider
 * transcript, and returns how many were newly confirmed. The transcript is
 * the only trustworthy proof that the provider actually received a message,
 * and this runs after every ingest pass, so sends still confirm after a
 * restart that happened while they were waiting.
 */
export async function confirmPendingSends(
  store: ConfirmStore,
  updatedAt: Timestamp,
): Promise<number> {
  const journals = await store.listSendJournals();
  const sessionIds = [...new Set(journals.flatMap((journal) =>
    journal.state === 'awaiting-transcript' && journal.targetSessionId !== undefined
      ? [journal.targetSessionId] : []))];
  let confirmed = 0;
  for (const sessionId of sessionIds) {
    const lines = await store.listTranscriptLines({ sessionId });
    confirmed += await store.confirmSendForLines(sessionId, lines, updatedAt);
  }
  return confirmed;
}
