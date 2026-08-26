/** One accepted provider turn. */
export interface ProviderSendInput {
  readonly sendId: string;
  readonly targetAgentId: string;
  readonly text: string;
  readonly resumeId?: string;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

export type ProviderDispatchResult =
  | {
      readonly ok: true;
      readonly dispatchedAt: string;
      readonly certainty: 'confirmed' | 'unconfirmed';
      readonly response: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Provider variability hidden behind the sole Agents contract. */
export interface ProviderSend {
  dispatch(input: ProviderSendInput): Promise<ProviderDispatchResult>;
}
