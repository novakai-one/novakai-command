// A fake `kimi` executable that speaks the REAL stream-json shape verified
// against kimi 0.29.1 (2026-07-28), so boot tests exercise the actual adapter
// argv/resume path without spending provider turns.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FakeKimi {
  cliPath: string;
  invocations(): string[][];
}

export function fakeKimi(options: {
  reply?: string;
  sessionId?: string;
  delayMs?: number;
  providerHome?: string;
} = {}): FakeKimi {
  const dir = mkdtempSync(path.join(tmpdir(), 'fake-kimi-boot-'));
  const cliPath = path.join(dir, 'kimi');
  const logPath = path.join(dir, 'invocations.log');
  const reply = options.reply ?? 'ack from fake kimi';
  const sessionId = options.sessionId ?? 'session_fake_boot';
  const transcriptPath = options.providerHome === undefined
    ? null
    : path.join(options.providerHome, '.kimi-code', 'sessions', `${sessionId}.jsonl`);
  writeFileSync(cliPath, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
setTimeout(() => {
  const marker = process.env.NOVAKAI_AGENT_ID ? {
    kind: 'novakai-agent-identity', schemaVersion: 1,
    hookEvent: 'UserPromptSubmit', agentId: process.env.NOVAKAI_AGENT_ID,
  } : null;
  const transcriptPath = ${JSON.stringify(transcriptPath)};
  if (transcriptPath) {
    fs.mkdirSync(require('node:path').dirname(transcriptPath), { recursive: true });
    const promptIndex = process.argv.indexOf('-p');
    const rows = [
      ...(marker ? [{ message: { role: 'system', content: '<hook_result hook_event="UserPromptSubmit">' + JSON.stringify(marker) + '</hook_result>' } }] : []),
      { id: 'user-' + Date.now(), timestamp: new Date().toISOString(), message: { role: 'user', content: process.argv[promptIndex + 1] } },
      { id: 'assistant-' + Date.now(), timestamp: new Date().toISOString(), message: { role: 'assistant', content: ${JSON.stringify(reply)} } },
    ];
    fs.appendFileSync(transcriptPath, rows.map((row) => JSON.stringify(row)).join('\\n') + '\\n');
  }
  process.stdout.write(JSON.stringify({ role: 'assistant', content: ${JSON.stringify(reply)} }) + '\\n');
  process.stdout.write(JSON.stringify({ role: 'meta', type: 'session.resume_hint', session_id: ${JSON.stringify(sessionId)} }) + '\\n');
}, ${options.delayMs ?? 0});
`);
  chmodSync(cliPath, 0o755);
  return {
    cliPath,
    invocations: () => (existsSync(logPath)
      ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : []),
  };
}
