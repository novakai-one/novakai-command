import path from 'node:path';
import {
  composeHandle,
  type ScopedStoreHandle,
} from '@novakai/foundation/dist/contract/index.js';
import {
  createArtifactsHost,
  type ArtifactsHost,
} from './contract.js';
import {
  composeArtifactFailpoint,
  type ArtifactFailpoint,
} from './failpoints.js';

export interface ArtifactsContext {
  readonly handle: ScopedStoreHandle;
  readonly root: string;
  readonly bytesRoot: string;
  readonly failpoint: ArtifactFailpoint;
}

export interface ComposeArtifactsOptions {
  root: string;
  legacyRoot?: string;
  principal: string;
  lockTimeoutMs?: number;
}

export function composeArtifacts(
  options: ComposeArtifactsOptions,
): ArtifactsHost {
  const root = path.resolve(options.root);
  const configuredFailpoint = process.env.NVK_FAILPOINT;
  const context: ArtifactsContext = {
    handle: composeHandle({
      root,
      dataRoot: path.join(root, 'stores'),
      legacyRoot: options.legacyRoot,
      capability: 'artifacts',
      allowedKinds: ['artifact'],
      principal: options.principal,
      lockTimeoutMs: options.lockTimeoutMs,
      ...(configuredFailpoint === 'artifacts.put.foundation-trace-incomplete'
        ? {
            failNextTraceAppend: {
              cause: 'injected incomplete artifact mutation trace',
            },
          }
        : {}),
    }),
    root,
    bytesRoot: path.join(root, 'artifacts'),
    failpoint: composeArtifactFailpoint(configuredFailpoint),
  };
  return createArtifactsHost(context);
}
