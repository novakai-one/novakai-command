/**
 * Finding each provider's own transcript — §8.2, §27, exam rows C1/C3-kimi.
 *
 * The exam typed a real human turn into a real kimi PTY and read back
 * `{"count":0,"exactPromptMatches":0,"texts":[]}` and `{"mirrored":[]}` while
 * the claude leg passed. A human turn needs no model reply, so nothing about
 * that is environmental — and the turn WAS delivered: the exam's own kimi
 * session file on this machine holds it.
 *
 *   ~/.kimi-code/sessions/wd_nvk-holdout-b3c_…/session_192bb829-…/
 *       agents/main/wire.jsonl   ← {"type":"turn.prompt", …NVKHO16206315HKI…}
 *
 * The locator never found it. claude and codex name the transcript FILE after
 * the session (`<native>.jsonl`, `rollout-<iso>-<native>.jsonl`); kimi names a
 * DIRECTORY after it and calls the file inside `wire.jsonl`. Matching only on
 * the basename can never see that, so every kimi binding stayed `waiting`
 * forever and the mirror had nothing to read.
 *
 * These trees are built here rather than read from a real provider home: a
 * test that depends on what happens to be in `~/.kimi-code` proves nothing on
 * anyone else's machine.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createProviderFileLocator } from '../adapters/locate-provider-file.js';
import type { TranscriptBinding } from '../contract/records.js';

const NATIVE = '192bb829-5e56-4e01-befd-53369e49c890';

const bindingFor = (provider: string): TranscriptBinding => ({
  id: `transcriptBinding_${provider}`,
  provider,
} as unknown as TranscriptBinding);

function write(file: string, contents: string): string {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, contents, 'utf8');
  return file;
}

test('kimi: the transcript is inside the session directory, not named after it', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nvk-locate-kimi-'));
  try {
    const session = path.join(home, 'sessions', 'wd_project_abc123', `session_${NATIVE}`);
    write(path.join(session, 'state.json'), '{}');
    const wire = write(
      path.join(session, 'agents', 'main', 'wire.jsonl'),
      `${JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'hello' }] })}\n`,
    );
    // A sibling session that must never be confused for this one.
    write(
      path.join(home, 'sessions', 'wd_project_abc123',
        'session_00000000-0000-4000-8000-000000000000', 'agents', 'main', 'wire.jsonl'),
      '{}\n',
    );

    const locate = createProviderFileLocator({
      homes: { kimi: home },
      async nativeSessionIdOf() { return NATIVE; },
    });
    assert.equal(await locate(bindingFor('kimi')), wire,
      'a kimi binding cannot find the transcript its own session directory holds');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('kimi: a subagent transcript is never mistaken for the main one', async () => {
  // kimi gives every native subagent its own `agents/<id>/wire.jsonl`. The
  // Run's transcript is `agents/main`, and picking any other one would mirror
  // somebody else's conversation into this Agent's thread.
  const home = mkdtempSync(path.join(tmpdir(), 'nvk-locate-kimi-sub-'));
  try {
    const session = path.join(home, 'sessions', 'wd_project_abc123', `session_${NATIVE}`);
    write(path.join(session, 'agents', '0f1e2d3c', 'wire.jsonl'), '{"sub":true}\n');
    const wire = write(path.join(session, 'agents', 'main', 'wire.jsonl'), '{"main":true}\n');

    const locate = createProviderFileLocator({
      homes: { kimi: home },
      async nativeSessionIdOf() { return NATIVE; },
    });
    assert.equal(await locate(bindingFor('kimi')), wire);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('kimi: a session directory with no transcript yet is waiting, not wrong', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nvk-locate-kimi-empty-'));
  try {
    write(
      path.join(home, 'sessions', 'wd_project_abc123', `session_${NATIVE}`, 'state.json'), '{}',
    );
    const locate = createProviderFileLocator({
      homes: { kimi: home },
      async nativeSessionIdOf() { return NATIVE; },
    });
    assert.equal(await locate(bindingFor('kimi')), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('claude and codex still find the file their own layouts name', async () => {
  const claudeHome = mkdtempSync(path.join(tmpdir(), 'nvk-locate-claude-'));
  const codexHome = mkdtempSync(path.join(tmpdir(), 'nvk-locate-codex-'));
  try {
    const claudeFile = write(
      path.join(claudeHome, '-private-tmp-project', `${NATIVE}.jsonl`), '{}\n',
    );
    const codexFile = write(
      path.join(codexHome, 'sessions', '2026', '08', '03',
        `rollout-2026-08-03T03-07-40-${NATIVE}.jsonl`), '{}\n',
    );
    const locate = createProviderFileLocator({
      homes: { claude: claudeHome, codex: codexHome },
      async nativeSessionIdOf() { return NATIVE; },
    });
    assert.equal(await locate(bindingFor('claude')), claudeFile);
    assert.equal(await locate(bindingFor('codex')), codexFile);
  } finally {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
});

test('a session that has not been discovered yet locates nothing', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'nvk-locate-none-'));
  try {
    const locate = createProviderFileLocator({
      homes: { kimi: home, claude: home, codex: home },
      async nativeSessionIdOf() { return null; },
    });
    for (const provider of ['kimi', 'claude', 'codex']) {
      assert.equal(await locate(bindingFor(provider)), null);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
