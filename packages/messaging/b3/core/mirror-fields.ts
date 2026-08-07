/**
 * Where a mirrored Message remembers its origin — §8.2's loopback rule.
 *
 * "Terminal-originated Message creation stores the source endpoint effect
 * ATOMICALLY so it cannot loop back into the same endpoint." Atomically is the
 * operative word: if the origin lived in a side table, or worse in process
 * memory, a crash between the Message commit and the origin write would leave
 * a Message with no origin — and the next delivery pass would type an Agent's
 * own reply back into its own terminal, which would be mirrored, which would
 * be delivered, forever.
 *
 * So the origin rides INSIDE the Message, in `body.fields`, which is already
 * part of the acceptance transaction. No new record, no new kind, no window.
 */

/** The TranscriptBindingId the Message was mirrored from. */
export const ORIGIN_BINDING_FIELD = "novakai.originBindingId";
/** The AgentEndpointClaimId the turn came from — the endpoint it must NOT return to. */
export const ORIGIN_ENDPOINT_FIELD = "novakai.originEndpointClaimId";
/** The transcript line, so a replay of the same line is recognisably the same Message. */
export const ORIGIN_LINE_FIELD = "novakai.originTranscriptLineId";
