import { randomUUID } from 'node:crypto';
import { createObject } from '@novakai/foundation/dist/contract/index.js';
import { err, type StoreError } from '@novakai/foundation/dist/contract/errors.js';
import type { ClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import {
  CreateProjectInput,
  Project,
  type CreateProjectInput as CreateProjectInputT,
  type Project as ProjectT,
} from '../contract/schemas.js';
import type { ProjectsContext } from './composition.js';

function invalidInput(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): StoreError {
  return err(
    'InvalidEnvelope',
    `project input rejected: ${error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
    {
      missingFields: [],
      invalidFields: error.issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    },
    false,
  );
}

function requireClientOpId(clientOpId: ClientOpId): StoreError | null {
  if (typeof clientOpId === 'string' && clientOpId.length > 0) return null;
  return err(
    'InvalidEnvelope',
    'clientOpId is required for every Projects mutation',
    {
      missingFields: ['clientOpId'],
      invalidFields: [{ field: 'clientOpId', reason: 'required non-empty string' }],
    },
    false,
  );
}

export async function createProject(
  ctx: ProjectsContext,
  input: CreateProjectInputT,
  clientOpId: ClientOpId,
): Promise<Result<ProjectT, StoreError>> {
  const missingClientOpId = requireClientOpId(clientOpId);
  if (missingClientOpId) return { ok: false, error: missingClientOpId };
  const parsed = CreateProjectInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidInput(parsed.error) };
  const record = Project.parse({
    kind: 'project',
    id: `proj_${randomUUID()}`,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: parsed.data.permissionLevel ?? 'private',
    createdBy: 'overridden-by-foundation',
    title: parsed.data.title,
    status: 'active',
  }) as ProjectT;
  const created = await createObject<ProjectT>(ctx.handle, record, clientOpId);
  if (!created.ok) return created;
  return { ok: true, value: Project.parse(created.value.object) as ProjectT };
}
