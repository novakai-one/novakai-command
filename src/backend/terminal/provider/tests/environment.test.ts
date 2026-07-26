// providerEnvironment tests. Run with
// `npx tsx src/backend/terminal/provider/tests/environment.test.ts`.
import assert from 'node:assert/strict';
import { providerEnvironment } from '../index.js';

function testBindsBrowserSession(): void {
  const environment = providerEnvironment('claude', 'agent-session-123');
  assert.equal(environment.NVK_SESSION, 'agent-session-123', 'each agent gets its own browser session id');
}

function testOmitsBrowserSessionWhenUnset(): void {
  // Deterministic regardless of the runner: agent shells carry their own
  // NVK_SESSION, which providerEnvironment copies through from process.env.
  const inherited = process.env.NVK_SESSION;
  delete process.env.NVK_SESSION;
  try {
    const environment = providerEnvironment('claude');
    assert.equal(environment.NVK_SESSION, undefined, 'no browser binding when none is requested');
  } finally {
    if (inherited !== undefined) process.env.NVK_SESSION = inherited;
  }
}

function testStillScrubsProviderSecrets(): void {
  const environment = providerEnvironment('claude', 'sess');
  const leaked = Object.keys(environment).filter((envKey) => /^CLAUDE|^ANTHROPIC/.test(envKey));
  assert.deepEqual(leaked, [], 'provider secrets remain scrubbed');
}

function testPointsAgentAtOwnBackend(): void {
  delete process.env.NVK_COMMAND_URL;
  const environment = providerEnvironment('claude', 'sess', 3931);
  assert.equal(
    environment.NVK_COMMAND_URL,
    'http://127.0.0.1:3931',
    'agent tunnel points at this backend, not prod :3031',
  );
}

function testLaneLocalPrecedence(): void {
  // Audit S2 regression: a backend on 3131 whose parent environment carries
  // the Live tunnel URL must still route its agents to itself.
  process.env.NVK_COMMAND_URL = 'http://127.0.0.1:3031';
  try {
    const environment = providerEnvironment('claude', 'sess', 3131);
    assert.equal(
      environment.NVK_COMMAND_URL,
      'http://127.0.0.1:3131',
      'spawning backend port beats inherited NVK_COMMAND_URL',
    );
  } finally {
    delete process.env.NVK_COMMAND_URL;
  }
}

function testInjectsAgentTokenAlongsideAgentId(): void {
  // D-N6-2: the spawn carries its ISSUED credential (nvkt_…) in
  // NVK_AGENT_TOKEN, next to its identity in NVK_AGENT_ID.
  const environment = providerEnvironment('claude', 'sess', 3131, 'agent_abc', 'nvkt_deadbeef');
  assert.equal(environment.NVK_AGENT_ID, 'agent_abc', 'identity env unchanged');
  assert.equal(environment.NVK_AGENT_TOKEN, 'nvkt_deadbeef', 'the issued credential rides NVK_AGENT_TOKEN');
  const bare = providerEnvironment('claude', 'sess', 3131, 'agent_abc');
  assert.equal(bare.NVK_AGENT_TOKEN, undefined, 'no token, no env (plain/runtime spawns)');
}

testBindsBrowserSession();
testOmitsBrowserSessionWhenUnset();
testStillScrubsProviderSecrets();
testPointsAgentAtOwnBackend();
testLaneLocalPrecedence();
testInjectsAgentTokenAlongsideAgentId();
console.log('PASS');
