// core/watcher — TRN-001 copy-only watchers (DEC-S2-10).
//
// Custody law:
//  - copy-only into .novakai/transcripts/<provider>/<relative path>;
//  - raw copies are IMMUTABLE once written (ruling 6) — appended source bytes
//    are appended to the copy; a rotated/truncated source becomes a NEW
//    `.rescan-<n>` copy record, the original is never touched;
//  - byte-offset checkpoints in .novakai/transcripts/.state/ (R3-14);
//  - watch-while-running ONLY (OD-D1): no start, no watching, no error.
import { readdirSync, statSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import type { TranscriptWatcher, WatcherOptions, WatcherSource, WatcherStatus } from '../contract/index.js';
import { loadCheckpoints, saveCheckpoints, type CheckpointTable } from './checkpoint.js';

const TAIL = 64;
const tailHash = (buf: Buffer, offset: number): string =>
  createHash('sha256').update(buf.subarray(Math.max(0, offset - TAIL), offset)).digest('hex');

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
  const transcriptsRoot = path.join(options.root, 'transcripts');
  const stateDir = path.join(transcriptsRoot, '.state');
  let checkpoints: CheckpointTable = {};
  let timer: ReturnType<typeof setInterval> | null = null;
  let scanning = false;
  let bytesCopied = 0;
  let lastScanAt: string | null = null;
  const tracked = new Set<string>();

  const scanOnce = (): void => {
    if (scanning) return;
    scanning = true;
    try {
      for (const source of options.sources) {
        for (const rel of listJsonl(source.dir)) {
          const src = path.join(source.dir, rel);
          let st;
          try { st = statSync(src); } catch { continue; }
          const srcKey = src;
          const inode = `${st.dev}:${st.ino}`;
          const prev = checkpoints[srcKey];
          const destBase = path.join(transcriptsRoot, source.provider, rel);
          tracked.add(srcKey);
          const buf = st.size > 0 ? readFileSync(src) : Buffer.alloc(0);

          const rescan = (rescans: number): void => {
            const rescanDest = `${destBase.replace(/\.jsonl$/, '')}.rescan-${rescans}.jsonl`;
            mkdirSync(path.dirname(rescanDest), { recursive: true });
            if (st.size > 0) {
              writeFileSync(rescanDest, buf);
              bytesCopied += st.size;
            }
            checkpoints[srcKey] = { offset: st.size, inode, rescans, tail: tailHash(buf, st.size) };
          };

          if (!prev) {
            // first sight: full copy
            if (st.size > 0) {
              mkdirSync(path.dirname(destBase), { recursive: true });
              appendFileSync(destBase, buf);
              bytesCopied += st.size;
            } else mkdirSync(path.dirname(destBase), { recursive: true });
            checkpoints[srcKey] = { offset: st.size, inode, rescans: 0, tail: tailHash(buf, st.size) };
          } else if (
            prev.inode !== inode
            || st.size < prev.offset
            || (st.size > prev.offset && prev.offset > 0 && tailHash(buf, prev.offset) !== prev.tail)
          ) {
            // rotation/truncation/regrowth-over-rewritten-bytes (R3-14): full
            // re-copy into a NEW copy record; the original copy is immutable;
            // S2 tolerates duplicate raws (§13.4).
            rescan(prev.rescans + 1);
          } else if (st.size > prev.offset) {
            mkdirSync(path.dirname(destBase), { recursive: true });
            appendFileSync(destBase, buf.subarray(prev.offset, st.size));
            bytesCopied += st.size - prev.offset;
            checkpoints[srcKey] = { ...prev, offset: st.size, tail: tailHash(buf, st.size) };
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
      return { running: timer !== null, files: tracked.size, bytesCopied, lastScanAt };
    },
  };
}
