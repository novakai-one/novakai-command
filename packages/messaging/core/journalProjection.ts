/**
 * Journal entry → v1 committed fact. The ONE place that mapping lives.
 *
 * It was written twice — once in the event bus, once in subscription replay —
 * as a two-branch ternary whose fall-through was PolicyChanged. That shape is
 * only correct while the journal has exactly four kinds, and it fails in the
 * worst possible way when it stops being: a new kind becomes a PolicyChanged
 * event with three `undefined` fields, delivered to real subscribers, with
 * nothing anywhere reporting a problem.
 *
 * B3c adds two journal kinds (§15's endpoint/inbox facts) that have no v1
 * public event at all — they surface through `b3.agent.subscribeEvents`
 * instead. So the mapping now has to be able to say "no public fact", and it
 * has to say it in one place.
 */

import type { CommittedFact } from "./eventBus.js";
import type { JournalEntry } from "../seams/store.js";

/**
 * The v1 public fact for a journal entry, or `null` when the entry has none.
 *
 * `null` is a legitimate, expected outcome — TemplateWritten has had no public
 * event since the store seam was written, and the B3c kinds never will.
 * Callers advance their cursor past a null exactly as they would past a fact.
 */
export function projectJournalEntry(entry: JournalEntry): CommittedFact | null {
  switch (entry.kind) {
    case "MessageCommitted":
      return {
        kind: "MessageCommitted",
        event: { sequence: entry.sequence, message: entry.message },
      };
    case "DeliveryUpdated":
      return {
        kind: "DeliveryUpdated",
        event: { sequence: entry.sequence, delivery: entry.delivery },
      };
    case "PolicyChanged":
      return {
        kind: "PolicyChanged",
        event: {
          sequence: entry.sequence,
          personId: entry.personId,
          policy: entry.policy,
          revision: entry.revision,
        },
      };
    // No v1 public event exists for these. The store seam has always said so
    // for TemplateWritten; §15 routes the two B3c facts through the b3 event
    // stream, which carries typed cursors the v1 stream does not.
    case "TemplateWritten":
    case "AgentEndpointChanged":
    case "AgentInboxChanged":
      return null;
  }
}
