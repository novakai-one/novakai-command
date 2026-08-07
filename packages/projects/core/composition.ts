import path from 'node:path';
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
  const root = path.resolve(options.root);
  const context: ProjectsContext = {
    handle: composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
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
