// core/skills — the provider-neutral skills registry (S2-pass1 §C, DEC-S2-4):
// kind 'skill' records in skills.jsonl via the foundation scoped handle.
// v1 stores path refs only — no parsing, no execution (red gate S2-1: one
// store, never inside a provider adapter).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  createObject, getObject, listObjects,
} from '@novakai/foundation/dist/contract/index.js';
import type { ClientOpId, ObjectId } from '@novakai/foundation/dist/contract/brands.js';
import type { Absent, ListFilter, Page, Result } from '@novakai/foundation/dist/contract/types.js';
import { isAbsent } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import { err } from '@novakai/foundation/dist/contract/errors.js';
import { SkillDefinition, type SkillDefinitionT } from '../../contract/schemas.js';
import type { AgentsContext } from '../composition.js';

export interface RegisterSkillInput {
  name: string;
  path: string;             // path ref to the skill directory
  description?: string;
  permissionLevel?: 'private' | 'team' | 'external';
}

export async function registerSkill(
  ctx: AgentsContext, input: RegisterSkillInput, clientOpId: ClientOpId,
): Promise<Result<SkillDefinitionT, StoreError>> {
  if (!input.name || !input.path) {
    return {
      ok: false,
      error: err('InvalidEnvelope', 'skill name and path must be non-empty', {
        missingFields: [...(!input.name ? ['name'] : []), ...(!input.path ? ['path'] : [])],
        invalidFields: [],
      }, false),
    };
  }
  // M10 (req 10, one store): skill path refs are constrained to
  // .novakai/skills/ — the canonical relative form, or an absolute path that
  // resolves under this root's skills/ dir. Anything else is a typed rejection.
  const compliant =
    input.path.startsWith('.novakai/skills/')
    || path.resolve(input.path).startsWith(path.resolve(ctx.skillsRoot) + path.sep);
  if (!compliant) {
    return {
      ok: false,
      error: err('InvalidEnvelope',
        `skill path must live under .novakai/skills/ (got "${input.path}")`, {
          missingFields: [],
          invalidFields: [{ field: 'path', reason: 'outside .novakai/skills/' }],
        }, false),
    };
  }
  const record: SkillDefinitionT = {
    kind: 'skill',
    id: `skill_${randomUUID()}`,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: input.permissionLevel ?? 'private',
    createdBy: 'overridden-by-foundation', // red gate 4: foundation stamps the token principal
    name: input.name,
    path: input.path,
    description: input.description ?? '',
  };
  const parsed = SkillDefinition.parse(record);
  const res = await createObject<SkillDefinitionT>(ctx.handle, parsed, clientOpId);
  if (!res.ok) return res;
  return { ok: true, value: res.value.object };
}

export async function getSkill(
  ctx: AgentsContext, id: string,
): Promise<Result<SkillDefinitionT | Absent, never>> {
  const res = await getObject<SkillDefinitionT>(ctx.handle, 'skill', id as unknown as ObjectId);
  if (!res.ok || isAbsent(res.value)) return { ok: true, value: { absent: true, ref: { kind: 'skill', id } } };
  const parsed = SkillDefinition.safeParse(res.value.object);
  if (!parsed.success) return { ok: true, value: { absent: true, ref: { kind: 'skill', id } } };
  return { ok: true, value: parsed.data };
}

export async function listSkills(
  ctx: AgentsContext, filter?: ListFilter,
): Promise<Result<Page<SkillDefinitionT>, StoreError>> {
  const res = await listObjects<SkillDefinitionT>(ctx.handle, 'skill', filter);
  if (!res.ok) return res;
  return {
    ok: true,
    value: {
      items: res.value.items.map((s) => s.object),
      ...(res.value.nextCursor ? { nextCursor: res.value.nextCursor } : {}),
    },
  };
}

/**
 * Resolve skill id refs to directory paths, in def order. Any unknown id is a
 * typed NotFound (never a silent drop — the spawn fails before a session
 * exists without its declared skills).
 */
export async function resolveSkillDirs(
  ctx: AgentsContext, ids: string[],
): Promise<Result<string[], StoreError>> {
  const dirs: string[] = [];
  for (const id of ids) {
    const found = await getSkill(ctx, id);
    if (!found.ok || isAbsent(found.value)) {
      return {
        ok: false,
        error: err('NotFound', `no skill with id "${id}"`, { ref: { kind: 'skill', id } }, false),
      };
    }
    dirs.push(found.value.path);
  }
  return { ok: true, value: dirs };
}
