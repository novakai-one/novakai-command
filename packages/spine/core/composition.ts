import path from 'node:path';
import {
  composeHandle,
  type ScopedStoreHandle,
} from '@novakai/foundation/dist/contract/index.js';
import type { ArtifactsOperations } from '@novakai/artifacts';
import type { SpineProjectsContract } from '@novakai/projects';
import {
  createSpineHost,
  type MessageExistenceQuery,
  type SpineHost,
} from './contract.js';

/** @internal private composition state; never exported from the package door. */
export interface SpineContext {
  readonly handle: ScopedStoreHandle;
  readonly messaging: MessageExistenceQuery;
  readonly projects: Pick<SpineProjectsContract, 'attach'>;
  readonly artifacts: Pick<ArtifactsOperations, 'getArtifactMeta'>;
  readonly configuredFailpoint?: string;
}

export interface ComposeSpineOptions {
  root: string;
  legacyRoot?: string;
  principal: string;
  messaging: MessageExistenceQuery;
  projects: Pick<SpineProjectsContract, 'attach'>;
  artifacts: Pick<ArtifactsOperations, 'getArtifactMeta'>;
  lockTimeoutMs?: number;
}

export function composeSpine(options: ComposeSpineOptions): SpineHost {
  const root = path.resolve(options.root);
  const context: SpineContext = {
    handle: composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      legacyRoot: options.legacyRoot,
      capability: 'spine',
      allowedKinds: ['spineStep'],
      principal: options.principal,
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    messaging: options.messaging,
    projects: options.projects,
    artifacts: options.artifacts,
    configuredFailpoint: process.env.NVK_FAILPOINT,
  };
  return createSpineHost(context);
}
