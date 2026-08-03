import { createRunsRig } from '../packages/agent-runtime/tests/runs-harness.js';
import { plainText, sinceTheQuestion, withoutOurOwnWords } from '../packages/agent-runtime/core/gate-screen.js';
import { findMarkerLine } from '../packages/agents/b3/adapters/providers/turn-delivery.js';

const rig = createRunsRig({ gateTimeoutMs: 900 });
rig.terminal.reflowColumns = 120;
rig.terminal.repaintAnswer = true;
const role = rig.agents.defineRole('governed');
const r = await rig.runtime.spawnAgent(rig.human(), {
  roleProfileId: role, displayName: 'Governed', workingDirectory: '/tmp/work',
  task: { kind: 'supervised' as const, brief: 'Reply OK.' },
});
console.log('spawn ok?', r.ok, r.ok ? '' : r.error.message);
console.log('pinnedTokens', rig.terminal.pinnedTokens);
const out = rig.terminal.output;
const k = out.indexOf('thinking...');
console.log('\n--- RAW tail from thinking ---');
console.log(JSON.stringify(out.slice(k, k + 400)));
console.log('\n--- plainText tail ---');
const p = plainText(out);
const k2 = p.indexOf('thinking...');
console.log(JSON.stringify(p.slice(k2, k2 + 300)));
console.log('\n--- findMarkerLine on plainText ---');
console.log(JSON.stringify(findMarkerLine(p, 'SKILLS-CONFIRMED:')));
rig.close();
