// Store engine — single-line JSON records, torn-line truncate-on-open + trace,
// per-object CAS version counter, lazy schema upgrade on read (DEC-F10),
// dual-read shim to the legacy root (R3-21). One global mutation lock guards
// the object-append + trace-append pair (R3-2); fsync after each append (§0).
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync,
  readSync, readdirSync, renameSync, copyFileSync, fsyncSync, statSync,
  truncateSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ClientOpId, ObjectId, ObjectKind, ServerOpId } from '../../contract/brands.js';
import { mintServerOpId } from '../../contract/brands.js';
import { Envelope, QuarantineRequestProvenance, QuarantineTombstone, Ref, TraceLine } from '../../contract/schemas.js';
import type { Envelope as EnvelopeT, RecordLine as RecordLineT, QuarantineTombstone as TombstoneT, TraceLine as TraceLineT } from '../../contract/schemas.js';
import { err, type StoreError } from '../../contract/errors.js';
import { acquireLock, acquireLockAsync, releaseLock, LockTimeout } from './lock.js';

export const CURRENT_SCHEMA_VERSION = 1;

/** Per-kind compatibility ceiling; most Foundation records remain schema v1. */
export function supportedSchemaVersion(kind: string): number {
  return kind === 'notification' ? 2 : CURRENT_SCHEMA_VERSION;
}

// Kind → store file (S1 kinds only; registry is extensible). 'token' lives as
// one file per token under tokens/ and is handled by core/token, not here.
export const KIND_FILES: Readonly<Record<Exclude<ObjectKind, 'token'>, string>> = Object.freeze({
  agent: 'agents.jsonl',
  skill: 'skills.jsonl', // S2a: provider-neutral skills registry (S2-pass1 §C)
  layout: 'layout.jsonl',
  settings: 'settings.jsonl',
  conversationView: 'conversationViews.jsonl', // S2 F1/DEC-S2-11 (shell-owned)
  config: 'config.jsonl',                      // B1 DEC-B1-3 (server-owned)
  providerSession: 'providerSessions.jsonl',   // B1 DEC-B1-6 (agents-owned)
  project: 'projects.jsonl',                   // B2a DEC-B2-1 (projects-owned)
  projectItem: 'projectItems.jsonl',           // B2a DEC-B2-1 (projects-owned)
  artifact: 'artifacts.jsonl',                 // B2a DEC-B2-2 (artifacts-owned metadata)
  spineStep: 'spineSteps.jsonl',               // B2a DEC-B2-3 (spine-owned journal)
  transcriptLine: 'transcriptLines.jsonl',     // B2b DEC-B2-4: transcript authority
  transcriptJournal: 'transcriptJournal.jsonl',
  transcriptCheckpoint: 'transcriptCheckpoints.jsonl',
  transcriptIngestBatch: 'transcriptIngestBatches.jsonl', // 2026-08-09: one durable receipt per ingest batch commit
  runtimeEpoch: 'runtimeEpochs.jsonl',                 // B3a DEC-B3V4-27
  commandReceipt: 'commandReceipts.jsonl',             // B3a DEC-B3V4-30
  terminalSession: 'terminalSessions.jsonl',           // B3a DEC-B3V4-01
  controllerAttachment: 'controllerAttachments.jsonl', // B3a DEC-B3V4-08
  terminalInputLease: 'terminalInputLeases.jsonl',     // B3a DEC-B3V4-29
  terminalInputAttempt: 'terminalInputAttempts.jsonl', // B3a DEC-B3V4-29
  notificationInputReservation: 'notificationInputReservations.jsonl', // B3d Q7
  terminalTab: 'terminalTabs.jsonl',                   // B3e P2 §10 (shell-owned)
  agentRoleProfile: 'agentRoleProfiles.jsonl',           // B3b DEC-B3V4-03
  resolvedLaunchPlan: 'resolvedLaunchPlans.jsonl',       // B3b DEC-B3V4-03/31
  agentRelationship: 'agentRelationships.jsonl',         // B3b DEC-B3V4-06
  delegationGrant: 'delegationGrants.jsonl',             // B3b DEC-B3V4-12
  controlReplacementPlan: 'controlReplacementPlans.jsonl', // B3b DEC-B3V4-31
  agentRun: 'agentRuns.jsonl',                           // B3b DEC-B3V4-02
  runContinuation: 'runContinuations.jsonl',             // B3b DEC-B3V4-19
  supervisionAssignment: 'supervisionAssignments.jsonl', // B3b DEC-B3V4-07
  treeMutationFence: 'treeMutationFences.jsonl',         // B3b DEC-B3V4-11
  runOperation: 'runOperations.jsonl',                   // B3b DEC-B3V4-26
  runOccurrenceEvent: 'runOccurrenceEvents.jsonl',       // B3V4-AMD-003 §3
  messagingStoreOp: 'messagingStoreOps.jsonl',           // B3c DEC-B3V4-33
  transcriptBinding: 'transcriptBindings.jsonl',         // B3c DEC-B3V4-24
  observedSubagent: 'observedSubagents.jsonl',           // B3c DEC-B3V4-18
  storeRouteCutover: 'storeRouteCutovers.jsonl',         // B3c DEC-B3V4-25
  providerUsageEvidence: 'providerUsageEvidence.jsonl',  // B3d §5.5/§18.1
  providerTurnSubmission: 'providerTurnSubmissions.jsonl', // B3V4-AMD-002 §2
  transcriptTurnCompletion: 'transcriptTurnCompletions.jsonl', // B3V4-AMD-002 §2
  watchRule: 'watchRules.jsonl',                         // B3d §9.2/§18.1
  watchDeadline: 'watchDeadlines.jsonl',                 // B3d §9.2/§18.1
  notification: 'notifications.jsonl',                   // B3d §9.2/§18.1
  watchEvaluation: 'watchEvaluations.jsonl',             // B3V4-AMD-003 §6
  notificationDeliveryFenceOperation:
    'notificationDeliveryFenceOperations.jsonl',         // B3V4-AMD-003 §7
  quarantine: 'quarantine.jsonl',
  trace: 'traces.jsonl',
});

// Kinds the engine treats as ordinary wrapped-record stores. `trace` is
// deliberately absent: it keeps its engine-private journal line (AMD-001 A-01).
export const RECORD_KINDS: readonly string[] = [
  'agent', 'skill', 'layout', 'settings', 'conversationView', 'config',
  'providerSession', 'project', 'projectItem', 'quarantine',
  'artifact', 'spineStep', 'transcriptLine', 'transcriptJournal',
  'transcriptCheckpoint', 'transcriptIngestBatch',
  'runtimeEpoch', 'commandReceipt', 'terminalSession',
  'controllerAttachment', 'terminalInputLease', 'terminalInputAttempt',
  'notificationInputReservation', 'terminalTab',
  'agentRoleProfile', 'resolvedLaunchPlan', 'agentRelationship',
  'delegationGrant', 'controlReplacementPlan',
  'agentRun', 'runContinuation', 'supervisionAssignment',
  'treeMutationFence', 'runOperation', 'runOccurrenceEvent',
  'messagingStoreOp', 'transcriptBinding', 'observedSubagent', 'storeRouteCutover',
  'providerUsageEvidence',
  'providerTurnSubmission', 'transcriptTurnCompletion',
  'watchRule', 'watchDeadline', 'notification', 'watchEvaluation',
  'notificationDeliveryFenceOperation',
];

// 2026-08-09: kinds whose payloads dominate store size (full transcript text).
// Their index entries keep envelope + meta only; the payload is re-read from
// its recorded byte range on access. Without this, resident memory tracks the
// store file size (a 1.5 GB transcriptLines store held ~3 GB RSS).
const HEAVY_PAYLOAD_KINDS: ReadonlySet<string> = new Set(['transcriptLine']);

// Lazy upgrade registry (DEC-F10): pure v_n → v_n+1 transforms per kind,
// applied in memory on read; the stored line is NEVER rewritten.
// v0 = legacy flat record (no {envelope,payload,meta} wrapper — dual-read shim).
export type UpgradeFn = (record: unknown) => unknown;
const UPGRADES: Record<string, UpgradeFn[]> = {}; // kind → [v1→v2, ...]

export interface EngineOptions {
  root: string;                  // .novakai/
  dataRoot?: string;             // JSONL directory; lock remains under root
  legacyRoot?: string;           // .novakai-command/ (dual-read fallback, R3-21)
  lockTimeoutMs?: number;        // default 5000 (§0)
  /** @internal test seam: fail the next trace append once. */
  failNextTraceAppend?: { cause: string };
  /** @internal test seam: fail the next object append once. */
  failNextObjectAppend?: { cause: string };
}

export interface ReadRecord {
  envelope: EnvelopeT;
  payload: Record<string, unknown>;
  version: number;
  opId: string;
  clientOpId: string;
  unsupportedVersion: boolean;
}

export interface MutationResult {
  object: Record<string, unknown> & EnvelopeT;
  version: number;
  opId: ServerOpId;
  incomplete: boolean;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
  ino: number;
}

interface IndexedFile {
  filePath: string;
  stamp: FileStamp | null;
  indexedSize: number;
  prefixFingerprint: string | null;
}

interface RecordIndex extends IndexedFile {
  latest: Map<string, ReadRecord>;
  byClientOpId: Map<string, ReadRecord>;
  tombstones?: TombstoneIndex;
}

interface RecordVersionIndex extends IndexedFile {
  latestVersion: Map<string, number>;
}

interface TombstoneIndex {
  latest: Map<string, TombstoneT>;
  openRefCounts: Map<string, number>;
  openRefs: Set<string>;
}

interface TraceIndex extends IndexedFile {
  traces: TraceLineT[];
  byClientOpId: Map<string, TraceLineT>;
  /** B3a §4.3: the mutation trace LINE, so a reader can report a real TraceId. */
  byOpId: Map<string, TraceLineT>;
  opIds: Set<string>;
  nextSeq: number;
}

export type EngineResult<T> = { ok: true; value: T } | { ok: false; error: StoreError };

const nowIso = () => new Date().toISOString();

export class StoreEngine {
  readonly root: string;
  readonly dataRoot: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs: number;
  private booted = false;
  /** @internal typed LockBusy recorded when boot could not take the lock. */
  private bootLockError: StoreError | null = null;
  /** @internal test seam: fail the next trace append once. */
  failNextTraceAppend?: { cause: string };
  /** @internal test seam: fail the next object append once. */
  failNextObjectAppend?: { cause: string };
  private readonly recordIndexes = new Map<string, RecordIndex>();
  private readonly recordVersionIndexes = new Map<string, RecordVersionIndex>();
  private traceIndex?: TraceIndex;

  constructor(options: EngineOptions) {
    this.root = options.root;
    this.dataRoot = options.dataRoot ?? options.root;
    this.legacyRoot = options.legacyRoot;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    if (options.failNextTraceAppend) this.failNextTraceAppend = options.failNextTraceAppend;
    if (options.failNextObjectAppend) this.failNextObjectAppend = options.failNextObjectAppend;
  }

  // ── file helpers ──────────────────────────────────────────────────────
  private storePath(kind: string, root = this.dataRoot): string {
    return path.join(root, KIND_FILES[kind as Exclude<ObjectKind, 'token'>]);
  }

  private appendLineFsync(filePath: string, line: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = openSync(filePath, 'a');
    try {
      appendFileSync(fd, line + '\n');
      fsyncSync(fd); // fsync boundary (§0): before the op returns / lock releases
    } finally {
      closeSync(fd);
    }
    this.bustStampCache(); // own write: freshness memos are now stale
  }

  /** N lines, ONE fsync — the group-commit boundary for batch mutations. */
  private appendLinesFsync(filePath: string, lines: string[]): void {
    if (lines.length === 0) return;
    mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = openSync(filePath, 'a');
    try {
      appendFileSync(fd, lines.join('\n') + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.bustStampCache(); // own write: freshness memos are now stale
  }

  /** Torn final line → truncate-on-open (R3-3). Returns the truncation (if any). */
  /** 2026-08-09: tail-window scan + truncateSync — a multi-GB store must not be
   * fully read (or fully rewritten) just to trim a torn final line. */
  private truncateTornLine(filePath: string): { truncatedBytes: number } | null {
    if (!existsSync(filePath)) return null;
    const size = statSync(filePath).size;
    if (size === 0) return null;
    if (this.readBytes(filePath, size - 1, 1)[0] === 0x0a) return null;
    const WINDOW = 4 * 1024 * 1024;
    let lastNewline = -1;
    let searchEnd = size;
    while (searchEnd > 0) {
      const start = Math.max(0, searchEnd - WINDOW);
      const window = this.readBytes(filePath, start, searchEnd - start);
      const found = window.lastIndexOf(0x0a);
      if (found >= 0) { lastNewline = start + found; break; }
      searchEnd = start;
    }
    const truncatedBytes = size - (lastNewline + 1);
    truncateSync(filePath, lastNewline + 1);
    const fd = openSync(filePath, 'r');
    try {
      fsyncSync(fd); // M2: the truncate is durable before boot proceeds
    } finally {
      closeSync(fd);
    }
    return { truncatedBytes };
  }

  /** Raw non-empty lines of a store file (post-truncation). */
  private readRawLines(kind: string): string[] {
    const filePath = this.storePath(kind);
    if (!existsSync(filePath)) return [];
    const text = readFileSync(filePath, 'utf8');
    return text.split('\n').filter((candidate) => candidate.length > 0);
  }

  /** 2026-08-09: 50 ms stamp memo. Freshness checks (readTraces,
   * readLatestFrom) stat their file on EVERY call; per-record provenance
   * lookups multiplied that into ~1M syscalls per large-store scan. The memo
   * is busted whenever this engine acquires the mutation lock and after every
   * append it performs, so in-lock CAS reads always re-stat — only lock-free
   * reads can be up to 50 ms stale, which concurrent-writer reads always were. */
  private readonly stampCache = new Map<string, { at: number; stamp: FileStamp | null }>();

  /** @internal drop memoized freshness stamps (lock acquired / file written). */
  private bustStampCache(): void {
    this.stampCache.clear();
  }

  private fileStamp(filePath: string): FileStamp | null {
    const cached = this.stampCache.get(filePath);
    const now = Date.now();
    if (cached && now - cached.at <= 50) return cached.stamp;
    const stamp = ((): FileStamp | null => {
      if (!existsSync(filePath)) return null;
      const stat = statSync(filePath);
      return {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ino: Number(stat.ino),
      };
    })();
    this.stampCache.set(filePath, { at: now, stamp });
    return stamp;
  }

  private readBytes(filePath: string, from: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0);
    const buffer = Buffer.allocUnsafe(length);
    const fd = openSync(filePath, 'r');
    try {
      let read = 0;
      while (read < length) {
        const count = readSync(fd, buffer, read, length - read, from + read);
        if (count === 0) break;
        read += count;
      }
      return read === length ? buffer : buffer.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }

  /** 2026-08-09: chunked scan. The old implementation stringified the whole
   * unindexed span at once — a >512 MB store file hit Node's max string length
   * and threw, making the store unreadable. Bounded 64 MB windows instead;
   * each complete line is delivered with its absolute byte offset + length so
   * heavy kinds can re-read payloads lazily. Returns the new indexedSize. */
  private forEachCompleteLine(
    filePath: string,
    from: number,
    size: number,
    onLine: (line: string, offset: number, byteLength: number) => void,
  ): number {
    const CHUNK = 64 * 1024 * 1024;
    let carry: Buffer = Buffer.alloc(0);
    let carryStart = from;
    let pos = from;
    while (pos < size) {
      const length = Math.min(CHUNK, size - pos);
      const chunk = this.readBytes(filePath, pos, length);
      pos += length;
      const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const bufferStart = carryStart;
      let lineStart = 0;
      for (;;) {
        const newline = buffer.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        if (newline > lineStart) {
          onLine(
            buffer.subarray(lineStart, newline).toString('utf8'),
            bufferStart + lineStart,
            newline - lineStart,
          );
        }
        lineStart = newline + 1;
      }
      carry = buffer.subarray(lineStart);
      carryStart = bufferStart + lineStart;
    }
    return carryStart;
  }

  /**
   * A bounded fingerprint of the indexed prefix's boundaries. The first
   * window catches replaced files; the final window catches truncate/rewrite
   * recovery that preserves the inode and then grows the file again.
   */
  private indexedPrefixFingerprint(
    filePath: string,
    indexedSize: number,
  ): string {
    const windowSize = 4096;
    const hash = createHash('sha256').update(String(indexedSize));
    if (indexedSize <= windowSize * 2) {
      hash.update(this.readBytes(filePath, 0, indexedSize));
    } else {
      hash.update(this.readBytes(filePath, 0, windowSize));
      hash.update(this.readBytes(
        filePath,
        indexedSize - windowSize,
        windowSize,
      ));
    }
    return hash.digest('hex');
  }

  private canExtendIndex(
    filePath: string,
    stamp: FileStamp | null,
    index: IndexedFile | undefined,
  ): boolean {
    if (
      !index
      || !stamp
      || !index.stamp
      || index.filePath !== filePath
      || index.stamp.ino !== stamp.ino
      || stamp.size < index.stamp.size
    ) {
      return false;
    }
    if (stamp.size === index.stamp.size) {
      return stamp.mtimeMs === index.stamp.mtimeMs;
    }
    return (
      index.prefixFingerprint !== null
      && this.indexedPrefixFingerprint(filePath, index.indexedSize)
        === index.prefixFingerprint
    );
  }

  // ── record parsing + lazy upgrade (DEC-F10) ──────────────────────────

  /** Replace an indexed record's payload with a lazy re-read of its byte
   * range (heavy kinds only). Ranges stay valid because stores are append-only
   * and torn-line truncation only removes bytes past every indexed line. */
  private detachPayload(
    rec: ReadRecord,
    filePath: string,
    offset: number,
    byteLength: number,
  ): void {
    const engine = this;
    Object.defineProperty(rec, 'payload', {
      configurable: true,
      enumerable: true,
      get(): Record<string, unknown> {
        const raw = engine.readBytes(filePath, offset, byteLength).toString('utf8');
        const parsed = engine.parseRecordLine(raw);
        return parsed ? parsed.payload : {};
      },
    });
  }

  /** Extract identity metadata from a wrapped line without parsing its often
   * multi-megabyte payload. Legacy flat records fall back to the full parser. */
  private parseRecordIdentity(
    line: string,
  ): { id: string; version: number } | null {
    const envelopeJson = this.objectValueForKey(line, 'envelope');
    if (envelopeJson && line.includes('"payload"')) {
      try {
        const envelope = Envelope.safeParse(JSON.parse(envelopeJson));
        if (!envelope.success) return null;
        const metaJson = this.objectValueForKey(line, 'meta', true);
        const meta = metaJson
          ? JSON.parse(metaJson) as { version?: unknown }
          : {};
        return {
          id: envelope.data.id,
          version: typeof meta.version === 'number' ? meta.version : 1,
        };
      } catch {
        return null;
      }
    }
    const record = this.parseRecordLine(line);
    return record
      ? { id: record.envelope.id, version: record.version }
      : null;
  }

  /** Return one JSON object value without materializing sibling values. */
  private objectValueForKey(
    line: string,
    key: string,
    fromEnd = false,
  ): string | null {
    const marker = `"${key}"`;
    const keyAt = fromEnd ? line.lastIndexOf(marker) : line.indexOf(marker);
    if (keyAt < 0) return null;
    const colonAt = line.indexOf(':', keyAt + marker.length);
    if (colonAt < 0) return null;
    let start = colonAt + 1;
    while (/\s/u.test(line[start] ?? '')) start += 1;
    if (line[start] !== '{') return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < line.length; index += 1) {
      const char = line[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        return line.slice(start, index + 1);
      }
    }
    return null;
  }

  /** Parse one line into a normalized record. v0 flat records upgrade in memory. */
  private parseRecordLine(line: string): ReadRecord | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null; // corrupt mid-file line — skipped (traced at boot)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    if ('envelope' in obj && 'payload' in obj && obj.envelope && typeof obj.envelope === 'object') {
      // current wrapped format (§11 ruling 2)
      const envelope = obj.envelope as EnvelopeT;
      const meta = (obj.meta ?? {}) as { opId?: string; clientOpId?: string; version?: number };
      const version = typeof meta.version === 'number' ? meta.version : 1;
      const envCheck = Envelope.safeParse(envelope);
      if (!envCheck.success) return null;
      let upgradedPayload = obj.payload as Record<string, unknown>;
      let upgradedEnvelope = envCheck.data;
      let unsupported = false;
      if (envelope.schemaVersion > supportedSchemaVersion(envelope.kind)) {
        unsupported = true; // §8 rule 3: surface the record flagged, never crash
      } else {
        const applied = this.applyUpgrades(
          envelope.kind,
          envelope.schemaVersion,
          { ...upgradedPayload, ...upgradedEnvelope },
        );
        if (applied) {
          upgradedEnvelope = applied.envelope;
          upgradedPayload = applied.payload;
        }
      }
      return {
        envelope: upgradedEnvelope, payload: upgradedPayload, version,
        opId: meta.opId ?? '', clientOpId: meta.clientOpId ?? '', unsupportedVersion: unsupported,
      };
    }

    // v0 legacy flat record (dual-read shim): envelope fields live on the object.
    const envCheck = Envelope.safeParse(obj);
    if (!envCheck.success) return null;
    const envelope = envCheck.data;
    const payload: Record<string, unknown> = { ...obj };
    for (const f of ['kind', 'id', 'schemaVersion', 'createdAt', 'permissionLevel', 'createdBy', 'sourceAttribution']) {
      delete payload[f];
    }
    return {
      envelope, payload, version: 1, opId: '', clientOpId: '', unsupportedVersion: false,
    };
  }

  private applyUpgrades(kind: string, fromVersion: number, flat: Record<string, unknown>):
    { envelope: EnvelopeT; payload: Record<string, unknown> } | null {
    let current = { ...flat };
    let v = fromVersion;
    const chain = UPGRADES[kind] ?? [];
    const targetVersion = supportedSchemaVersion(kind);
    while (v < targetVersion) {
      const step = chain[v - 1];
      if (!step) return null; // no upgrade path registered — surface as parsed
      current = step(current) as Record<string, unknown>;
      v += 1;
    }
    const envelope = Envelope.parse({
      kind: current.kind, id: current.id, schemaVersion: v,
      createdAt: current.createdAt, permissionLevel: current.permissionLevel,
      createdBy: current.createdBy, ...(current.sourceAttribution ? { sourceAttribution: current.sourceAttribution } : {}),
    });
    const payload = { ...current };
    for (const f of ['kind', 'id', 'schemaVersion', 'createdAt', 'permissionLevel', 'createdBy', 'sourceAttribution']) {
      delete payload[f];
    }
    return { envelope, payload };
  }

  /** Register a pure upgrade fn chain for a kind (DEC-F10). */
  static registerUpgrades(kind: string, chain: UpgradeFn[]): void {
    UPGRADES[kind] = chain;
  }

  /** Latest record per id, applying lazy upgrades. Optionally from legacy root. */
  readLatest(kind: string): Map<string, ReadRecord> {
    const latest = new Map<string, ReadRecord>();
    for (const line of this.readRawLines(kind)) {
      const rec = this.parseRecordLine(line);
      if (rec) latest.set(rec.envelope.id, rec);
    }
    return latest;
  }

  /** All parse failures in a store (mid-file corrupt lines). */
  corruptLines(kind: string): number[] {
    const bad: number[] = [];
    this.readRawLines(kind).forEach((line, i) => {
      if (this.parseRecordLine(line) === null) bad.push(i + 1);
    });
    return bad;
  }

  // ── traces ────────────────────────────────────────────────────────────
  readTraces(): TraceLineT[] {
    const filePath = this.storePath('trace');
    const stamp = this.fileStamp(filePath);
    let index = this.traceIndex;
    const canExtend = this.canExtendIndex(filePath, stamp, index);
    const unchanged = (
      canExtend
      && stamp!.size === index!.stamp!.size
      && stamp!.mtimeMs === index!.stamp!.mtimeMs
    );
    if (unchanged) return index!.traces;
    if (!canExtend) {
      index = {
        filePath,
        stamp: null,
        indexedSize: 0,
        prefixFingerprint: null,
        traces: [],
        byClientOpId: new Map(),
        byOpId: new Map(),
        opIds: new Set(),
        nextSeq: 0,
      };
    }
    if (!stamp) {
      index!.stamp = null;
      index!.indexedSize = 0;
      index!.prefixFingerprint = null;
      this.traceIndex = index;
      return index!.traces;
    }
    const indexedSize = this.forEachCompleteLine(
      filePath,
      index!.indexedSize,
      stamp.size,
      (line) => {
        try {
          const parsed = TraceLine.safeParse(JSON.parse(line));
          if (!parsed.success) return;
          index!.traces.push(parsed.data);
          index!.byClientOpId.set(parsed.data.clientOpId, parsed.data);
          // Every appended trace line mints its own opId (or replays the exact
          // opId of the object mutation it completes), so this is 1:1.
          index!.byOpId.set(parsed.data.opId, parsed.data);
          index!.opIds.add(parsed.data.opId);
          index!.nextSeq = Math.max(index!.nextSeq, parsed.data.seq + 1);
        } catch { /* skipped + traced at boot */ }
      },
    );
    index!.stamp = stamp;
    index!.indexedSize = indexedSize;
    index!.prefixFingerprint = this.indexedPrefixFingerprint(
      filePath,
      index!.indexedSize,
    );
    this.traceIndex = index;
    return index!.traces;
  }

  private nextSeq(traces: TraceLineT[]): number {
    if (this.traceIndex?.traces === traces) return this.traceIndex.nextSeq;
    return traces.reduce((max, t) => Math.max(max, t.seq), -1) + 1;
  }

  findTraceByClientOpId(clientOpId: string): TraceLineT | undefined {
    this.readTraces();
    return this.traceIndex?.byClientOpId.get(clientOpId);
  }

  hasTraceOpId(opId: string): boolean {
    this.readTraces();
    return this.traceIndex?.opIds.has(opId) ?? false;
  }

  /** B3a §4.3: the trace line an opId committed, so its real id/time are reportable. */
  findTraceByOpId(opId: string): TraceLineT | undefined {
    this.readTraces();
    return this.traceIndex?.byOpId.get(opId);
  }

  /** Visit a stable trace-file snapshot without populating the query index. */
  private visitTraceSnapshot(visitor: (trace: TraceLineT) => void): void {
    const filePath = this.storePath('trace');
    const stamp = this.fileStamp(filePath);
    if (!stamp) return;
    this.forEachCompleteLine(filePath, 0, stamp.size, (line) => {
      try {
        const parsed = TraceLine.safeParse(JSON.parse(line));
        if (parsed.success) visitor(parsed.data);
      } catch { /* corrupt lines are ignored by the indexed reader too */ }
    });
  }

  /** Visit valid ids without constructing a retained record projection. */
  private visitRecordIds(kind: string, visitor: (id: string) => void): void {
    const root = this.effectiveReadRoot(kind);
    const filePath = this.storePath(kind, root);
    const stamp = this.fileStamp(filePath);
    if (!stamp) return;
    this.forEachCompleteLine(filePath, 0, stamp.size, (line) => {
      const identity = this.parseRecordIdentity(line);
      if (identity) visitor(identity.id);
    });
  }

  // ── quarantine ────────────────────────────────────────────────────────
  readTombstones(): TombstoneT[] {
    return [...this.readTombstoneIndex().latest.values()]
      .map((tombstone) => QuarantineTombstone.parse(tombstone))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  quarantinedIds(): Set<string> {
    return new Set(this.readTombstoneIndex().openRefs);
  }

  isQuarantined(refId: string): boolean {
    return this.readTombstoneIndex().openRefs.has(refId);
  }

  private readTombstoneIndex(): TombstoneIndex {
    const root = this.effectiveReadRoot('quarantine');
    this.readLatestFrom(root, 'quarantine');
    return this.recordIndexes
      .get(this.storePath('quarantine', root))!
      .tombstones!;
  }

  private indexTombstone(
    index: TombstoneIndex,
    rec: ReadRecord,
  ): void {
    const prior = index.latest.get(rec.envelope.id);
    if (prior?.status === 'open') {
      this.adjustOpenRef(index, prior.quarantinedRef.id, -1);
    }
    index.latest.delete(rec.envelope.id);

    const parsed = QuarantineTombstone.safeParse({
      ...rec.payload,
      ...rec.envelope,
    });
    if (!parsed.success) return;
    index.latest.set(rec.envelope.id, parsed.data);
    if (parsed.data.status === 'open') {
      this.adjustOpenRef(index, parsed.data.quarantinedRef.id, 1);
    }
  }

  private adjustOpenRef(
    index: TombstoneIndex,
    refId: string,
    delta: 1 | -1,
  ): void {
    const count = (index.openRefCounts.get(refId) ?? 0) + delta;
    if (count <= 0) {
      index.openRefCounts.delete(refId);
      index.openRefs.delete(refId);
      return;
    }
    index.openRefCounts.set(refId, count);
    index.openRefs.add(refId);
  }

  // ── dual-read shim (R3-21) ────────────────────────────────────────────
  /** Read fallback: new root first; if the store file is absent there, legacy root. */
  private effectiveReadRoot(kind: string): string {
    if (existsSync(this.storePath(kind)) || !this.legacyRoot) {
      return this.dataRoot;
    }
    return existsSync(this.storePath(kind, this.legacyRoot))
      ? this.legacyRoot
      : this.dataRoot;
  }

  /** First write to a store triggers lazy per-store migration (R3-21). */
  private migrateStoreIfNeeded(kind: string): void {
    if (!this.legacyRoot) return;
    const target = this.storePath(kind);
    const legacy = this.storePath(kind, this.legacyRoot);
    if (!existsSync(target) && existsSync(legacy)) {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(legacy, target); // history moves; legacy root left untouched
    }
  }

  /** Override readLatest to honor the shim. */
  private readLatestFrom(root: string, kind: string): Map<string, ReadRecord> {
    const filePath = this.storePath(kind, root);
    const stamp = this.fileStamp(filePath);
    let index = this.recordIndexes.get(filePath);
    const canExtend = this.canExtendIndex(filePath, stamp, index);
    const unchanged = (
      canExtend
      && stamp!.size === index!.stamp!.size
      && stamp!.mtimeMs === index!.stamp!.mtimeMs
    );
    if (unchanged) return index!.latest;
    if (!canExtend) {
      index = {
        filePath,
        stamp: null,
        indexedSize: 0,
        prefixFingerprint: null,
        latest: new Map(),
        byClientOpId: new Map(),
        ...(kind === 'quarantine'
          ? {
            tombstones: {
              latest: new Map(),
              openRefCounts: new Map(),
              openRefs: new Set(),
            },
          }
          : {}),
      };
    }
    const current = index!;
    if (!stamp) {
      current.stamp = null;
      current.indexedSize = 0;
      current.prefixFingerprint = null;
      this.recordIndexes.set(filePath, current);
      return current.latest;
    }
    const lazyPayloads = HEAVY_PAYLOAD_KINDS.has(kind);
    const indexedSize = this.forEachCompleteLine(
      filePath,
      current.indexedSize,
      stamp.size,
      (line, offset, byteLength) => {
        const rec = this.parseRecordLine(line);
        if (!rec) return;
        if (lazyPayloads) this.detachPayload(rec, filePath, offset, byteLength);
        current.latest.set(rec.envelope.id, rec);
        current.byClientOpId.set(rec.clientOpId, rec);
        if (current.tombstones) {
          this.indexTombstone(current.tombstones, rec);
        }
      },
    );
    current.stamp = stamp;
    current.indexedSize = indexedSize;
    current.prefixFingerprint = this.indexedPrefixFingerprint(
      filePath,
      current.indexedSize,
    );
    this.recordIndexes.set(filePath, current);
    return current.latest;
  }

  readLatestEffective(kind: string): Map<string, ReadRecord> {
    return this.readLatestFrom(this.effectiveReadRoot(kind), kind);
  }

  /** Compact existence/version projection used by create-only batch CAS. */
  private readLatestVersions(kind: string): Map<string, number> {
    const root = this.effectiveReadRoot(kind);
    const filePath = this.storePath(kind, root);
    const stamp = this.fileStamp(filePath);
    let index = this.recordVersionIndexes.get(filePath);
    const canExtend = this.canExtendIndex(filePath, stamp, index);
    const unchanged = (
      canExtend
      && stamp!.size === index!.stamp!.size
      && stamp!.mtimeMs === index!.stamp!.mtimeMs
    );
    if (unchanged) return index!.latestVersion;
    if (!canExtend) {
      index = {
        filePath,
        stamp: null,
        indexedSize: 0,
        prefixFingerprint: null,
        latestVersion: new Map(),
      };
    }
    if (!stamp) {
      index!.stamp = null;
      index!.indexedSize = 0;
      index!.prefixFingerprint = null;
      this.recordVersionIndexes.set(filePath, index!);
      return index!.latestVersion;
    }
    index!.indexedSize = this.forEachCompleteLine(
      filePath,
      index!.indexedSize,
      stamp.size,
      (line) => {
        const identity = this.parseRecordIdentity(line);
        if (identity) {
          index!.latestVersion.set(identity.id, identity.version);
        }
      },
    );
    index!.stamp = stamp;
    index!.prefixFingerprint = this.indexedPrefixFingerprint(
      filePath,
      index!.indexedSize,
    );
    this.recordVersionIndexes.set(filePath, index!);
    return index!.latestVersion;
  }

  /**
   * Visit the latest effective record for every id without retaining a full
   * object index. The first bounded pass records only id -> byte offset; the
   * second pass materializes each winning record for the duration of the
   * callback. This is the projection path for very large append-only stores.
   */
  visitLatestEffective(
    kind: string,
    visitor: (record: ReadRecord) => void,
  ): number {
    const root = this.effectiveReadRoot(kind);
    const filePath = this.storePath(kind, root);
    const stamp = this.fileStamp(filePath);
    if (!stamp) return 0;

    const latestOffsets = new Map<string, number>();
    this.forEachCompleteLine(filePath, 0, stamp.size, (line, offset) => {
      const identity = this.parseRecordIdentity(line);
      if (identity) latestOffsets.set(identity.id, offset);
    });

    let visited = 0;
    this.forEachCompleteLine(filePath, 0, stamp.size, (line, offset) => {
      const record = this.parseRecordLine(line);
      if (!record || latestOffsets.get(record.envelope.id) !== offset) return;
      visitor(record);
      visited += 1;
    });
    return visited;
  }

  findRecordByClientOpId(
    kind: string,
    clientOpId: string,
  ): ReadRecord | undefined {
    const root = this.effectiveReadRoot(kind);
    this.readLatestFrom(root, kind);
    return this.recordIndexes
      .get(this.storePath(kind, root))
      ?.byClientOpId.get(clientOpId);
  }

  // ── boot reconciliation (sys_reconciler) ─────────────────────────────
  /**
   * M2: boot reconciliation (torn-line truncate + orphan stamping) runs UNDER
   * the global mutation lock — never underneath a live writer. If the lock
   * stays held past lockTimeoutMs, boot records a typed LockBusy (bounded
   * wait, §0) instead of reconciling unlocked; mutating contract ops surface
   * it via bootError().
   */
  boot(): void {
    if (this.booted) return;
    mkdirSync(this.root, { recursive: true });
    let lock;
    try {
      lock = acquireLock(this.root, { timeoutMs: this.lockTimeoutMs });
      this.bootLockError = null;
    } catch (error) {
      if (error instanceof LockTimeout) {
        this.bootLockError = err('LockBusy', error.message,
          { waitedMs: error.waitedMs, timeoutMs: error.timeoutMs }, true);
        return;
      }
      throw error;
    }
    try {
      this.booted = true;
      this.reconcileLocked();
    } finally {
      releaseLock(lock);
    }
  }

  /** Non-null when boot could not reconcile because the lock stayed busy. */
  bootError(): StoreError | null {
    return this.bootLockError;
  }

  /** Boot body — caller holds the mutation lock. */
  private reconcileLocked(): void {
    for (const kind of [...RECORD_KINDS, 'trace']) {
      this.migrateStoreIfNeeded(kind);
    }
    // torn-line truncate-on-open + trace (R3-3)
    for (const kind of [...RECORD_KINDS, 'trace']) {
      const filePath = this.storePath(kind);
      const torn = this.truncateTornLine(filePath);
      if (torn) {
        const traces = this.readTraces();
        const trace: TraceLineT = {
          kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
          createdAt: nowIso(), permissionLevel: 'team', createdBy: 'sys_reconciler',
          seq: this.nextSeq(traces), opId: mintServerOpId(), clientOpId: `op_${randomUUID()}`,
          action: 'truncate', target: { kind, id: KIND_FILES[kind as Exclude<ObjectKind, 'token'>] },
          meta: { truncatedBytes: torn.truncatedBytes },
        };
        this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace));
      }
    }
    // Orphan detection (R3-4, amended PASS1.3 R3-4 / S1-contracts §3):
    // an object whose opId lacks a trace is NEVER tombstoned or hidden — it
    // stays readable with `incomplete:true` and a retry with the same
    // clientOpId reconciles (completes the trace, clears the flag).
    // Tombstones apply ONLY to trace-without-object orphans surfaced for
    // human resolution (and corrupt/unparseable records, which never parse
    // into a readable object in the first place).
    // Start with the much smaller set of trace targets, then stream object ids
    // to discharge the ones that have durable records. Building full indexes
    // for nearly one million objects here made reconciliation's scratch graph
    // the process high-water mark even after the graph was released.
    const unmatchedTraces = new Map<string, z.infer<typeof Ref>>();
    this.visitTraceSnapshot((trace) => {
      if (trace.action === 'truncate') return;
      if (
        trace.target.kind === 'transcriptLine'
        && (
          trace.action === 'quarantine'
          || trace.action === 'resolveQuarantine'
        )
      ) return;
      if (trace.opKind === 'system.action') return;
      unmatchedTraces.set(trace.target.id, trace.target);
    });
    for (const kind of RECORD_KINDS) {
      this.visitRecordIds(kind, (id) => unmatchedTraces.delete(id));
    }
    const openTombstones = new Set(
      this.readTombstones().filter((t) => t.status === 'open')
        .map((t) => `${t.quarantinedRef.id}:${t.reason}`),
    );
    const stampTombstone = (ref: z.infer<typeof Ref>, reason: TombstoneT['reason']) => {
      if (openTombstones.has(`${ref.id}:${reason}`)) return;
      const tombstone: Record<string, unknown> = {
        kind: 'quarantine', id: `quarantine_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'private', createdBy: 'sys_reconciler',
        quarantinedRef: ref, reason, status: 'open',
      };
      this.appendLineFsync(
        this.storePath('quarantine'),
        JSON.stringify(this.wrapRecord(tombstone as unknown as EnvelopeT & Record<string, unknown>, {
          opId: mintServerOpId(), clientOpId: `op_${randomUUID()}`, version: 1,
        })),
      );
      openTombstones.add(`${ref.id}:${reason}`);
    };
    // S2a system.action and transcript quarantine traces were excluded above:
    // they are event records, not mutation evidence.
    for (const target of unmatchedTraces.values()) {
      stampTombstone(target, 'orphan_trace_no_object');
    }

    // Reconciliation needs a whole-store view while it proves trace/object
    // integrity, but that view is scratch state — not the query working set.
    // Keeping it here made every scoped handle permanently retain every store.
    this.recordIndexes.clear();
    this.recordVersionIndexes.clear();
    this.traceIndex = undefined;
  }

  // ── writes ────────────────────────────────────────────────────────────
  private wrapRecord(
    flat: EnvelopeT & Record<string, unknown>,
    meta: { opId: string; clientOpId: string; version: number },
  ): RecordLineT {
    const envelope = Envelope.parse({
      kind: flat.kind, id: flat.id, schemaVersion: flat.schemaVersion,
      createdAt: flat.createdAt, permissionLevel: flat.permissionLevel,
      createdBy: flat.createdBy,
      ...(flat.sourceAttribution ? { sourceAttribution: flat.sourceAttribution } : {}),
    });
    const payload: Record<string, unknown> = { ...flat };
    for (const f of ['kind', 'id', 'schemaVersion', 'createdAt', 'permissionLevel', 'createdBy', 'sourceAttribution']) {
      delete payload[f];
    }
    return { envelope, payload, meta };
  }

  /** Async lock wait: contenders queue in the timer queue, so the event loop
   * (HTTP, SIGTERM handlers) stays live while this thread waits its turn. The
   * critical section itself remains synchronous — nothing yields mid-write. */
  private async withLock<T>(fn: () => EngineResult<T>): Promise<EngineResult<T>> {
    let lock;
    try {
      lock = await acquireLockAsync(this.root, { timeoutMs: this.lockTimeoutMs });
    } catch (error) {
      if (error instanceof LockTimeout) {
        return {
          ok: false,
          error: err('LockBusy', error.message, { waitedMs: error.waitedMs, timeoutMs: error.timeoutMs }, true),
        };
      }
      throw error;
    }
    this.bustStampCache(); // lock epoch: in-lock reads must see other writers' appends
    try {
      return fn();
    } finally {
      releaseLock(lock);
    }
  }

  /** Append object line + trace line inside ONE lock hold (R3-2, write order A §9).
   * When `cas` is given, the compare runs INSIDE the lock hold (S1 ruling):
   * mustBeAbsent rejects a create on an existing id; expectedVersion rejects a
   * stale update — both as typed CasConflict before anything is appended. */
  appendMutation(
    kind: string,
    flat: EnvelopeT & Record<string, unknown>,
    action: 'create' | 'update',
    clientOpId: ClientOpId,
    version: number,
    opId: ServerOpId = mintServerOpId(),
    cas?: { mustBeAbsent?: boolean; expectedVersion?: number },
  ): Promise<EngineResult<MutationResult>> {
    return this.withLock(() => {
      if (cas) {
        const existing = this.readLatestEffective(kind).get(flat.id);
        if (cas.mustBeAbsent && existing) {
          return {
            ok: false,
            error: err('CasConflict',
              `object "${flat.id}" already exists (version ${existing.version}) — use updateObject`,
              { id: flat.id as ObjectId, expectedVersion: 0, actualVersion: existing.version }, true),
          };
        }
        if (cas.expectedVersion !== undefined) {
          const actual = existing?.version ?? 0;
          if (actual !== cas.expectedVersion) {
            return {
              ok: false,
              error: err('CasConflict',
                `CAS conflict on "${flat.id}": expected v${cas.expectedVersion}, actual v${actual}`,
                { id: flat.id as ObjectId, expectedVersion: cas.expectedVersion, actualVersion: actual }, true),
            };
          }
          // next version derives from the authoritative locked read
          version = actual + 1;
        }
      }
      const line = JSON.stringify(this.wrapRecord(flat, { opId, clientOpId, version }));
      try {
        const failObj = this.failNextObjectAppend;
        if (failObj) {
          delete this.failNextObjectAppend;
          throw new Error(failObj.cause); // test seam: injected disk failure
        }
        this.appendLineFsync(this.storePath(kind), line); // (1) object append + fsync
      } catch (cause) {
        // M4: a failed object append is typed data, never a raw throw across
        // the contract seam. Nothing was appended; the op is retryable.
        return {
          ok: false,
          error: err('ObjectWriteFailed', `object append failed: ${String(cause)}`, { opId, cause: String(cause) }, true),
        };
      }
      const traces = this.readTraces();
      const trace: TraceLineT = {
        kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'team', createdBy: flat.createdBy,
        seq: this.nextSeq(traces), opId, clientOpId, action,
        target: { kind, id: flat.id },
      };
      const fail = this.failNextTraceAppend;
      if (fail) {
        delete this.failNextTraceAppend;
        // trace append FAILED (crash window): mutation STANDS, object readable
        // with incomplete:true; retry with same clientOpId reconciles (R3-10).
        return {
          ok: false,
          error: err('TraceIncomplete',
            `object appended but trace append failed: ${fail.cause}; retry with the same clientOpId reconciles`,
            { opId, clientOpId, objectId: flat.id as ObjectId }, true),
        };
      }
      try {
        this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace)); // (2) trace append + fsync
      } catch (cause) {
        return {
          ok: false,
          error: err('TraceWriteFailed', `trace append failed: ${String(cause)}`, { opId, cause: String(cause) }, true),
        };
      }
      return { ok: true, value: { object: flat, version, opId, incomplete: false } };
    }); // (3) lock released
  }

  /**
   * Group commit (2026-08-09, ingestion churn fix): N heterogeneous mutations +
   * ONE durable batch receipt + ONE trace, all inside ONE lock hold with ONE
   * fsync per touched file. Every member line shares the batch's server opId,
   * and the single trace line carries that opId targeting the receipt object —
   * so provenance lookups find a trace for every member (no incomplete flags)
   * and boot reconciliation sees a trace whose target exists (no orphans).
   *
   * CAS discipline: mustBeAbsent creates that find an existing id are reported
   * as 'duplicate' and skipped (content-addressed dedup, not an error). Updates
   * derive their version from the authoritative in-lock read — last-writer-wins
   * under the lock, which is exactly the pre-existing serialization guarantee.
   */
  appendMutationBatch(input: {
    ops: Array<{
      kind: string;
      flat: EnvelopeT & Record<string, unknown>;
      action: 'create' | 'update';
      clientOpId: ClientOpId;
      mustBeAbsent?: boolean;
    }>;
    receipt: { flat: EnvelopeT & Record<string, unknown>; clientOpId: ClientOpId };
  }): Promise<EngineResult<{
    outcomes: Array<{ id: string; kind: string; outcome: 'applied' | 'duplicate'; version: number }>;
    opId: ServerOpId;
  }>> {
    return this.withLock(() => {
      const opId = mintServerOpId();
      const outcomes: Array<{ id: string; kind: string; outcome: 'applied' | 'duplicate'; version: number }> = [];
      const linesByKind = new Map<string, string[]>();
      const batchIds = new Set<string>();
      for (const op of input.ops) {
        const existingVersion = op.mustBeAbsent
          ? this.readLatestVersions(op.kind).get(op.flat.id)
          : this.readLatestEffective(op.kind).get(op.flat.id)?.version;
        if (op.mustBeAbsent && (existingVersion !== undefined || batchIds.has(op.flat.id))) {
          outcomes.push({ id: op.flat.id, kind: op.kind, outcome: 'duplicate', version: existingVersion ?? 1 });
          continue;
        }
        const version = op.action === 'update' ? (existingVersion ?? 0) + 1 : 1;
        const line = JSON.stringify(this.wrapRecord(op.flat, { opId, clientOpId: op.clientOpId, version }));
        const lines = linesByKind.get(op.kind) ?? [];
        lines.push(line);
        linesByKind.set(op.kind, lines);
        batchIds.add(op.flat.id);
        outcomes.push({ id: op.flat.id, kind: op.kind, outcome: 'applied', version });
      }
      try {
        for (const [kind, lines] of linesByKind) {
          this.appendLinesFsync(this.storePath(kind), lines); // members first…
        }
        const receiptLine = JSON.stringify(this.wrapRecord(input.receipt.flat, {
          opId, clientOpId: input.receipt.clientOpId, version: 1,
        }));
        this.appendLineFsync(this.storePath('transcriptIngestBatch'), receiptLine); // …receipt as commit marker…
      } catch (cause) {
        return {
          ok: false,
          error: err('ObjectWriteFailed', `batch append failed: ${String(cause)}`, { opId, cause: String(cause) }, true),
        };
      }
      const traces = this.readTraces();
      const trace: TraceLineT = {
        kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'team', createdBy: input.receipt.flat.createdBy,
        seq: this.nextSeq(traces), opId, clientOpId: input.receipt.clientOpId, action: 'create',
        target: { kind: 'transcriptIngestBatch', id: input.receipt.flat.id },
        meta: { batch: true, members: outcomes.filter((o) => o.outcome === 'applied').length },
      };
      try {
        this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace)); // …trace last
      } catch (cause) {
        return {
          ok: false,
          error: err('TraceWriteFailed', `batch trace append failed: ${String(cause)}`, { opId, cause: String(cause) }, true),
        };
      }
      return { ok: true, value: { outcomes, opId } };
    });
  }

  /** Complete a missing trace for an already-appended object (retry reconciliation). */
  completeTrace(
    kind: string, flat: EnvelopeT & Record<string, unknown>, action: 'create' | 'update',
    opId: ServerOpId, clientOpId: ClientOpId,
  ): Promise<EngineResult<null>> {
    return this.withLock(() => {
      const traces = this.readTraces();
      const trace: TraceLineT = {
        kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'team', createdBy: flat.createdBy,
        seq: this.nextSeq(traces), opId, clientOpId, action,
        target: { kind, id: flat.id },
      };
      this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace));
      return { ok: true, value: null };
    });
  }

  /** Append a trace line for a quarantine lifecycle action. */
  appendLifecycleTrace(
    action: 'quarantine' | 'resolveQuarantine', target: z.infer<typeof Ref>,
    actor: string, clientOpId: ClientOpId, meta?: Record<string, unknown>,
  ): Promise<EngineResult<null>> {
    return this.withLock(() => {
      const traces = this.readTraces();
      const trace: TraceLineT = {
        kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'team', createdBy: actor,
        seq: this.nextSeq(traces), opId: mintServerOpId(), clientOpId, action, target,
        ...(meta ? { meta } : {}),
      };
      this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace));
      return { ok: true, value: null };
    });
  }

  /**
   * Public-contract quarantine request implementation. The caller supplies
   * only a scoped target and stable operation identity; Foundation owns the
   * tombstone envelope, lock, append, and lifecycle trace.
   */
  requestQuarantine(opts: {
    tombstoneId: string;
    target: z.infer<typeof Ref>;
    /**
     * The REQUESTER. Kept for the typed error surface and for callers of the
     * pre-Q10 shape; it no longer stamps anything Foundation writes, because
     * Foundation is what performs this write.
     */
    actor: string;
    clientOpId: ClientOpId;
    /** Q10: who asked. Foundation is the writer either way. */
    requestedBy?: z.infer<typeof QuarantineRequestProvenance>;
  }): Promise<EngineResult<{
    outcome: 'created' | 'already_requested';
    tombstone: TombstoneT;
  }>> {
    return this.withLock<{
      outcome: 'created' | 'already_requested';
      tombstone: TombstoneT;
    }>(() => {
      const prior = this.findRecordByClientOpId(
        'quarantine',
        opts.clientOpId,
      );
      if (prior) {
        const parsed = QuarantineTombstone.safeParse({
          ...prior.envelope,
          ...prior.payload,
        });
        if (
          parsed.success
          && parsed.data.quarantinedRef.kind === opts.target.kind
          && parsed.data.quarantinedRef.id === opts.target.id
        ) {
          if (!this.hasTraceOpId(prior.opId)) {
            try {
              const trace: TraceLineT = {
                kind: 'trace',
                id: `trace_${randomUUID()}`,
                schemaVersion: 1,
                createdAt: nowIso(),
                permissionLevel: 'team',
                createdBy: 'sys_foundation',
                seq: this.nextSeq(this.readTraces()),
                opId: prior.opId as ServerOpId,
                clientOpId: opts.clientOpId,
                action: 'quarantine',
                target: opts.target,
              };
              this.appendLineFsync(
                this.storePath('trace'),
                JSON.stringify(trace),
              );
            } catch (cause) {
              return {
                ok: false,
                error: err(
                  'TraceWriteFailed',
                  `quarantine trace append failed: ${String(cause)}`,
                  {
                    opId: prior.opId as ServerOpId,
                    cause: String(cause),
                  },
                  true,
                ),
              };
            }
          }
          return {
            ok: true,
            value: {
              outcome: 'already_requested',
              tombstone: parsed.data,
            },
          };
        }
        return {
          ok: false,
          error: err(
            'CasConflict',
            `client operation "${opts.clientOpId}" already targets another quarantine request`,
            {
              id: opts.tombstoneId as ObjectId,
              expectedVersion: 0,
              actualVersion: prior.version,
            },
            false,
          ),
        };
      }

      // Q10: Foundation CONSTRUCTS, the capability only REQUESTED. `createdBy`
      // names the writer — `opts.actor` here would grant the requester a
      // quarantine write it does not hold — and `requestedBy` keeps the causal
      // fact that would otherwise be lost by fixing the writer.
      const tombstone = QuarantineTombstone.parse({
        kind: 'quarantine',
        id: opts.tombstoneId,
        schemaVersion: 1,
        createdAt: nowIso(),
        permissionLevel: 'private',
        createdBy: 'sys_foundation',
        quarantinedRef: opts.target,
        reason: 'corrupt_record',
        status: 'open',
        ...(opts.requestedBy === undefined ? {} : { requestedBy: opts.requestedBy }),
      });
      const opId = mintServerOpId();
      try {
        this.appendLineFsync(
          this.storePath('quarantine'),
          JSON.stringify(this.wrapRecord(
            tombstone as EnvelopeT & Record<string, unknown>,
            { opId, clientOpId: opts.clientOpId, version: 1 },
          )),
        );
      } catch (cause) {
        return {
          ok: false,
          error: err(
            'ObjectWriteFailed',
            `quarantine append failed: ${String(cause)}`,
            { opId, cause: String(cause) },
            true,
          ),
        };
      }
      try {
        const trace: TraceLineT = {
          kind: 'trace',
          id: `trace_${randomUUID()}`,
          schemaVersion: 1,
          createdAt: nowIso(),
          permissionLevel: 'team',
          createdBy: 'sys_foundation',
          seq: this.nextSeq(this.readTraces()),
          opId,
          clientOpId: opts.clientOpId,
          action: 'quarantine',
          target: opts.target,
        };
        this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace));
      } catch (cause) {
        return {
          ok: false,
          error: err(
            'TraceIncomplete',
            `quarantine appended but trace append failed: ${String(cause)}`,
            {
              opId,
              clientOpId: opts.clientOpId,
              objectId: tombstone.id as ObjectId,
            },
            true,
          ),
        };
      }
      return {
        ok: true,
        value: { outcome: 'created', tombstone },
      };
    });
  }

  /**
   * M1: the WHOLE resolveQuarantine mutation — optional reconcile-trace +
   * tombstone status line + lifecycle trace — inside ONE lock hold. Nothing
   * is written outside the lock; a busy lock yields typed LockBusy and no
   * partial writes.
   */
  resolveQuarantine(opts: {
    next: TombstoneT;
    version: number;
    actor: string;
    clientOpId: ClientOpId;
    reconcile?: { kind: string; flat: EnvelopeT & Record<string, unknown>; opId: ServerOpId; clientOpId: ClientOpId };
  }): Promise<EngineResult<TombstoneT>> {
    return this.withLock(() => {
      let seq = this.nextSeq(this.readTraces());
      const appendTrace = (trace: TraceLineT): void => {
        this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace));
        seq += 1;
      };
      if (opts.reconcile) {
        const reconcile = opts.reconcile;
        appendTrace({
          kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
          createdAt: nowIso(), permissionLevel: 'team', createdBy: reconcile.flat.createdBy,
          seq, opId: reconcile.opId, clientOpId: reconcile.clientOpId, action: 'create',
          target: { kind: reconcile.kind, id: reconcile.flat.id },
        });
      }
      this.appendLineFsync(
        this.storePath('quarantine'),
        JSON.stringify(this.wrapRecord(opts.next as EnvelopeT & Record<string, unknown>, {
          opId: mintServerOpId(), clientOpId: opts.clientOpId, version: opts.version,
        })),
      );
      appendTrace({
        kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'team', createdBy: opts.actor,
        seq, opId: mintServerOpId(), clientOpId: opts.clientOpId, action: 'resolveQuarantine',
        target: { kind: 'quarantine', id: opts.next.id },
        meta: { resolution: opts.next.resolution },
      });
      return { ok: true, value: opts.next };
    });
  }

  /**
   * S2a (S2-pass1 §22 ruling 3): append a named SYSTEM ACTION trace line
   * (hook_log / context.inject / hook_error). opKind 'system.action' marks it
   * as an event record — boot reconcile never tombstones it. Read-only journal
   * law unchanged: no update/delete, append under the same lock.
   */
  appendSystemActionTrace(
    action: 'hook_log' | 'context.inject' | 'hook_error' | 'session.terminate'
      | 'artifact.orphan.sweep', target: z.infer<typeof Ref>,
    actor: string, clientOpId: ClientOpId, meta?: Record<string, unknown>,
  ): Promise<EngineResult<null>> {
    return this.withLock(() => {
      const traces = this.readTraces();
      const prior = traces.find((line) =>
        line.opKind === 'system.action'
        && line.clientOpId === clientOpId
        && line.action === action
        && line.target.kind === target.kind
        && line.target.id === target.id
        && JSON.stringify(line.meta ?? {}) === JSON.stringify(meta ?? {}));
      if (prior) return { ok: true, value: null };
      const trace: TraceLineT = {
        kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'team', createdBy: actor,
        seq: this.nextSeq(traces), opId: mintServerOpId(), clientOpId, action,
        opKind: 'system.action', target,
        ...(meta ? { meta } : {}),
      };
      const fail = this.failNextTraceAppend;
      if (fail) {
        delete this.failNextTraceAppend;
        return {
          ok: false,
          error: err('TraceWriteFailed', `system.action trace append failed: ${fail.cause}`, { opId: trace.opId as ServerOpId, cause: fail.cause }, true),
        };
      }
      try {
        this.appendLineFsync(this.storePath('trace'), JSON.stringify(trace));
      } catch (cause) {
        // typed across the seam — hook engines CHECK this Result (M7)
        return {
          ok: false,
          error: err('TraceWriteFailed', `system.action trace append failed: ${String(cause)}`, { opId: trace.opId as ServerOpId, cause: String(cause) }, true),
        };
      }
      return { ok: true, value: null };
    });
  }

  /**
   * §18.1 steps 5–7 — the offline store-route cutover, as ONE lock-held
   * bootstrap.
   *
   * This is the "explicit additive Foundation bootstrap method over its
   * existing object append, trace append, CAS and fsync primitives" the spec
   * names. It is not a capability-visible writer and not a second engine: it
   * reuses `wrapRecord`, `appendLineFsync` and the same global lock every other
   * mutation uses. What it adds is the choreography a per-record loop cannot
   * have — one lock hold across the whole migration, receipt/trace files
   * durably prepared BEFORE either append, and directory barriers after each.
   *
   * The cutover shipped as a per-line `createObject` loop through a MESSAGING
   * handle that granted itself `storeRouteCutover` — the one kind §18.1 marks
   * Foundation-bootstrap-only, and which `b3a-registry.test.ts` proves is
   * refused through exactly that handle. Each line took the lock separately, so
   * there was no offline fence at all: another writer could interleave between
   * any two migrated lines.
   *
   * `traceComplete` is written, not asserted. The receipt is appended, its
   * trace is appended, the trace is READ BACK, and only then is a second
   * receipt line appended carrying `traceComplete: true`. Dispatch waits on
   * that persisted value, so a receipt that claimed it on faith would let the
   * canonical route open over an unproven migration — which is what shipped:
   * `true` in memory, `false` on disk, forever.
   */
  bootstrapStoreRouteCutover(input: {
    /**
     * §18.1 step 4 — the byte-copyable half of the migration.
     *
     * Every registered kind whose canonical target is absent and whose legacy
     * source exists is copied WHOLE, inside this same lock hold, before any
     * record is appended. It was left to `migrateStoreIfNeeded`, which copies a
     * kind lazily on its FIRST WRITE — so a root upgraded from B1 came up with
     * ~40 legacy files unmigrated and served them through the dual-read
     * fallback, which is the "new-root-first fallback silently hiding a newer
     * legacy append" §18.1's last paragraph forbids by name.
     */
    readonly copy?: {
      readonly legacyRoot: string;
      readonly kinds: readonly string[];
    };
    readonly records: readonly {
      readonly kind: string;
      readonly flat: EnvelopeT & Record<string, unknown>;
      readonly clientOpId: ClientOpId;
    }[];
    readonly receipt: {
      readonly kind: string;
      readonly flat: EnvelopeT & Record<string, unknown>;
      readonly clientOpId: ClientOpId;
    };
  }): Promise<EngineResult<{
    readonly traceComplete: boolean;
    readonly receiptOpId: ServerOpId;
    readonly copiedKinds: readonly string[];
  }>> {
    return this.withLock(() => {
      const touched = new Set<string>();
      const receiptPath = this.storePath(input.receipt.kind);
      const tracePath = this.storePath('trace');

      // Step 4, then step 5's verification, as one step because a copy that is
      // not verified must never reach the prepare below.
      const copiedKinds: string[] = [];
      const copiedPaths: string[] = [];
      const copyFailure = this.copyLegacyStores(input.copy, copiedKinds, copiedPaths);
      if (copyFailure !== null) return cutoverFailure(copyFailure);

      const prepareFailure = this.prepareCutoverTargets(copiedPaths, receiptPath, tracePath);
      if (prepareFailure !== null) return cutoverFailure(prepareFailure);

      // A copied store is on disk now, so every cached index built from the
      // absent-file state is stale. Reading one back would report the canonical
      // route as empty — which is exactly what a pre-cutover Message would look
      // like to a client afterwards.
      this.recordIndexes.clear();
      this.recordVersionIndexes.clear();
      this.traceIndex = undefined;

      const migrateFailure = this.migrateCutoverRecords(input.records, tracePath, touched);
      if (migrateFailure !== null) return cutoverFailure(migrateFailure);

      // Step 5's remainder: each copied target file is fsynced by the append
      // above; the DIRECTORY is fsynced here, once, and never as a substitute
      // for the file-data fsync.
      try {
        for (const filePath of touched) this.fsyncDirectory(path.dirname(filePath));
      } catch (cause) {
        return cutoverFailure(
          err('ObjectWriteFailed', `directory barrier failed: ${String(cause)}`,
            { opId: mintServerOpId(), cause: String(cause) }, true),
        );
      }

      // Step 6: the receipt object, then its directory barrier.
      const receiptOpId = mintServerOpId();
      try {
        this.appendLineFsync(receiptPath, JSON.stringify(this.wrapRecord(
          input.receipt.flat,
          { opId: receiptOpId, clientOpId: input.receipt.clientOpId, version: 1 },
        )));
        this.fsyncDirectory(path.dirname(receiptPath));
      } catch (cause) {
        return cutoverFailure(
          err('ObjectWriteFailed', `the cutover receipt append failed: ${String(cause)}`,
            { opId: receiptOpId, cause: String(cause) }, true),
        );
      }

      // Step 6's second half: the receipt trace, then ITS directory barrier.
      try {
        this.appendLineFsync(tracePath, JSON.stringify({
          kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
          createdAt: nowIso(), permissionLevel: 'team',
          createdBy: input.receipt.flat.createdBy,
          seq: this.nextSeq(this.readTraces()), opId: receiptOpId,
          clientOpId: input.receipt.clientOpId, action: 'create',
          target: { kind: input.receipt.kind, id: input.receipt.flat.id },
        } satisfies TraceLineT));
        this.fsyncDirectory(path.dirname(tracePath));
      } catch (cause) {
        return cutoverFailure(
          err('TraceWriteFailed', `the cutover receipt trace failed: ${String(cause)}`,
            { opId: receiptOpId, cause: String(cause) }, true),
        );
      }

      // Step 7: reconcile, then PERSIST the reconciliation. Reading the trace
      // back is the proof; the second receipt line is what makes the proof
      // survive this process.
      const traceComplete = this.hasTraceOpId(receiptOpId);
      if (traceComplete) {
        try {
          this.appendLineFsync(receiptPath, JSON.stringify(this.wrapRecord(
            { ...input.receipt.flat, traceComplete: true },
            { opId: mintServerOpId(), clientOpId: input.receipt.clientOpId, version: 2 },
          )));
          this.fsyncDirectory(path.dirname(receiptPath));
        } catch (cause) {
          return cutoverFailure(
            err('ObjectWriteFailed',
              `sealing the cutover receipt failed: ${String(cause)}`,
              { opId: receiptOpId, cause: String(cause) }, true),
          );
        }
      }
      return { ok: true, value: { traceComplete, receiptOpId, copiedKinds } };
    });
  }

  /**
   * §18.1 step 4 + step 5's verification: copy each legacy store WHOLE, then
   * prove the copy before anything is allowed to depend on it.
   *
   * A copy that silently truncated would otherwise be sealed by a receipt
   * saying the route moved successfully, and the truncated half would simply
   * never be read again.
   */
  private copyLegacyStores(
    copy: { readonly legacyRoot: string; readonly kinds: readonly string[] } | undefined,
    kinds: string[],
    paths: string[],
  ): StoreError | null {
    for (const kind of copy?.kinds ?? []) {
      const source = this.storePath(kind, copy!.legacyRoot);
      const target = this.storePath(kind);
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        copyFileSync(source, target); // the source is never written
      } catch (cause) {
        return err('ObjectWriteFailed',
          `copying the legacy ${kind} store failed: ${String(cause)}`,
          { opId: mintServerOpId(), cause: String(cause) }, true);
      }
      const mismatch = verifyCopiedStore(source, target);
      if (mismatch !== null) {
        return err('StoreRouteConflict',
          `the migrated ${kind} store does not match its legacy source: ${mismatch}`,
          { kind, legacyPath: source, canonicalPath: target }, false);
      }
      kinds.push(kind);
      paths.push(target);
    }
    return null;
  }

  /**
   * §18.1 step 5: every copied target, plus the receipt and trace files, exist
   * DURABLY before either append — so their directory entries are already on
   * disk and the post-append barriers have something to make durable. The
   * directory fsync comes last and never substitutes for the per-file one.
   */
  private prepareCutoverTargets(
    copiedPaths: readonly string[], receiptPath: string, tracePath: string,
  ): StoreError | null {
    try {
      for (const copied of copiedPaths) this.prepareFile(copied);
      this.prepareFile(receiptPath);
      this.prepareFile(tracePath);
      this.fsyncDirectory(path.dirname(receiptPath));
    } catch (cause) {
      return err('ObjectWriteFailed',
        `preparing the cutover target files failed: ${String(cause)}`,
        { opId: mintServerOpId(), cause: String(cause) }, true);
    }
    return null;
  }

  /**
   * §18.1 step 4/5: every converted record, one source operation to one atomic
   * persisted operation, all inside the caller's single lock hold. Each store
   * path it writes is added to `touched` so the caller's directory barrier
   * covers it.
   */
  private migrateCutoverRecords(
    records: readonly {
      readonly kind: string;
      readonly flat: EnvelopeT & Record<string, unknown>;
      readonly clientOpId: ClientOpId;
    }[],
    tracePath: string,
    touched: Set<string>,
  ): StoreError | null {
    for (const record of records) {
      const opId = mintServerOpId();
      const trace: TraceLineT = {
        kind: 'trace', id: `trace_${randomUUID()}`, schemaVersion: 1,
        createdAt: nowIso(), permissionLevel: 'team', createdBy: record.flat.createdBy,
        seq: this.nextSeq(this.readTraces()), opId, clientOpId: record.clientOpId,
        action: 'create', target: { kind: record.kind, id: record.flat.id },
      };
      try {
        const filePath = this.storePath(record.kind);
        this.appendLineFsync(filePath, JSON.stringify(
          this.wrapRecord(record.flat, { opId, clientOpId: record.clientOpId, version: 1 }),
        ));
        touched.add(filePath);
        this.appendLineFsync(tracePath, JSON.stringify(trace));
      } catch (cause) {
        return err('ObjectWriteFailed',
          `migrating ${String(record.flat.id)} failed: ${String(cause)}`,
          { opId, cause: String(cause) }, true);
      }
    }
    return null;
  }

  /** Create an empty target file if absent, and make its data durable. */
  private prepareFile(filePath: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const handle = openSync(filePath, 'a');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }

  /**
   * §18.1: "Directory fsync never substitutes for file-data fsync." This is the
   * other half — a file whose data is durable but whose directory entry is not
   * can still vanish across a power loss.
   */
  private fsyncDirectory(folder: string): void {
    const handle = openSync(folder, 'r');
    try {
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
  }

  /** Append a new line to an engine-managed store directly (tombstone status transitions). */
  appendRecordLine(
    kind: string, flat: EnvelopeT & Record<string, unknown>,
    meta: { opId: string; clientOpId: string; version: number },
  ): void {
    this.appendLineFsync(this.storePath(kind), JSON.stringify(this.wrapRecord(flat, meta)));
  }
}

/**
 * §18.1 step 5's verification of one copied store file.
 *
 * "verifies source/target byte length, content digest, record-line validity".
 * All three, because each catches something the others miss: length catches a
 * short write, the digest catches a corrupted one, and parsing catches a file
 * that copied perfectly but was never a record journal in the first place.
 *
 * Returns the reason it failed, or null when the copy is sound.
 */
/**
 * One `{ ok: false }` for the cutover bootstrap, so its seven failure paths read
 * as what they are — a reason and a code — rather than as seven copies of the
 * result shape.
 */
function cutoverFailure<T>(error: StoreError): EngineResult<T> {
  return { ok: false, error };
}

function verifyCopiedStore(source: string, target: string): string | null {
  const sourceBytes = readFileSync(source);
  const targetBytes = readFileSync(target);
  if (sourceBytes.length !== targetBytes.length) {
    return `byte length ${String(targetBytes.length)} != source ${String(sourceBytes.length)}`;
  }
  const digest = (buffer: Buffer): string =>
    createHash('sha256').update(buffer).digest('hex');
  const sourceDigest = digest(sourceBytes);
  const targetDigest = digest(targetBytes);
  if (sourceDigest !== targetDigest) {
    return `content digest ${targetDigest} != source ${sourceDigest}`;
  }
  return firstInvalidRecordLine(targetBytes.toString('utf8'));
}

/**
 * The record-line half of the verification, named separately because "these
 * bytes arrived intact" and "these bytes are a record journal" are two
 * different claims and a caller reading a failure wants to know which one broke.
 */
function firstInvalidRecordLine(contents: string): string | null {
  for (const [index, line] of contents.split('\n').entries()) {
    if (line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return `line ${String(index + 1)} is not JSON`;
    }
    // Both shapes the engine reads: a wrapped `{envelope,payload,meta}` record
    // line, and the v0 flat record the dual-read shim still upgrades lazily.
    const wrapped = (parsed as { envelope?: unknown }).envelope;
    const valid = wrapped === undefined
      ? Envelope.safeParse(parsed).success
      : Envelope.safeParse(wrapped).success;
    if (!valid) return `line ${String(index + 1)} is not a record line`;
  }
  return null;
}

export { Ref };
