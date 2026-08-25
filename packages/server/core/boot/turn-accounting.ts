/** Wire provider turn completion and pre-existing usage baselines. */

import type {
  ProviderCliRuntime,
  ProviderSessionRegistry,
  ProviderTurnRecord,
} from '../../../agents/contract/index.js';
import type { ProviderName } from '../../contract/config.js';
import type { createUsageReader } from '../supervision/usage.js';

export async function wireTurnAccounting(input: {
  providerRuntimes: Partial<Record<ProviderName, ProviderCliRuntime>>;
  sessions: ProviderSessionRegistry;
  usageReader: ReturnType<typeof createUsageReader>;
}): Promise<void> {
  const recordTurn = (record: ProviderTurnRecord): void => {
    void (async () => {
      const failures: string[] = [];
      if (record.cliSessionId) {
        try {
          const resumed = await input.sessions.recordResumeHandle(record.key, record.cliSessionId);
          if (!resumed.ok) {
            failures.push(`recordResumeHandle ${resumed.error.code}: ${resumed.error.message}`);
          }
        } catch (cause) {
          failures.push(`recordResumeHandle: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      try {
        const replied = await input.sessions.markReplied(record.key);
        if (!replied.ok) failures.push(`markReplied ${replied.error.code}: ${replied.error.message}`);
      } catch (cause) {
        failures.push(`markReplied: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (failures.length > 0) throw new Error(failures.join('; '));
    })().catch((cause) => {
      console.error(
        `[nvk-server] provider turn bookkeeping failed for ${record.key}: `
          + `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  };
  for (const provider of Object.values(input.providerRuntimes)) provider?.onTurn(recordTurn);
  for (const record of await input.sessions.resumable()) {
    if (record.providerConversationId) {
      input.usageReader.trackSession(record.sessionId, { threadPreexisting: true });
    }
  }
}
