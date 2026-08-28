import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';

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

const FILESYSTEM_WRITERS = new Set([
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'copyFile',
  'copyFileSync',
  'createWriteStream',
  'link',
  'linkSync',
  'mkdir',
  'mkdirSync',
  'rename',
  'renameSync',
  'rm',
  'rmSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'unlink',
  'unlinkSync',
  'writeFile',
  'writeFileSync',
]);

const FOUNDATION_WRITERS = new Set([
  'composeHandle',
  'createObject',
  'mintToken',
  'recordSystemAction',
  'updateObject',
]);

function writerExports(moduleName: string): Set<string> | null {
  if (/^(?:node:)?fs(?:\/promises)?$/.test(moduleName)) {
    return FILESYSTEM_WRITERS;
  }
  if (
    /(?:^|\/)foundation(?:\/dist)?\/contract\//.test(moduleName)
    || moduleName.startsWith('@novakai/foundation/')
  ) {
    return FOUNDATION_WRITERS;
  }
  return null;
}

function persistenceAuthorities(sourcePath: string): string[] {
  const sourceText = readFileSync(sourcePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    sourcePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const authorities: string[] = [];
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || !statement.importClause
      || statement.importClause.isTypeOnly
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    const writers = writerExports(moduleName);
    if (!writers) continue;
    if (statement.importClause.name) {
      authorities.push(
        ...[...writers].map((name) => `${moduleName}:${name}`),
      );
    }
    const imported = statement.importClause.namedBindings;
    if (imported && ts.isNamespaceImport(imported)) {
      authorities.push(
        ...[...writers].map((name) => `${moduleName}:${name}`),
      );
      continue;
    }
    if (!imported || !ts.isNamedImports(imported)) continue;
    for (const element of imported.elements) {
      if (element.isTypeOnly) continue;
      const exportedName = (element.propertyName ?? element.name).text;
      if (writers.has(exportedName)) {
        authorities.push(`${moduleName}:${exportedName}`);
      }
    }
  }
  return authorities.sort();
}

test('B2a Server integration consumes capability contracts', () => {
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
  }
  assert.deepEqual(offenders, []);
});

test('every Server persistence-writer authority is explicitly classified', () => {
  const authorities: string[] = [];
  for (const sourcePath of typescriptSources(serverRoot)) {
    for (const writer of persistenceAuthorities(sourcePath)) {
      authorities.push(`${path.relative(serverRoot, sourcePath)} -> ${writer}`);
    }
  }
  assert.deepEqual(authorities.sort(), [
    // Run-credential secret only. Runtime-private under `.novakai/runtime/`
    // (§18.3): not a durable domain record, gitignored, and losing it costs
    // nothing but a re-issue — which is what a Runtime restart does anyway.
    // Every Run FACT this file touches goes through the Agents/Terminal
    // contracts above it, never through the filesystem.
    'core/b3/run-ports.ts -> node:fs:mkdirSync',
    'core/b3/run-ports.ts -> node:fs:writeFileSync',
    'core/boot.ts -> @novakai/foundation/dist/contract/index.js:recordSystemAction',
    'core/config/store.ts -> @novakai/foundation/dist/contract/index.js:composeHandle',
    'core/config/store.ts -> @novakai/foundation/dist/contract/index.js:createObject',
    'core/config/store.ts -> @novakai/foundation/dist/contract/index.js:mintToken',
    'core/config/store.ts -> @novakai/foundation/dist/contract/index.js:updateObject',
    'core/methods/sessions.ts -> @novakai/foundation/dist/contract/index.js:recordSystemAction',
    'core/supervision/log.ts -> node:fs:appendFileSync',
    'core/supervision/log.ts -> node:fs:mkdirSync',
    'core/supervision/watchdog.ts -> node:fs:mkdirSync',
    'core/supervision/watchdog.ts -> node:fs:renameSync',
    'core/supervision/watchdog.ts -> node:fs:writeFileSync',
    'core/transport/server.ts -> node:fs:chmodSync',
    'core/transport/server.ts -> node:fs:mkdirSync',
    'core/transport/server.ts -> node:fs:writeFileSync',
  ]);
});

test('B2a Server WS adapter cannot reach byte or internal attachment doors', () => {
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
  for (
    const packageName of ['projects', 'artifacts', 'messaging']
  ) {
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

test('B2a Server adapters do not import Shell', () => {
  const b2aRoot = path.join(serverRoot, 'core', 'b2a');
  const offenders: string[] = [];
  for (const sourcePath of typescriptSources(b2aRoot)) {
    const source = readFileSync(sourcePath, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (/(?:^|\/|@)shell(?:\/|$)/.test(match[1]!)) {
        offenders.push(
          `${path.relative(serverRoot, sourcePath)} -> ${match[1]}`,
        );
      }
    }
  }
  assert.deepEqual(offenders, []);
});
