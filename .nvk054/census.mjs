import { readFileSync } from 'node:fs';

const ESC = '';
const files = {
  'claude-9DE2C59E': '/tmp/nvk-048/out/repro-9DE2C59E-turn1.pty.txt',
  'claude-554F51D9': '/tmp/nvk-048/out/repro-554F51D9-turn1.pty.txt',
  'claude-8AEE7091': '/tmp/nvk-048/out/repro-8AEE7091-turn1.pty.txt',
  'kimi-fresh': '/tmp/nvk-048/out/D-kimi-fresh.pty.log',
  'codex-fresh': '/tmp/nvk-048/out/C-codex-fresh.pty.log',
  'kimi-fixture': 'packages/agents/b3/tests/fixtures/kimi-gate-screen.txt',
};

for (const [name, p] of Object.entries(files)) {
  let raw;
  try { raw = readFileSync(p, 'utf8'); } catch { console.log(name, 'MISSING'); continue; }
  const counts = new Map();
  const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);

  const csi = new RegExp(`${ESC}\\[([0-9;?<>=]*)([\\x20-\\x2F]*)([@-~])`, 'gu');
  for (const m of raw.matchAll(csi)) bump(`CSI ${m[1].replace(/\d+/gu, 'n')}${m[2]}${m[3]}`);

  const other = new RegExp(`${ESC}([^\\[\\]])`, 'gu');
  for (const m of raw.matchAll(other)) bump(`ESC ${JSON.stringify(m[1])}`);

  counts.set('*bare CR*', (raw.match(/\r(?!\n)/gu) ?? []).length);
  counts.set('*backspace*', (raw.match(//gu) ?? []).length);
  counts.set('*unmatched ESC[*', (raw.match(new RegExp(`${ESC}\\[(?![0-9;?<>=]*[\\x20-\\x2F]*[@-~])`, 'gu')) ?? []).length);

  console.log(`\n=== ${name} (${raw.length}B) ===`);
  console.log([...counts].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, v]) => `${String(v).padStart(6)}  ${k}`).join('\n'));
}
