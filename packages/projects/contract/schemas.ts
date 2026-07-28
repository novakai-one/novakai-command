import { z } from 'zod';
import { PermissionLevel } from '@novakai/foundation/dist/contract/schemas.js';
import type { ProjectId } from '@novakai/foundation/dist/contract/brands.js';

export const ProjectStatus = z.enum(['active', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const Project = z.object({
  kind: z.literal('project'),
  id: z.string().regex(/^proj_/),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: PermissionLevel,
  createdBy: z.string().min(1),
  title: z.string().min(1),
  status: ProjectStatus,
});
type ParsedProject = z.infer<typeof Project>;
export type Project = Omit<ParsedProject, 'id'> & { id: ProjectId };

export const CreateProjectInput = z.object({
  title: z.string().min(1),
  permissionLevel: PermissionLevel.optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const ListProjectsFilter = z.object({
  status: ProjectStatus.optional(),
}).strict();
export type ListProjectsFilter = z.infer<typeof ListProjectsFilter>;

export type { ProjectId, ClientOpId } from '@novakai/foundation/dist/contract/brands.js';
export type { Page, Result } from '@novakai/foundation/dist/contract/types.js';
export type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
