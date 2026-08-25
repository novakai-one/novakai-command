import type { TranscriptStore } from '../../contract/ports/transcript-store.js';

/** Reconciles transcript-only confirmation, including restart after line commit. */
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
