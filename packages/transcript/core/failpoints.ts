export type TranscriptFailpointName =
  | 'transcript.beforeLineAppend';

export interface TranscriptFailpoint {
  hit(point: TranscriptFailpointName): void;
}

export class TranscriptFailpointCrash extends Error {
  constructor(readonly point: TranscriptFailpointName) {
    super(`NVK_FAILPOINT injected crash at ${point}`);
    this.name = 'TranscriptFailpointCrash';
  }
}

export function injectTranscriptFailpoint(
  configured: string | undefined,
): TranscriptFailpoint {
  return {
    hit(point) {
      if (configured === point) throw new TranscriptFailpointCrash(point);
    },
  };
}
