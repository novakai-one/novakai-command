#!/usr/bin/env node
// tools/demo.mjs — start the real-backend bridge + vite dev server together.
// Usage: cd packages/shell && npm run demo
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(shellRoot, 'node_modules', '.bin', 'tsx');

const procs = [];
function run(name, cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
  p.on('exit', (code) => { console.log(`[demo] ${name} exited (${code})`); shutdown(code ?? 0); });
  procs.push(p);
  return p;
}
function shutdown(code) {
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('bridge', tsx, [path.join(shellRoot, 'demo', 'bridge.ts')], shellRoot);
run('vite', path.join(shellRoot, 'node_modules', '.bin', 'vite'), ['--host', '127.0.0.1'], shellRoot);

console.log('[demo] open http://127.0.0.1:5180 — messaging runs on the REAL packages/messaging backend');
