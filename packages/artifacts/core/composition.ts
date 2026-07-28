import path from 'node:path';
import {
  composeHandle,
  type ScopedStoreHandle,
} from '@novakai/foundation/dist/contract/index.js';

export interface ArtifactsContext {
  readonly handle: ScopedStoreHandle;
  readonly root: string;
  readonly bytesRoot: string;
}

export interface ComposeArtifactsOptions {
  root: string;
  legacyRoot?: string;
  principal: string;
  lockTimeoutMs?: number;
}

export function composeArtifacts(
  options: ComposeArtifactsOptions,
): ArtifactsContext {
  const root = path.resolve(options.root);
  return {
    handle: composeHandle({
      root,
      legacyRoot: options.legacyRoot,
      capability: 'artifacts',
      allowedKinds: ['artifact'],
      principal: options.principal,
      lockTimeoutMs: options.lockTimeoutMs,
    }),
    root,
    bytesRoot: path.join(root, 'artifacts'),
  };
}
