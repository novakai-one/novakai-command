import type { ClientOpId } from '@novakai/foundation/dist/contract/brands.js';
import type { Result } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import type { CreateProjectInput, Project } from '../contract/schemas.js';
import type { ProjectsContext } from './composition.js';
import * as projects from './projects.js';

export interface ProjectsContract {
  createProject(
    input: CreateProjectInput,
    clientOpId: ClientOpId,
  ): Promise<Result<Project, StoreError>>;
}

export function createProjectsContract(ctx: ProjectsContext): ProjectsContract {
  return {
    createProject: (input, clientOpId) => projects.createProject(ctx, input, clientOpId),
  };
}
