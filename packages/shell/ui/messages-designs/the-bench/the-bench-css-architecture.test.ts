import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const benchRoot = dirname(fileURLToPath(import.meta.url));

function findCssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return findCssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

const cssFiles = findCssFiles(benchRoot);

function physicalLineCount(source: string): number {
  if (source.length === 0) return 0;
  return source.split(/\r?\n/).length - (source.endsWith('\n') ? 1 : 0);
}

describe('Bench CSS architecture', () => {
  it('keeps every stylesheet within the 300-line navigability limit', () => {
    const oversized = cssFiles.flatMap((path) => {
      const lineCount = physicalLineCount(readFileSync(path, 'utf8'));
      return lineCount > 300 ? [`${path}: ${lineCount} lines`] : [];
    });

    expect(oversized).toEqual([]);
  });

  it('does not use !important to compensate for unclear ownership', () => {
    const offenders = cssFiles.filter((path) => readFileSync(path, 'utf8').includes('!important'));

    expect(offenders).toEqual([]);
  });
});
