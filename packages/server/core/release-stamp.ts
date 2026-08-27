// packages/server/core/release-stamp.ts — which code snapshot this process is.
//
// `nvk deploy` clones the checkout into a release dir and writes release.json
// at its root. This module answers "what am I running" from the code's own
// location — the one fact the running code itself owns — so no caller has to
// thread a path in.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleaseStamp } from '../contract/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(here, '..', '..', '..');

/**
 * The three provenance states a running server can be in. `unstamped` is an
 * INTENTIONAL dev/scratch boot (no release.json exists); `corrupt` is a
 * deployment whose stamp cannot be trusted (unreadable, bad JSON, wrong
 * shape) — the two must never collapse into one, or a broken deploy
 * masquerades as a harmless dev boot.
 */
export type ReleaseStampReading =
  | { readonly state: 'stamped'; readonly release: ReleaseStamp }
  | { readonly state: 'unstamped' }
  | { readonly state: 'corrupt'; readonly reason: string };

/**
 * Read release.json at the code root and classify this process's provenance.
 * Never throws — boot must not die on a stamp problem; it reports it instead
 * (via /version and the deploy CLI's health check, which requires 'stamped'
 * with a matching commit).
 */
export function readReleaseStamp(): ReleaseStampReading {
  const file = path.join(codeRoot, 'release.json');
  if (!fs.existsSync(file)) return { state: 'unstamped' };
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (cause) {
    return { state: 'corrupt', reason: `unreadable: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'corrupt', reason: 'release.json is not valid JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { state: 'corrupt', reason: 'release.json is not an object' };
  }
  const stamp = parsed as Record<string, unknown>;
  if (typeof stamp.commit !== 'string' || typeof stamp.builtAt !== 'string') {
    return { state: 'corrupt', reason: 'release.json lacks commit/builtAt' };
  }
  return {
    state: 'stamped',
    release: {
      commit: stamp.commit,
      branch: typeof stamp.branch === 'string' ? stamp.branch : '',
      builtAt: stamp.builtAt,
      dirty: stamp.dirty === true,
      source: typeof stamp.source === 'string' ? stamp.source : '',
    },
  };
}
