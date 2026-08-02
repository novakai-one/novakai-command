/**
 * The mirror pump — what makes §13.9 a PIPELINE rather than a verb.
 *
 * §13.9 describes the mirror as something whose watermark advances per durable
 * outcome, and §13.5 binds a Run's transcript at spawn precisely so that can
 * happen. Neither sentence is true if the only thing that ever calls
 * `ingestTranscriptSource` is a human typing `nvk transcript ingest`: the
 * slice's promise — what you type in a terminal and what you type in Novakai
 * land in ONE conversation — is not delivered by a manual verb.
 *
 * So this drives it. It is deliberately the smallest driver that can be
 * correct:
 *
 *   - it READS custody and calls the capability's own ingest. Every rule about
 *     what a turn becomes stays where it already lives (§8.2, the noise filter,
 *     the ledger, the watermark law);
 *   - a QUARANTINED binding is skipped, never retried. §13.9: "a binding
 *     already holding a quarantine does not resume by itself";
 *   - it writes nothing to a PTY and asks for no provider input, so no turn in
 *     any transcript is one the watcher caused (§24.6);
 *   - it is outside the §13.5 saga. A pass that fails is a pass that runs again
 *     next tick; it can neither fail a spawn nor compensate one.
 */

import type { B3Result } from '@novakai/foundation/contract';

import type {
  IngestTranscriptSourceInput, TranscriptIngestOutcome,
} from '../contract/api.js';
import type { TranscriptBinding, TranscriptBindingId } from '../contract/records.js';

/** What one pass did, so a host can log or assert on it without guessing. */
export interface MirrorPumpPass {
  readonly considered: number;
  readonly ingested: number;
  readonly mirrored: number;
  /** Bindings left alone because they are quarantined (§13.9). */
  readonly skippedQuarantined: number;
  readonly failures: readonly { readonly bindingId: string; readonly code: string }[];
}

/**
 * Everything the pump needs, and nothing else. Both halves belong to Transcript
 * — the pump drives the capability, it does not reach around it.
 */
export interface MirrorPumpPorts {
  listBindings(): Promise<B3Result<readonly TranscriptBinding[]>>;
  ingest(input: IngestTranscriptSourceInput): Promise<B3Result<TranscriptIngestOutcome>>;
}

export interface MirrorPumpOptions {
  readonly ports: MirrorPumpPorts;
  /** How often a live pipeline looks. */
  readonly intervalMs?: number;
  /**
   * A bound on ONE pass, not on a Run. A first ingest of a long session takes
   * several passes and says so through `haltedBy: 'max-lines'`, which is what
   * keeps a thousand-line file from holding the store lock for the whole read.
   */
  readonly maxLinesPerPass?: number;
  readonly onPass?: (pass: MirrorPumpPass) => void;
}

export interface MirrorPump {
  /** One pass over every binding. Safe to call directly; tests drive time. */
  pumpOnce(): Promise<MirrorPumpPass>;
  start(): void;
  /** Stop looking, and wait for the pass in flight to finish its writes. */
  stop(): Promise<void>;
}

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_MAX_LINES = 200;

const EMPTY: MirrorPumpPass = {
  considered: 0, ingested: 0, mirrored: 0, skippedQuarantined: 0, failures: [],
};

export function createMirrorPump(options: MirrorPumpOptions): MirrorPump {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxLines = options.maxLinesPerPass ?? DEFAULT_MAX_LINES;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight: Promise<MirrorPumpPass> | null = null;

  async function runPass(): Promise<MirrorPumpPass> {
    const bindings = await options.ports.listBindings();
    if (!bindings.ok) {
      return { ...EMPTY, failures: [{ bindingId: '', code: bindings.error.code }] };
    }

    let ingested = 0;
    let mirrored = 0;
    let skippedQuarantined = 0;
    const failures: { bindingId: string; code: string }[] = [];

    for (const binding of bindings.value) {
      // §13.9's hard stop. Asking anyway would answer `TranscriptCorrupt` every
      // tick forever — a log full of an error nobody can act on, which is how a
      // quarantine that DOES need a human stops being visible.
      if (binding.sourceDiscoveryState === 'corrupt') {
        skippedQuarantined += 1;
        continue;
      }
      // No `expectedWatermark`. The pump has no opinion about where the mirror
      // is — it appends from wherever custody says it got to, which is exactly
      // what "advances per durable outcome" means. A CAS here would turn every
      // concurrent manual ingest into a conflict the pump could only retry.
      const outcome = await options.ports.ingest({
        bindingId: binding.id as TranscriptBindingId, maxLines,
      });
      if (!outcome.ok) {
        failures.push({ bindingId: binding.id, code: outcome.error.code });
        continue;
      }
      ingested += 1;
      mirrored += outcome.value.mirrored;
    }

    return {
      considered: bindings.value.length, ingested, mirrored, skippedQuarantined, failures,
    };
  }

  async function pumpOnce(): Promise<MirrorPumpPass> {
    // One pass at a time. Two overlapping passes would read the same watermark
    // and race each other's ledger writes for the same position.
    if (inFlight !== null) return inFlight;
    const started = runPass().finally(() => { inFlight = null; });
    inFlight = started;
    const pass = await started;
    options.onPass?.(pass);
    return pass;
  }

  return {
    pumpOnce,

    start() {
      if (timer !== null) return;
      timer = setInterval(() => { void pumpOnce(); }, intervalMs);
      // A mirror must never be the reason a process refuses to exit.
      timer.unref();
    },

    async stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      // The pass in flight owns durable writes; abandoning it mid-ledger is the
      // crash window §13.9 spends its rules on.
      if (inFlight !== null) await inFlight;
    },
  };
}
