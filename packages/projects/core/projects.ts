import { randomUUID } from 'node:crypto';
import {
  createObject,
  getObjectByClientOpId,
  getObjectWithReadFailure,
  isAbsent,
  listObjects,
  updateObject,
} from '@novakai/foundation/dist/contract/index.js';
import { err, type StoreError } from '@novakai/foundation/dist/contract/errors.js';
import type {
  ClientOpId,
  ObjectId,
  ProjectId,
} from '@novakai/foundation/dist/contract/brands.js';
import type {
  Absent,
  Page,
  Result,
  StoredObject,
} from '@novakai/foundation/dist/contract/types.js';
import {
  CreateProjectInput,
  AttachProjectItemInput,
  ListProjectsFilter,
  Project,
  ProjectItem,
  type AttachProjectItemInput as AttachProjectItemInputT,
  type CreateProjectInput as CreateProjectInputT,
  type ListProjectsFilter as ListProjectsFilterT,
  type Project as ProjectT,
  type ProjectItem as ProjectItemT,
} from '../contract/schemas.js';
import type {
  ProjectsError,
  StoredRecordInvalidError,
} from '../contract/errors.js';
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

function malformedStoredRecord(
  kind: 'project' | 'projectItem',
  object: unknown,
  issues: Array<{ path: PropertyKey[]; message: string }>,
): StoredRecordInvalidError {
  const id = typeof object === 'object' && object !== null
    ? String((object as { id?: unknown }).id ?? '(unknown)')
    : '(unknown)';
  return err(
    'StoredRecordInvalid',
    `stored ${kind} "${id}" does not match the Projects schema`,
    {
      ref: { kind, id },
      issues: issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    },
    false,
  );
}

function parseProjectItemRecord(
  object: unknown,
): Result<ProjectItemT, StoredRecordInvalidError> {
  const item = ProjectItem.safeParse(object);
  return item.success
    ? { ok: true, value: item.data }
    : {
        ok: false,
        error: malformedStoredRecord('projectItem', object, item.error.issues),
      };
}

export async function createProject(
  ctx: ProjectsContext,
  input: CreateProjectInputT,
  clientOpId: ClientOpId,
): Promise<Result<ProjectT, ProjectsError>> {
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

export async function listProjects(
  ctx: ProjectsContext,
  filter?: ListProjectsFilterT,
): Promise<Result<Page<ProjectT>, ProjectsError>> {
  const parsed = ListProjectsFilter.safeParse(filter ?? {});
  if (!parsed.success) return { ok: false, error: invalidInput(parsed.error) };
  const listed = await listObjects<ProjectT>(ctx.handle, 'project', parsed.data);
  if (!listed.ok) return listed;
  const items: ProjectT[] = [];
  for (const { object } of listed.value.items) {
    const project = Project.safeParse(object);
    if (!project.success) {
      return {
        ok: false,
        error: malformedStoredRecord('project', object, project.error.issues),
      };
    }
    items.push(project.data as ProjectT);
  }
  return {
    ok: true,
    value: {
      items,
      ...(listed.value.nextCursor ? { nextCursor: listed.value.nextCursor } : {}),
    },
  };
}

async function findProject(
  ctx: ProjectsContext,
  projectId: ProjectId,
): Promise<Result<StoredObject<ProjectT> | Absent, ProjectsError>> {
  const found = await getObjectWithReadFailure<ProjectT>(
    ctx.handle,
    'project',
    projectId as unknown as ObjectId,
  );
  if (!found.ok || isAbsent(found.value)) return found;
  const project = Project.safeParse(found.value.object);
  if (!project.success) {
    return {
      ok: false,
      error: malformedStoredRecord(
        'project',
        found.value.object,
        project.error.issues,
      ),
    };
  }
  return {
    ok: true,
    value: {
      ...found.value,
      object: project.data as ProjectT,
    },
  };
}

function projectNotFound(projectId: ProjectId): StoreError {
  return err(
    'NotFound',
    `no project with id "${projectId}"`,
    { ref: { kind: 'project', id: projectId } },
    false,
  );
}

export async function archiveProject(
  ctx: ProjectsContext,
  projectId: ProjectId,
  clientOpId: ClientOpId,
): Promise<Result<ProjectT, ProjectsError>> {
  const missingClientOpId = requireClientOpId(clientOpId);
  if (missingClientOpId) return { ok: false, error: missingClientOpId };
  const current = await findProject(ctx, projectId);
  if (!current.ok) return current;
  if (isAbsent(current.value)) {
    return { ok: false, error: projectNotFound(projectId) };
  }
  const updated = await updateObject<ProjectT>(
    ctx.handle,
    projectId as unknown as ObjectId,
    { status: 'archived' },
    current.value.version,
    clientOpId,
  );
  if (!updated.ok) return updated;
  return { ok: true, value: Project.parse(updated.value.object) as ProjectT };
}

export async function getProjectItems(
  ctx: ProjectsContext,
  projectId: ProjectId,
): Promise<Result<Page<ProjectItemT>, ProjectsError>> {
  const project = await findProject(ctx, projectId);
  if (!project.ok) return project;
  if (isAbsent(project.value)) {
    return { ok: false, error: projectNotFound(projectId) };
  }
  const listed = await listObjects<ProjectItemT>(
    ctx.handle,
    'projectItem',
    { projectId },
  );
  if (!listed.ok) return listed;
  const items: ProjectItemT[] = [];
  for (const { object } of listed.value.items) {
    const item = parseProjectItemRecord(object);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return {
    ok: true,
    value: {
      items,
      ...(listed.value.nextCursor ? { nextCursor: listed.value.nextCursor } : {}),
    },
  };
}

export async function attach(
  ctx: ProjectsContext,
  projectId: ProjectId,
  input: AttachProjectItemInputT,
  clientOpId: ClientOpId,
): Promise<Result<ProjectItemT, ProjectsError>> {
  const missingClientOpId = requireClientOpId(clientOpId);
  if (missingClientOpId) return { ok: false, error: missingClientOpId };
  const parsed = AttachProjectItemInput.safeParse(input);
  if (!parsed.success) return { ok: false, error: invalidInput(parsed.error) };
  const replay = await getObjectByClientOpId<ProjectItemT>(
    ctx.handle,
    'projectItem',
    clientOpId,
  );
  if (!replay.ok) return replay;
  if (replay.value) {
    return parseProjectItemRecord(replay.value.object);
  }
  const project = await findProject(ctx, projectId);
  if (!project.ok) return project;
  if (isAbsent(project.value)) {
    return { ok: false, error: projectNotFound(projectId) };
  }
  if (project.value.object.status !== 'active') {
    return {
      ok: false,
      error: err(
        'InvalidEnvelope',
        `project "${projectId}" is archived and cannot accept items`,
        {
          missingFields: [],
          invalidFields: [{ field: 'status', reason: 'project must be active' }],
        },
        false,
      ),
    };
  }
  const record = ProjectItem.parse({
    kind: 'projectItem',
    id: `projectItem_${randomUUID()}`,
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    permissionLevel: project.value.object.permissionLevel,
    createdBy: 'overridden-by-foundation',
    projectId,
    itemRef: parsed.data.itemRef,
    ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    addedBy: ctx.principal,
    addedVia: 'spine',
  });
  const created = await createObject<ProjectItemT>(ctx.handle, record, clientOpId);
  if (!created.ok) return created;
  return { ok: true, value: ProjectItem.parse(created.value.object) };
}
