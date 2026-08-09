// The store facade — the ONE public interface to .novakai/stores validation.
// Pure core lives in validate.mjs/schema.mjs (internal); this module owns the
// impure edges: directory reads, SC4-bracketed audits, and the guarded
// append-only writer. Appends never rewrite an existing byte; the ONE
// sanctioned exception is replaceLine — a locked, CAS-guarded, fully
// validated, atomic single-record state transition (Manager ruling,
// mission_mission-object-model; partially closes
// issue_store-writer-residual-gap). Every other byte of history is immutable.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, realpathSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { STORE_KINDS } from './schema.mjs';
import { parseSnapshot, validateCandidate, auditSnapshot, validateBlock, buildIndex, validateTransition } from './validate.mjs';

export { validateCandidate, auditSnapshot, validateTransition } from './validate.mjs';

/** Raised when a candidate fails validation; carries the typed violations. */
export class StoreValidationError extends Error {
  constructor(violations) {
    super(`candidate rejected: ${violations.map((violation) => `[${violation.code}] ${violation.message}`).join('; ')}`);
    this.name = 'StoreValidationError';
    this.violations = violations;
  }
}

/** Raised when an operation is refused before touching any store content (M7/containment). */
export class StoreRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreRefusalError';
  }
}

/** Raised when a transition's compare-and-swap fails: the record changed under
 * the caller. Retry by re-reading the current line — never by forcing. */
export class StoreConflictError extends StoreRefusalError {
  constructor(message) {
    super(message);
    this.name = 'StoreConflictError';
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// Only schema-recognized store files. The dir is shared with the packages/
// foundation store-engine, whose telemetry files (traces, commandReceipts, …)
// grow without bound — globbing *.jsonl made every read/write here O(entire
// dir), the 2026-08-09 churn incident. Foreign files are not ours to parse.
function storeFileNames(storeDir) {
  return readdirSync(storeDir)
    .filter((name) => Object.hasOwn(STORE_KINDS, name))
    .sort();
}

/** sha256 of every schema-recognized store file in the dir. */
export function checksumStores(storeDir) {
  const checksums = {};
  for (const name of storeFileNames(storeDir)) {
    checksums[name] = sha256(readFileSync(path.join(storeDir, name)));
  }
  return checksums;
}

/** Read every store file into a parsed Snapshot (impure edge; core stays pure). */
export function readStoreDir(storeDir) {
  const files = {};
  for (const name of storeFileNames(storeDir)) {
    files[name] = readFileSync(path.join(storeDir, name), 'utf8');
  }
  return parseSnapshot(files);
}

/**
 * Audit a directory under SC4 snapshot discipline: hash → one in-memory read →
 * hash; a mismatch discards the result and retries. Never writes anything.
 * `betweenReads` is a test seam.
 */
export function auditDir(storeDir, { attempts = 3, betweenReads } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = checksumStores(storeDir);
    const snapshot = readStoreDir(storeDir);
    betweenReads?.();
    const after = checksumStores(storeDir);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { audit: auditSnapshot(snapshot), checksums: after, snapshot };
    }
  }
  throw new Error(`SC4: store checksums changed during every snapshot read (${attempts} attempts) — census discarded, not baselined`);
}

// --- Delta-S2 lock: owner token + liveness-checked takeover ------------------

const LOCK_NAME = '.nvk-store.lock';

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists but not ours — treat as alive
  }
}

function readLockOwner(lockDir) {
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null; // mid-acquisition or unreadable — treat as alive/unknown
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Acquire the cross-process store lock. Takeover of a held lock happens ONLY
 * when the recorded owner pid is verifiably dead — age alone never breaks a
 * lock (Delta-S2). @internal — exported for the lock-protocol tests.
 */
export function acquireLock(storeDir, { timeoutMs = 5000, pollMs = 50 } = {}) {
  const lockDir = path.join(storeDir, LOCK_NAME);
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token }) + '\n');
      return { lockDir, token };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readLockOwner(lockDir);
      if (owner && Number.isInteger(owner.pid) && !isPidAlive(owner.pid)) {
        rmSync(lockDir, { recursive: true, force: true }); // dead holder — contenders re-race mkdir; exactly one wins
        continue;
      }
      if (Date.now() >= deadline) {
        throw new StoreRefusalError(`store lock is held by live pid ${owner?.pid ?? '(unknown)'} — timed out after ${timeoutMs}ms; a live holder is never broken`);
      }
      sleepSync(pollMs);
    }
  }
}

/** Release only a lock we own — a stale token is a no-op (Delta-S2). @internal */
export function releaseLock({ lockDir, token }) {
  const owner = readLockOwner(lockDir);
  if (owner?.token !== token) return;
  rmSync(lockDir, { recursive: true, force: true });
}

// --- guarded append-only writer ----------------------------------------------

function resolveAppendTarget(storeDir, storeFile) {
  if (!Object.hasOwn(STORE_KINDS, storeFile) || path.basename(storeFile) !== storeFile) {
    throw new StoreRefusalError(`"${storeFile}" is not a recognized store file (allowed: ${Object.keys(STORE_KINDS).join(', ')})`);
  }
  const resolvedDir = realpathSync(storeDir);
  const filePath = path.join(resolvedDir, storeFile);
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    throw new StoreRefusalError(`${storeFile} does not exist in ${resolvedDir} — appendLine never creates store files`);
  }
  if (!stat.isFile()) {
    throw new StoreRefusalError(`${storeFile} is not a regular file (symlinks and directories are refused)`);
  }
  if (path.dirname(realpathSync(filePath)) !== resolvedDir) {
    throw new StoreRefusalError(`${storeFile} resolves outside the store directory — refused`);
  }
  return { resolvedDir, filePath };
}

function enrollBaselineId(baselinePath, id) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return; // no baseline yet — the gate's --update will inventory this id
  }
  if (!Array.isArray(baseline.ids) || baseline.ids.includes(id)) return;
  baseline.ids = [...baseline.ids, id].sort();
  writeFileSync(baselinePath, JSON.stringify(baseline) + '\n');
}

/**
 * Append ONE raw JSON line to a store, validated against the full cross-store
 * index under the lock. On pass the ORIGINAL bytes are appended unchanged
 * (+ '\n'). Rejections throw StoreValidationError; refusals throw
 * StoreRefusalError; either way no store byte changes.
 */
export function appendLine(storeDir, storeFile, rawLine, { lockTimeoutMs = 5000, baselinePath } = {}) {
  const { resolvedDir, filePath } = resolveAppendTarget(storeDir, storeFile);
  const lock = acquireLock(resolvedDir, { timeoutMs: lockTimeoutMs });
  try {
    const existing = readFileSync(filePath);
    if (existing.length > 0 && existing[existing.length - 1] !== 0x0a) {
      throw new StoreRefusalError(`${storeFile} does not end with a newline — appending would corrupt the unterminated final line; refused (no repair attempted)`);
    }
    const snapshot = readStoreDir(resolvedDir);
    const { violations, block } = validateCandidate(rawLine, { storeFile, snapshot });
    if (violations.length > 0) throw new StoreValidationError(violations);
    appendFileSync(filePath, rawLine + '\n');
    const after = readFileSync(filePath);
    if (!after.equals(Buffer.concat([existing, Buffer.from(rawLine + '\n')]))) {
      throw new Error(`SC5: post-append bytes of ${storeFile} are not exactly old-prefix + candidate line — stopping; no repair or delete will be attempted`);
    }
    if (baselinePath) enrollBaselineId(baselinePath, block.id);
    return { id: block.id, storeFile, bytesAppended: Buffer.byteLength(rawLine) + 1 };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Provision the recognized store files (correction C1): create-if-missing
 * empty files so a fresh deployment needs no manual touch step. Composition
 * (the object model's roots) is the ONE sanctioned caller — appendLine's
 * missing-file refusal stays, protecting the CLI from filename typos.
 * @returns {string[]} the files that were created
 */
export function ensureStoreFiles(storeDir) {
  const resolvedDir = realpathSync(storeDir);
  const created = [];
  for (const storeFile of Object.keys(STORE_KINDS)) {
    const filePath = path.join(resolvedDir, storeFile);
    try {
      lstatSync(filePath);
    } catch {
      writeFileSync(filePath, '', { flag: 'wx' });
      created.push(storeFile);
    }
  }
  return created;
}

// --- guarded transition writer (replaceLine) ---------------------------------

/**
 * Replace ONE existing record with a validated successor — the sanctioned
 * state-transition path (ruling S3). Under the lock: the target id must be
 * unique across every store and live in `storeFile`; `expectedRaw` must equal
 * the record's current raw line (CAS — a mismatch throws StoreConflictError,
 * and the caller retries by re-reading, never by forcing); the candidate must
 * pass validateTransition (id/kind immutable, status legal, `updated` strictly
 * forward) AND full validateBlock against the post-transition snapshot. The
 * write is crash-safe: same-dir temp file, byte-exact verify, atomic rename,
 * byte-exact read-back. A failed read-back throws and repairs nothing.
 */
export function replaceLine(storeDir, storeFile, id, candidateLine, { expectedRaw, lockTimeoutMs = 5000, seams } = {}) {
  const { resolvedDir, filePath } = resolveAppendTarget(storeDir, storeFile);
  if (typeof expectedRaw !== 'string' || /[\r\n]/.test(expectedRaw)) {
    throw new StoreRefusalError('expectedRaw (the exact current line, no newline) is required — transitions are compare-and-swap');
  }
  if (/[\r\n]/.test(candidateLine)) {
    throw new StoreValidationError([{ code: 'LINE-BOUNDARY', message: 'a candidate must be exactly one line', storeFile }]);
  }
  let candidateBlock;
  try {
    candidateBlock = JSON.parse(candidateLine);
  } catch (error) {
    throw new StoreValidationError([{ code: 'PARSE', message: `invalid JSON: ${error.message}`, storeFile }]);
  }
  if (candidateBlock === null || typeof candidateBlock !== 'object' || Array.isArray(candidateBlock)) {
    throw new StoreValidationError([{ code: 'PARSE', message: 'candidate is not a single JSON object', storeFile }]);
  }
  const lock = acquireLock(resolvedDir, { timeoutMs: lockTimeoutMs });
  try {
    const originalText = readFileSync(filePath, 'utf8');
    if (originalText.length > 0 && !originalText.endsWith('\n')) {
      throw new StoreRefusalError(`${storeFile} does not end with a newline — transitioning would touch an unterminated final line; refused (no repair attempted)`);
    }
    const snapshot = readStoreDir(resolvedDir);
    const occurrences = buildIndex(snapshot).get(id);
    if (!occurrences || occurrences.length === 0) {
      throw new StoreRefusalError(`id "${id}" resolves to no record — replaceLine never creates`);
    }
    if (occurrences.length > 1) {
      throw new StoreRefusalError(`id "${id}" occurs ${occurrences.length} times (${occurrences.map((occurrence) => occurrence.storeFile).join(', ')}) — ambiguous target refused`);
    }
    if (occurrences[0].storeFile !== storeFile) {
      throw new StoreRefusalError(`id "${id}" lives in ${occurrences[0].storeFile}, not ${storeFile}`);
    }
    const record = snapshot.files[storeFile].records.find((candidate) => candidate.block.id === id);
    if (record.raw !== expectedRaw) {
      throw new StoreConflictError(`CAS conflict: the current line for "${id}" differs from expectedRaw — re-read and retry`);
    }
    const violations = [...validateTransition(record.block, candidateBlock)];
    // Full-candidate legality is judged against the world AFTER the swap, so
    // self-refs and cross-refs resolve against the candidate, not the past.
    const postSnapshot = parseSnapshot(Object.fromEntries(
      Object.entries(snapshot.files).map(([name, file]) => {
        const text = file.records.map((existing) => (existing === record ? candidateLine : existing.raw)).join('\n');
        return [name, text.length > 0 ? text + '\n' : ''];
      }),
    ));
    violations.push(...validateBlock(candidateBlock, { storeFile, index: buildIndex(postSnapshot) }));
    if (violations.length > 0) throw new StoreValidationError(violations);

    const lines = originalText.split('\n');
    lines[record.line - 1] = candidateLine;
    const newText = lines.join('\n');
    const tempPath = path.join(resolvedDir, `.${storeFile}.transition-${randomUUID()}`);
    try {
      writeFileSync(tempPath, newText);
      seams?.afterTempWrite?.(tempPath); // @internal crash-injection seam (tests only)
      if (!readFileSync(tempPath).equals(Buffer.from(newText))) {
        throw new Error(`SC5-T: temp file bytes for ${storeFile} do not match the intended content — stopping before rename; no repair attempted`);
      }
      seams?.beforeRename?.(tempPath); // @internal crash-injection seam (tests only)
      renameSync(tempPath, filePath);
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
    seams?.afterRename?.(filePath); // @internal crash-injection seam (tests only)
    if (!readFileSync(filePath).equals(Buffer.from(newText))) {
      throw new Error(`SC5-T: post-transition bytes of ${storeFile} are not exactly the intended content — stopping; no repair or rollback will be attempted`);
    }
    return { id, storeFile, line: record.line };
  } finally {
    releaseLock(lock);
  }
}
