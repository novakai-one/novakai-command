import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface DoctorReport {
  inertDemoPersons: string[];
}

const INERT_DEMO_PERSON = /^person_(?:pool|mockagent)[A-Za-z0-9_-]*$/;

function collectDemoPersonIds(value: unknown, found: Set<string>): void {
  if (typeof value === 'string') {
    if (INERT_DEMO_PERSON.test(value)) found.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDemoPersonIds(item, found);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectDemoPersonIds(item, found);
  }
}

/** Read-only legacy-data diagnostic. It never opens a mutating store handle. */
export function inspectLegacyDemoPersons(root: string): DoctorReport {
  const messagingPath = path.join(root, 'messaging.jsonl');
  if (!existsSync(messagingPath)) return { inertDemoPersons: [] };
  const found = new Set<string>();
  for (const line of readFileSync(messagingPath, 'utf8').split('\n')) {
    if (!line) continue;
    try { collectDemoPersonIds(JSON.parse(line), found); } catch { /* malformed evidence remains untouched */ }
  }
  return { inertDemoPersons: [...found].sort() };
}
