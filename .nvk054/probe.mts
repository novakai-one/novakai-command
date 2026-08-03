import { readFileSync } from 'node:fs';
import { plainText } from '../packages/agent-runtime/core/gate-screen.js';
const raw = readFileSync('/tmp/nvk-048/out/repro-9DE2C59E-turn1.pty.txt', 'utf8');
const plain = plainText(raw);
for (const n of ['aJSONrray', 'thet kens', 'tkens', 'the m ker', 'm ker', 'JSONrray']) {
  const k = plain.indexOf(n);
  console.log(`${JSON.stringify(n)} -> ${k >= 0 ? 'PRESENT @' + k : 'absent'}`);
}
const k = plain.indexOf('JSONrray');
if (k >= 0) {
  console.log('\n--- corrupted region (plainText output) ---');
  console.log(JSON.stringify(plain.slice(k - 70, k + 170)));
}
