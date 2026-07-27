#!/usr/bin/env node
// tools/check-contrast.mjs — SHL-009 / law 18/18a: contrast is CHECKED, not
// assumed. Computes every ink/ground/accent pair for BOTH themes from the
// token source of truth (contract/contrast.ts) and fails below AA.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Evaluate the TS token module via vitest's esbuild (no separate build step).
const script = `
  import { THEMES, auditTheme, themePairs, contrastRatio } from './contract/contrast.ts';
  const out = [];
  let failures = 0;
  for (const theme of Object.values(THEMES)) {
    for (const p of themePairs(theme)) {
      const ratio = contrastRatio(p.fg, p.bg);
      const pass = ratio >= p.floor;
      if (!pass) failures++;
      out.push({ theme: theme.name, pair: p.label, ratio: Number(ratio.toFixed(2)), floor: p.floor, pass });
    }
  }
  console.log(JSON.stringify({ pairs: out, failures }));
`;
const raw = execFileSync(
  path.join(shellRoot, 'node_modules', '.bin', 'tsx'),
  ['-e', script],
  { cwd: shellRoot, encoding: 'utf8' },
);
const { pairs, failures } = JSON.parse(raw.trim().split('\n').pop());

for (const p of pairs) {
  const mark = p.pass ? '✓' : '✗';
  console.log(`${mark} [${p.theme}] ${p.pair.padEnd(28)} ${p.ratio}:1 (floor ${p.floor}:1)`);
}
if (failures > 0) {
  console.error(`\nCONTRAST GATE FAILED: ${failures} pair(s) below floor.`);
  process.exit(1);
}
console.log(`\nContrast gate green — ${pairs.length} pairs across both themes ≥ AA.`);
