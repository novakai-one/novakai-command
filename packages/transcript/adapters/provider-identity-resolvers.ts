import path from 'node:path';
import {
  composeHandle,
  listObjects,
} from '@novakai/foundation/dist/contract/index.js';
import type {
  AgentId,
} from '@novakai/foundation/dist/contract/brands.js';
import { z } from 'zod';
import {
  ProviderName,
  SessionRef,
} from '../contract/schemas.js';
import type {
  ProviderAgentResolver,
  ProviderSessionResolver,
} from './provider-normalizer-support.js';

const ProviderIdentityRecord = z.object({
  kind: z.literal('providerSession'),
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  provider: ProviderName,
  providerConversationId: z.string().min(1).nullable(),
}).passthrough();

export type ProviderIdentityRecord = z.infer<
  typeof ProviderIdentityRecord
>;

export interface ProviderIdentityResolvers {
  replace(records: readonly ProviderIdentityRecord[]): void;
  resolveSessionRef: ProviderSessionResolver;
  resolveAgentId: ProviderAgentResolver;
}

export function createProviderIdentityResolvers(
  initial: readonly ProviderIdentityRecord[] = [],
): ProviderIdentityResolvers {
  let sessions = new Map<string, string>();
  let agents = new Set<string>();

  const replace = (records: readonly ProviderIdentityRecord[]): void => {
    sessions = new Map();
    agents = new Set();
    for (const record of records) {
      agents.add(`${record.provider}:${record.agentId}`);
      if (record.providerConversationId) {
        sessions.set(
          `${record.provider}:${record.providerConversationId}`,
          record.sessionId,
        );
      }
    }
  };
  replace(initial);

  return {
    replace,
    resolveSessionRef(provider, nativeSessionId) {
      const resolved = sessions.get(`${provider}:${nativeSessionId}`);
      const parsed = SessionRef.safeParse(resolved);
      return parsed.success ? parsed.data : undefined;
    },
    resolveAgentId(provider, nativeAgentId) {
      return agents.has(`${provider}:${nativeAgentId}`)
        ? nativeAgentId as AgentId
        : undefined;
    },
  };
}

export async function loadProviderIdentityRecords(
  root: string,
): Promise<ProviderIdentityRecord[]> {
  const handle = composeHandle({
    root,
    dataRoot: path.join(root, 'stores'),
    capability: 'agents',
    allowedKinds: ['providerSession'],
    principal: 'sys_ingester',
  });
  const records: ProviderIdentityRecord[] = [];
  let cursor: string | undefined;
  do {
    const listed = await listObjects<unknown>(
      handle,
      'providerSession',
      undefined,
      { ...(cursor ? { cursor } : {}), limit: 1_000 },
    );
    if (!listed.ok) {
      throw new Error(
        `provider identity snapshot unavailable: ${listed.error.code}`,
      );
    }
    for (const item of listed.value.items) {
      const parsed = ProviderIdentityRecord.safeParse(item.object);
      if (parsed.success) records.push(parsed.data);
    }
    cursor = listed.value.nextCursor;
  } while (cursor);
  return records;
}
