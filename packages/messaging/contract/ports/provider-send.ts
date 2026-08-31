/** One accepted provider turn. */
import type { ProviderResumeId, Timestamp } from '../types.js';

export interface ProviderSendInput {
  readonly sendId: string;
  readonly targetAgentId: string;
  readonly text: string;
  readonly resumeId?: ProviderResumeId;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

export type ProviderDispatchResult =
  | {
      readonly ok: true;
      readonly dispatchedAt: Timestamp;
      readonly certainty: 'confirmed' | 'unconfirmed';
      readonly response: string;
    }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Provider variability hidden behind the sole Agents contract. */
export interface ProviderSend {
  dispatch(input: ProviderSendInput): Promise<ProviderDispatchResult>;
}
