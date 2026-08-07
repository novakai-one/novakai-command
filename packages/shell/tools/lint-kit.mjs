#!/usr/bin/env node
// tools/lint-kit.mjs — red gate 3 (B): screens compose KIT components, nothing
// else. F2 (S2 audit): coverage expanded to ALL of ui/screens/** + ui/inspector/**.
//
// Rule: no raw lowercase JSX intrinsic elements (button, input, select, div,
// span, h1..h6, dl/dt/dd, blockquote, pre, ...) in the covered files —
// everything comes from ui/kit (or React fragments).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COVERED = ['ui/screens', 'ui/inspector'];
const RAW_TAG = /<\s*(button|input|select|textarea|option|div|span|h[1-6]|p|label|ul|ol|li|section|header|footer|form|a|img|main|aside|nav|table|thead|tbody|tr|td|th|dl|dt|dd|blockquote|pre)\b/;

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) { for (const f of readdirSync(p)) yield* walk(path.join(p, f)); }
  else if (/\.tsx$/.test(p)) yield p;
}

let failed = false;
let checked = 0;
for (const rel of COVERED) {
  const dir = path.join(shellRoot, rel);
  if (!existsSync(dir)) {
    console.error(`KIT GATE FAILED: covered path ${rel} does not exist`);
    failed = true;
    continue;
  }
  for (const f of walk(dir)) {
    checked += 1;
    const src = readFileSync(f, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(RAW_TAG);
      if (m) {
        console.error(`  ${path.relative(shellRoot, f)}:${i + 1} raw <${m[1]}> — compose ui/kit instead (red gate 3)`);
        failed = true;
      }
    });
  }
}

if (failed) process.exit(1);
console.log(`KIT GATE GREEN — ${checked} screen/inspector file(s) compose kit components only.`);
