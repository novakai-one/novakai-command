import type { TranscriptStore } from '../../contract/ports/transcript-store.js';

/**
 * Marks waiting sends as confirmed once their text shows up in the provider
 * transcript, and returns how many were newly confirmed. The transcript is
 * the only trustworthy proof that the provider actually received a message,
 * and this runs after every ingest pass, so sends still confirm after a
 * restart that happened while they were waiting.
 */
export async function confirmPendingSends(
  store: TranscriptStore,
  updatedAt: string,
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
