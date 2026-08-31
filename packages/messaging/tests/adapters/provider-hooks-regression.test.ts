import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { agentIdentityHookCommand } from '../../adapters/provider-hooks/agent-identity-hook.js';
import { ensureClaudeIdentityHook } from '../../adapters/provider-hooks/registrations/claude.js';
import { ensureCodexIdentityHook } from '../../adapters/provider-hooks/registrations/codex.js';
import { ensureKimiIdentityHook } from '../../adapters/provider-hooks/registrations/kimi.js';
import { providerNormalizer } from '../../adapters/provider-transcripts/normalizers/index.js';
import { findAgentIdentityMarker } from '../../contract/agent-identity.js';
import type { ProviderLineExtent } from '../../contract/ports/provider-transcript-source.js';

const marker = {
  kind: 'novakai-agent-identity' as const,
  schemaVersion: 1 as const,
  hookEvent: 'UserPromptSubmit' as const,
  agentId: 'agent_hook-regression',
};

function normalize(provider: 'claude' | 'codex' | 'kimi', row: unknown) {
  const raw = JSON.stringify(row);
  const extent: ProviderLineExtent = {
    raw,
    offset: 0,
    nextOffset: Buffer.byteLength(raw) + 1,
  };
  return providerNormalizer(provider).normalize(extent, 0);
}

test('identity hook is a silent success outside Novakai and emits plain marker evidence inside', () => {
  const command = agentIdentityHookCommand();
  const outside = spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '' },
  });
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, '');
  assert.equal(outside.stderr, '');

  const inside = spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, NOVAKAI_AGENT_ID: marker.agentId },
  });
  assert.equal(inside.status, 0);
  assert.match(inside.stdout, /^NOVAKAI_AGENT_IDENTITY /u);
  assert.deepEqual(findAgentIdentityMarker(inside.stdout), marker);

  const owned = spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NOVAKAI_AGENT_ID: marker.agentId,
      NOVAKAI_STORE_ID: 'store_11111111-1111-4111-8111-111111111111',
    },
  });
  assert.equal(owned.status, 0);
  assert.deepEqual(findAgentIdentityMarker(owned.stdout), {
    ...marker,
    schemaVersion: 2,
    storeId: 'store_11111111-1111-4111-8111-111111111111',
  });
});

test('provider hook registration replaces stale Novakai copies and preserves unrelated hooks', async () => {
  const providerHome = await mkdtemp(path.join(tmpdir(), 'nvk-hook-reconcile-'));
  const staleA = "node -e 'NOVAKAI_AGENT_ID novakai-agent-identity old-a'";
  const staleB = "node -e 'NOVAKAI_AGENT_ID novakai-agent-identity old-b'";
  const unrelated = 'echo keep-me';
  const jsonConfig = {
    hooks: {
      UserPromptSubmit: [staleA, unrelated, staleB].map((command) => ({
        hooks: [{ type: 'command', command }],
      })),
    },
  };
  await mkdir(path.join(providerHome, '.claude'), { recursive: true });
  await mkdir(path.join(providerHome, '.codex'), { recursive: true });
  await mkdir(path.join(providerHome, '.kimi-code'), { recursive: true });
  await writeFile(
    path.join(providerHome, '.claude', 'settings.json'),
    JSON.stringify(jsonConfig),
  );
  await writeFile(
    path.join(providerHome, '.codex', 'hooks.json'),
    JSON.stringify(jsonConfig),
  );
  await writeFile(path.join(providerHome, '.kimi-code', 'config.toml'), [
    '[[hooks]]', 'event = "UserPromptSubmit"', `command = ${JSON.stringify(staleA)}`, '',
    '[[hooks]]', 'event = "UserPromptSubmit"', `command = ${JSON.stringify(unrelated)}`, '',
    '[[hooks]]', 'event = "UserPromptSubmit"', `command = ${JSON.stringify(staleB)}`, '',
  ].join('\n'));

  const command = agentIdentityHookCommand();
  await ensureClaudeIdentityHook({ providerHome, command });
  await ensureCodexIdentityHook({ providerHome, command });
  await ensureKimiIdentityHook({ providerHome, command });

  for (const relative of ['.claude/settings.json', '.codex/hooks.json']) {
    const config = JSON.parse(await readFile(path.join(providerHome, relative), 'utf8'));
    const commands = config.hooks.UserPromptSubmit.flatMap(
      (entry: { hooks: Array<{ command: string }> }) => entry.hooks.map((hook) => hook.command),
    );
    assert.deepEqual(commands.filter((value: string) => value.includes('NOVAKAI_AGENT_ID')), [command]);
    assert.ok(commands.includes(unrelated));
  }
  const kimi = await readFile(path.join(providerHome, '.kimi-code', 'config.toml'), 'utf8');
  assert.equal((kimi.match(/novakai-agent-identity/gu) ?? []).length, 1);
  assert.match(kimi, /echo keep-me/u);
});

test('real provider hook wrappers normalize to hidden Agent identity evidence', () => {
  const evidence = `NOVAKAI_AGENT_IDENTITY ${JSON.stringify(marker)}`;
  const candidates = [
    normalize('claude', {
      type: 'attachment',
      sessionId: 'claude-session',
      attachment: {
        type: 'hook_success', hookEvent: 'UserPromptSubmit', content: evidence, stdout: `${evidence}\n`,
      },
    }),
    normalize('codex', {
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: evidence }] },
    }),
    normalize('kimi', {
      type: 'context.append_message',
      message: {
        role: 'user',
        content: [{ type: 'text', text: `<hook_result hook_event="UserPromptSubmit">${evidence}</hook_result>` }],
      },
    }),
  ];
  for (const candidate of candidates) {
    assert.equal(candidate.role, 'hook');
    assert.deepEqual(candidate.agentIdentity, marker);
  }
});
