import {
  composeHandle,
  type ScopedStoreHandle,
} from '@novakai/foundation/dist/contract/index.js';
import {
  createProjectsHost,
  type ProjectsHost,
} from './contract.js';

/** @internal private composition authority; never published from the package root. */
export interface ProjectsContext {
  readonly handle: ScopedStoreHandle;
  readonly principal: string;
}

export interface ComposeProjectsOptions {
  root: string;
  legacyRoot?: string;
  principal: string;
  lockTimeoutMs?: number;
}

export function composeProjects(options: ComposeProjectsOptions): ProjectsHost {
  const context: ProjectsContext = {
    handle: composeHandle({
      root: options.root,
      legacyRoot: options.legacyRoot,
      capability: 'projects',
      allowedKinds: ['project', 'projectItem'],
      principal: options.principal,
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    principal: options.principal,
  };
  return createProjectsHost(context);
}
