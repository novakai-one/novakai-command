#!/usr/bin/env node
// tools/lint-accent.mjs — SHL-010 / DEC-S5: at most ONE attention signal
// (accent token) per composed viewport. Liveness tokens (--sage, --live-*)
// are explicitly NOT signals and are excluded (R3-25).
//
// Rule enforced statically: outside ui/kit/tokens.css (the definition site)
// and ui/kit/kit.css (the shared stylesheet), the string "--accent" may appear
// AT MOST ONCE across frame + screens — the single rail attention marker.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['ui/frame', 'ui/screens', 'ui/App.tsx'];
const ALLOWED = 1;

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) { for (const f of readdirSync(p)) yield* walk(path.join(p, f)); }
  else if (/\.(tsx?|css)$/.test(p)) yield p;
}

let count = 0;
const hits = [];
for (const r of roots) {
  for (const f of walk(path.join(shellRoot, r))) {
    const src = readFileSync(f, 'utf8');
    const n = (src.match(/--accent/g) ?? []).length;
    if (n > 0) hits.push(`${path.relative(shellRoot, f)}: ${n}`);
    count += n;
  }
}

if (count > ALLOWED) {
  console.error(`ACCENT GATE FAILED: --accent used ${count}× in the composed viewport (max ${ALLOWED}).`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`Accent gate green — --accent used ${count}× in the composed viewport (max ${ALLOWED}).`);
