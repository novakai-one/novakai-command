// core/watcher — TRN-001 copy-only watchers (DEC-S2-10).
//
// Custody law:
//  - copy-only into .novakai/transcripts/<provider>/<relative path>;
//  - raw copies are IMMUTABLE once written (ruling 6) — appended source bytes
//    are appended to the copy; a rotated/truncated source becomes a NEW
//    `.rescan-<n>` copy record, the original is never touched;
//  - byte-offset checkpoints in .novakai/transcripts/.state/ (R3-14);
//  - watch-while-running ONLY (OD-D1): no start, no watching, no error.
import { readdirSync, statSync, mkdirSync, appendFileSync, writeFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { TranscriptWatcher, WatcherOptions, WatcherSource, WatcherStatus } from '../contract/index.js';
import { loadCheckpoints, saveCheckpoints, type CheckpointTable } from './checkpoint.js';

const TAIL = 64;
const tailHash = (buf: Buffer, offset: number): string =>
  createHash('sha256').update(buf.subarray(Math.max(0, offset - TAIL), offset)).digest('hex');

/** Ranged read — the scan's ONLY content-read primitive (2026-08-09 churn
 * fix: a steady-state tick must read changed bytes, never whole files). A
 * short read (file shrank mid-scan) returns what was there; the next tick's
 * tail check catches the tear and rescans, same tolerance as before. */
function readRangeSync(filePath: string, from: number, length: number): Buffer {
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

/** OD-S2-7 spike result (2026-07-28, verified on Chris's machine):
 *  - kimi:   ~/.kimi-code           (server/events/*.jsonl; recursive covers future layouts)
 *  - claude: ~/.claude/projects     (<proj>/<session>.jsonl + <session>/subagents/agent-*.jsonl)
 *  - codex:  ~/.codex               (archived_sessions/, visualizations/, session_index.jsonl)
 *  Only EXISTING dirs are returned; unknowns logged, never assumed. */
export function defaultSources(home: string = homedir()): WatcherSource[] {
  const candidates: WatcherSource[] = [
    { provider: 'kimi', dir: path.join(home, '.kimi-code') },
    { provider: 'claude', dir: path.join(home, '.claude', 'projects') },
    { provider: 'codex', dir: path.join(home, '.codex') },
  ];
  return candidates.filter((c) => existsSync(c.dir));
}

/** Recursive *.jsonl listing (relative paths), stable order. */
function listJsonl(dir: string, prefix = ''): string[] {
  let out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const name of entries.sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) out = out.concat(listJsonl(full, rel));
    else if (name.endsWith('.jsonl')) out.push(rel);
  }
  return out;
}

export function createTranscriptWatcher(options: WatcherOptions): TranscriptWatcher {
  const intervalMs = options.intervalMs ?? 1000;
  const readRange = options.readRange ?? readRangeSync;
  const transcriptsRoot = path.join(options.root, 'transcripts');
  const stateDir = path.join(transcriptsRoot, '.state');
  let checkpoints: CheckpointTable = {};
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;
  let bytesCopied = 0;
  let lastScanAt: string | null = null;
  const tracked = new Set<string>();
  /** M6: typed per-file skip records — a bad file NEVER throws out of the scan. */
  const skips: Array<{ src: string; reason: string }> = [];

  const scanOnce = (): void => {
    if (scanning) return;
    scanning = true;
    try {
      for (const source of options.sources) {
        for (const rel of listJsonl(source.dir)) {
          const src = path.join(source.dir, rel);
          // M6: every fs op for ONE file is guarded; a failure is a typed
          // skip + continue — the interval never throws, other files copy.
          try {
            let st;
            try { st = statSync(src); } catch { continue; }
            const srcKey = src;
            const inode = `${st.dev}:${st.ino}`;
            const prev = checkpoints[srcKey];
            const destBase = path.join(transcriptsRoot, source.provider, rel);
            tracked.add(srcKey);

            // Steady state (the overwhelming majority of file-visits): same
            // inode, same size — ZERO content bytes read. The old code read
            // the whole file here every tick; at real transcript volume that
            // was GB/s of churn (the Aug 3/8 "ingester leak").
            if (prev && prev.inode === inode && st.size === prev.offset) continue;

            const rescan = (rescans: number): void => {
              const buf = st.size > 0 ? readRange(src, 0, st.size) : Buffer.alloc(0);
              const rescanDest = `${destBase.replace(/\.jsonl$/, '')}.rescan-${rescans}.jsonl`;
              mkdirSync(path.dirname(rescanDest), { recursive: true });
              if (buf.length > 0) {
                writeFileSync(rescanDest, buf);
                bytesCopied += buf.length;
              }
              checkpoints[srcKey] = { offset: st.size, inode, rescans, tail: tailHash(buf, buf.length) };
            };

            if (!prev) {
              // first sight: full copy (the one legitimate whole-file read)
              const buf = st.size > 0 ? readRange(src, 0, st.size) : Buffer.alloc(0);
              mkdirSync(path.dirname(destBase), { recursive: true });
              if (buf.length > 0) {
                appendFileSync(destBase, buf);
                bytesCopied += buf.length;
              }
              checkpoints[srcKey] = { offset: st.size, inode, rescans: 0, tail: tailHash(buf, buf.length) };
            } else if (prev.inode !== inode || st.size < prev.offset) {
              // rotation/truncation (R3-14): full re-copy into a NEW copy
              // record; the original copy is immutable; S2 tolerates
              // duplicate raws (§13.4).
              rescan(prev.rescans + 1);
            } else {
              // growth: read the TAIL-byte window before the checkpoint (the
              // regrowth-over-rewritten-bytes check) plus the delta — never
              // the whole file.
              const windowLength = Math.min(TAIL, prev.offset);
              const window = readRange(src, prev.offset - windowLength, windowLength);
              if (prev.offset > 0 && tailHash(window, window.length) !== prev.tail) {
                rescan(prev.rescans + 1);
              } else {
                const delta = readRange(src, prev.offset, st.size - prev.offset);
                mkdirSync(path.dirname(destBase), { recursive: true });
                appendFileSync(destBase, delta);
                bytesCopied += delta.length;
                // New tail window = last TAIL bytes of window+delta (their
                // concat covers [prev.offset - TAIL, st.size) — a superset of
                // [st.size - TAIL, st.size) since st.size > prev.offset).
                const joined = Buffer.concat([window, delta]);
                checkpoints[srcKey] = { ...prev, offset: st.size, tail: tailHash(joined, joined.length) };
              }
            }
          } catch (cause) {
            // typed skip: recorded once per file, surfaced via status, scan continues
            if (!skips.some((s) => s.src === src)) {
              skips.push({ src, reason: cause instanceof Error ? cause.message : String(cause) });
            }
          }
        }
      }
      lastScanAt = new Date().toISOString();
      saveCheckpoints(stateDir, checkpoints);
    } finally {
      scanning = false;
    }
  };

  return {
    async start() {
      if (timer) return;
      checkpoints = loadCheckpoints(stateDir);
      scanOnce();
      timer = setInterval(scanOnce, intervalMs);
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status(): WatcherStatus {
      return { running: timer !== null, files: tracked.size, bytesCopied, lastScanAt, skips: [...skips] };
    },
  };
}
