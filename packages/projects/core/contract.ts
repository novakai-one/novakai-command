import type {
  ClientOpId,
  ProjectId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { Page, Result } from '@novakai/foundation/dist/contract/types.js';
import type {
  AttachProjectItemInput,
  CreateProjectInput,
  ListProjectsFilter,
  Project,
  ProjectItem,
} from '../contract/schemas.js';
import type { ProjectsError } from '../contract/errors.js';
import type { ProjectsContext } from './composition.js';
import * as projects from './projects.js';

export interface ProjectsContract {
  createProject(
    input: CreateProjectInput,
    clientOpId: ClientOpId,
  ): Promise<Result<Project, ProjectsError>>;
  listProjects(
    filter?: ListProjectsFilter,
  ): Promise<Result<Page<Project>, ProjectsError>>;
  archiveProject(
    projectId: ProjectId,
    clientOpId: ClientOpId,
  ): Promise<Result<Project, ProjectsError>>;
  getProjectItems(
    projectId: ProjectId,
  ): Promise<Result<Page<ProjectItem>, ProjectsError>>;
}

export interface SpineProjectsContract extends ProjectsContract {
  attach(
    projectId: ProjectId,
    input: AttachProjectItemInput,
    clientOpId: ClientOpId,
  ): Promise<Result<ProjectItem, ProjectsError>>;
}

export interface ProjectsHost {
  readonly operations: ProjectsContract;
  readonly spine: SpineProjectsContract;
}

function createProjectsContract(ctx: ProjectsContext): ProjectsContract {
  return {
    createProject: (input, clientOpId) => projects.createProject(ctx, input, clientOpId),
    listProjects: (filter) => projects.listProjects(ctx, filter),
    archiveProject: (projectId, clientOpId) =>
      projects.archiveProject(ctx, projectId, clientOpId),
    getProjectItems: (projectId) => projects.getProjectItems(ctx, projectId),
  };
}

function createSpineProjectsContract(ctx: ProjectsContext): SpineProjectsContract {
  return {
    ...createProjectsContract(ctx),
    attach: (projectId, input, clientOpId) =>
      projects.attach(ctx, projectId, input, clientOpId),
  };
}

export function createProjectsHost(ctx: ProjectsContext): ProjectsHost {
  return {
    operations: createProjectsContract(ctx),
    spine: createSpineProjectsContract(ctx),
  };
}
