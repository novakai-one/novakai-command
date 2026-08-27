import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveCliPath } from '../core/providers/cli.js';
import { defaultKimiCliPath } from '../core/providers/kimi.js';

const restoreEnv = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

test('launchd-style PATH discovers an npm-global provider CLI inside NVM', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-provider-nvm-'));
  const emptyPath = path.join(root, 'minimal-path');
  const olderBin = path.join(root, 'versions', 'node', 'v22.14.0', 'bin');
  const currentBin = path.join(root, 'versions', 'node', 'v24.13.0', 'bin');
  const codex = path.join(currentBin, 'codex');
  mkdirSync(emptyPath, { recursive: true });
  mkdirSync(olderBin, { recursive: true });
  mkdirSync(currentBin, { recursive: true });
  writeFileSync(path.join(olderBin, 'codex'), 'older');
  writeFileSync(codex, 'current');

  const priorPath = process.env.PATH;
  const priorNvmDir = process.env.NVM_DIR;
  try {
    process.env.PATH = emptyPath;
    process.env.NVM_DIR = root;
    assert.equal(resolveCliPath('codex'), codex);
  } finally {
    restoreEnv('PATH', priorPath);
    restoreEnv('NVM_DIR', priorNvmDir);
  }
});

test('PATH remains authoritative when it contains the provider CLI', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-provider-path-'));
  const pathBin = path.join(root, 'path-bin');
  const nvmBin = path.join(root, 'nvm', 'versions', 'node', 'v24.13.0', 'bin');
  const fromPath = path.join(pathBin, 'codex');
  mkdirSync(pathBin, { recursive: true });
  mkdirSync(nvmBin, { recursive: true });
  writeFileSync(fromPath, 'path');
  writeFileSync(path.join(nvmBin, 'codex'), 'nvm');

  const priorPath = process.env.PATH;
  const priorNvmDir = process.env.NVM_DIR;
  try {
    process.env.PATH = pathBin;
    process.env.NVM_DIR = path.join(root, 'nvm');
    assert.equal(resolveCliPath('codex'), fromPath);
  } finally {
    restoreEnv('PATH', priorPath);
    restoreEnv('NVM_DIR', priorNvmDir);
  }
});

test('Kimi discovery stays independent of PATH', () => {
  assert.match(defaultKimiCliPath(), /\.kimi-code\/bin\/kimi$/);
});
