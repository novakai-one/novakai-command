// kimiCliRuntime tests — the DEMO-SCOPED TerminalRuntimeLike that drives the
// real `kimi` CLI in print mode. Unit cases use a fake local CLI script (no
// network, no install); the real round-trip is skip-guarded on the CLI being
// installed (machines without it stay green).
import { existsSync } from 'node:fs';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  describe, expect, it, vi,
} from 'vitest';
import { createKimiCliRuntime, defaultKimiCliPath } from '../demo/kimiCliRuntime.js';

/** A fake `kimi` CLI: emits one assistant chunk + the resume-hint meta line. */
function fakeCli(body = 'FAKE-PONG'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'kimi-fake-'));
  const p = path.join(dir, 'kimi');
  writeFileSync(p, [
    '#!/bin/sh',
    `printf '%s\\n' '{"role":"assistant","content":"${body}"}'`,
    `printf '%s\\n' '{"role":"meta","type":"session.resume_hint","session_id":"session_fake","command":"","content":""}'`,
    '',
  ].join('\n'));
  chmodSync(p, 0o755);
  return p;
}

describe('kimiCliRuntime (unit, fake CLI)', () => {
  it('create/list/kill lifecycle with onExit fired once', async () => {
    const rt = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fakeCli() });
    expect(rt.isAvailable()).toBe(true);
    const info = await rt.create({ agentId: 'a1', cwd: process.cwd(), title: 't' });
    expect(info).toMatchObject({ agentId: 'a1', status: 'running' });
    expect(rt.list().map((a) => a.agentId)).toContain('a1');
    const exits: string[] = [];
    rt.onExit((id, code) => exits.push(`${id}:${code}`));
    expect(rt.kill('a1')).toBe(true);
    expect(rt.kill('a1')).toBe(true); // idempotent
    expect(exits).toEqual(['a1:null']);
    expect(rt.list().find((a) => a.agentId === 'a1')?.status).toBe('exited');
  });

  it('write streams the assistant reply through onData', async () => {
    const rt = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fakeCli() });
    const chunks: string[] = [];
    rt.onData((_id, d) => chunks.push(d));
    await rt.create({ agentId: 'a2', cwd: process.cwd() });
    expect(rt.write('a2', 'hello')).toBe(true);
    await vi.waitFor(() => expect(chunks).toContain('FAKE-PONG'), { timeout: 5000 });
    rt.kill('a2');
  });

  it('write to an unknown or exited session returns false', async () => {
    const rt = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fakeCli() });
    expect(rt.write('nope', 'hi')).toBe(false);
    await rt.create({ agentId: 'a3', cwd: process.cwd() });
    rt.kill('a3');
    expect(rt.write('a3', 'hi')).toBe(false);
    expect(rt.kill('never-existed')).toBe(false);
  });

  it('create with a duplicate agentId throws (terminal registry rule)', async () => {
    const rt = createKimiCliRuntime({ cwd: process.cwd(), cliPath: fakeCli() });
    await rt.create({ agentId: 'dup', cwd: process.cwd() });
    await expect(rt.create({ agentId: 'dup', cwd: process.cwd() })).rejects.toThrow(/dup/);
  });

  it('create throws loudly when the CLI is missing (typed provider_error path)', async () => {
    const rt = createKimiCliRuntime({ cwd: process.cwd(), cliPath: '/nonexistent/kimi' });
    expect(rt.isAvailable()).toBe(false);
    await expect(rt.create({ agentId: 'gone', cwd: process.cwd() })).rejects.toThrow(/not found/);
  });
});

const cliPath = defaultKimiCliPath();
const hasCli = existsSync(cliPath);

describe.skipIf(!hasCli)('kimiCliRuntime (REAL kimi CLI integration)', () => {
  it('round-trips a real prompt and preserves context across two messages', async () => {
    const rt = createKimiCliRuntime({ cwd: process.cwd() });
    expect(rt.isAvailable()).toBe(true);
    const chunks: string[] = [];
    rt.onData((_id, d) => chunks.push(d));
    await rt.create({ agentId: 'it_agent', cwd: process.cwd(), title: 'integration' });

    expect(rt.write('it_agent', 'Remember the codeword PONG7. Reply with just OK.')).toBe(true);
    await vi.waitFor(() => expect(chunks.join('')).toMatch(/OK/), { timeout: 90000, interval: 500 });

    chunks.length = 0;
    expect(rt.write('it_agent', 'What is the codeword? Reply with just the codeword.')).toBe(true);
    await vi.waitFor(() => expect(chunks.join('')).toContain('PONG7'), { timeout: 90000, interval: 500 });

    rt.kill('it_agent');
  }, 200_000);
});

describe('kimiCliRuntime — S2a skills pass-through (§22 ruling 5)', () => {
  it('create argv is prepended to the CLI invocation (kimi native --skills-dir mechanism)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kimi-args-'));
    const p = path.join(dir, 'kimi');
    writeFileSync(p, [
      '#!/bin/sh',
      'printf \'%s\\n\' "{\\"role\\":\\"assistant\\",\\"content\\":\\"ARGS:$*\\"}"',
      '',
    ].join('\n'));
    chmodSync(p, 0o755);
    const rt = createKimiCliRuntime({ cwd: process.cwd(), cliPath: p });
    const chunks: string[] = [];
    rt.onData((_id, d) => chunks.push(d));
    await rt.create({
      agentId: 'sk1', cwd: process.cwd(),
      argv: ['--skills-dir', '/tmp/novakai-skills/tdd'],
    });
    rt.write('sk1', 'hello');
    await vi.waitFor(() => expect(chunks.join('')).toContain('--skills-dir /tmp/novakai-skills/tdd'), { timeout: 5000 });
    rt.kill('sk1');
  });
});
