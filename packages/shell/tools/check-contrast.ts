// tools/check-contrast.ts — SHL-009 / law 18/18a: contrast is CHECKED, not
// assumed. Computes every ink/ground/accent pair for BOTH themes from the
// single token source (contract/contrast.ts) and fails below AA.
// Run: npm run test:contrast
import { THEMES, themePairs, contrastRatio } from '../contract/contrast.js';

let failures = 0;
let total = 0;
for (const theme of Object.values(THEMES)) {
  for (const p of themePairs(theme)) {
    total++;
    const ratio = contrastRatio(p.fg, p.bg);
    const pass = ratio >= p.floor;
    if (!pass) failures++;
    console.log(`${pass ? '✓' : '✗'} [${theme.name}] ${p.label.padEnd(30)} ${ratio.toFixed(2)}:1 (floor ${p.floor}:1)`);
  }
}
if (failures > 0) {
  console.error(`\nCONTRAST GATE FAILED: ${failures} pair(s) below floor.`);
  process.exit(1);
}
console.log(`\nContrast gate green — ${total} pairs across both themes ≥ AA.`);
