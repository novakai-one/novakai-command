import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const serverRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const repositoryRoot = path.resolve(serverRoot, '../..');

function typescriptSources(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (entry === 'dist' || entry === 'node_modules' || entry === 'tests') {
        continue;
      }
      const absolute = path.join(directory, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else if (entry.endsWith('.ts')) {
        found.push(absolute);
      }
    }
  };
  walk(root);
  return found.sort();
}

test('B2a Server integration consumes capability contracts and delegates every domain write', () => {
  const b2aRoot = path.join(serverRoot, 'core', 'b2a');
  const offenders: string[] = [];
  for (const sourcePath of typescriptSources(b2aRoot)) {
    const source = readFileSync(sourcePath, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1]!;
      const crossesPackage =
        specifier.startsWith('../../../')
        || specifier.startsWith('@novakai/');
      if (crossesPackage && !/(?:^|\/)(?:contract|public)(?:\/|$)/.test(specifier)) {
        offenders.push(`${path.relative(serverRoot, sourcePath)} -> ${specifier}`);
      }
    }
    assert.doesNotMatch(
      source,
      /\b(?:createObject|updateObject|appendStep|openStoreDriver|writeFileSync?)\s*\(/,
      `${path.relative(serverRoot, sourcePath)} must delegate domain writes`,
    );
  }
  assert.deepEqual(offenders, []);
});

test('B2a Server WS adapter cannot reach byte or Spine-only attachment doors', () => {
  const source = readFileSync(
    path.join(serverRoot, 'core', 'b2a', 'methods.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /\.putArtifact\s*\(/);
  assert.doesNotMatch(source, /\.getArtifactBytes\s*\(/);
  assert.doesNotMatch(source, /\.attach\s*\(/);
  assert.doesNotMatch(source, /\bbytes\s*:/);
});

test('approved capabilities do not depend back on Server', () => {
  const offenders: string[] = [];
  for (const packageName of ['projects', 'artifacts', 'spine']) {
    const packageRoot = path.join(repositoryRoot, 'packages', packageName);
    for (const sourcePath of typescriptSources(packageRoot)) {
      const source = readFileSync(sourcePath, 'utf8');
      for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
        if (/(?:^|\/)server(?:\/|$)/.test(match[1]!)) {
          offenders.push(
            `${path.relative(repositoryRoot, sourcePath)} -> ${match[1]}`,
          );
        }
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('B2a adapters remain independent of Shell and UI surfaces', () => {
  const b2aRoot = path.join(serverRoot, 'core', 'b2a');
  const offenders = typescriptSources(b2aRoot).filter((sourcePath) => {
    const source = readFileSync(sourcePath, 'utf8');
    return /(?:^|[/@])shell(?:\/|['"])/m.test(source)
      || /\b(?:ui|userInterface)\b/.test(source);
  });
  assert.deepEqual(offenders, []);
});
