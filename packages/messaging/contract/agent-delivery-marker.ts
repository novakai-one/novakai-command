/** Provider-transcript marker emitted by an authenticated Novakai Agent CLI. */
export interface AgentDeliveryMarker {
  readonly version: 1;
  readonly recipientAgentId: string;
  readonly text: string;
  readonly clientOpId: string;
  readonly threadId?: string;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

/** Instruction whose marker becomes provider-native transcript evidence. */
export interface AgentDeliveryInstruction {
  readonly kind: 'transcript-addressed-delivery';
  readonly recipientAgentId: string;
  readonly clientOpId: string;
  readonly transcriptMarker: string;
}
