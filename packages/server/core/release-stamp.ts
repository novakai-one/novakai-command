// packages/server/core/release-stamp.ts — which code snapshot this process is.
//
// `nvk deploy` clones the checkout into a release dir and writes release.json
// at its root. This module answers "what am I running" from the code's own
// location — the one fact the running code itself owns — so no caller has to
// thread a path in. A checkout with no stamp (dev/scratch boot) answers null.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReleaseStamp } from '../contract/protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const codeRoot = path.resolve(here, '..', '..', '..');

export function readReleaseStamp(): ReleaseStamp | null {
  try {
    const raw = fs.readFileSync(path.join(codeRoot, 'release.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return null;
    const stamp = parsed as Record<string, unknown>;
    if (typeof stamp.commit !== 'string' || typeof stamp.builtAt !== 'string') return null;
    return {
      commit: stamp.commit,
      branch: typeof stamp.branch === 'string' ? stamp.branch : '',
      builtAt: stamp.builtAt,
      dirty: stamp.dirty === true,
      source: typeof stamp.source === 'string' ? stamp.source : '',
    };
  } catch {
    return null;
  }
}
