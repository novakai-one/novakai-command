// §18.1's inventory puts `config.jsonl` in `.novakai/stores/`, like every other
// registered kind — and §25-B3c's persistence law is "no Novakai JSONL file is
// written outside `.novakai/stores/`".
//
// The config store opens its handle with no `dataRoot`, so it writes
// `.novakai/config.jsonl` AND drags its engine's `.novakai/traces.jsonl` out
// with it: two record journals on a route no B3 handle reads. `nvk token mint`
// and `nvk-server` are the two production commands that open it, so a root that
// has ever minted a token is already outside the law before the Runtime starts.
//
// The existing inventory test misses this because it never opens the config
// store — it walks a root built entirely from capability calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openConfigStore } from '../../contract/index.js';

/** Every `.jsonl` under a root, as paths relative to it. */
function jsonlFiles(root: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const name of readdirSync(path.join(root, prefix))) {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(path.join(root, relative)).isDirectory()) {
      found.push(...jsonlFiles(root, relative));
    } else if (name.endsWith('.jsonl')) {
      found.push(relative);
    }
  }
  return found;
}

test('opening the config store writes no JSONL outside the canonical dataRoot', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3c-config-route-'));
  try {
    // Exactly what `nvk token mint` and `nvk-server` do on first boot: open the
    // store, which materialises the default config objects.
    const opened = await openConfigStore({ root, principal: 'sys_spine' });
    assert.equal(opened.ok, true, opened.ok ? '' : opened.error.code);

    const outside = jsonlFiles(root).filter((file) => !file.startsWith('stores/'));
    assert.deepEqual(outside, [],
      `Novakai JSONL records outside .novakai/stores/: ${outside.join(', ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
