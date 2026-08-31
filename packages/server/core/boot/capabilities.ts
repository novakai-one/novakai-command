/** Boot steps 3–5: Agents/provider runtimes and the transcript-first Messaging runtime. */

import * as messaging from '../../../messaging/contract/index.js';
import {
  composeAgents,
  createAgentsContract,
  createClaudeCliRuntime,
  createCodexCliRuntime,
  createKimiCliRuntime,
  defaultClaudeCliPath,
  defaultCodexCliPath,
  defaultKimiCliPath,
  type ProviderCliRuntime,
} from '../../../agents/contract/index.js';
import { canonicalDataRoot } from '../store-paths.js';
import type { ConfigStore } from '../config/store.js';
import type { BootNote, BootOptions } from './contract.js';
import { ensureStoreIdentity } from '@novakai/foundation/contract';

export async function composeCapabilities(input: {
  options: BootOptions;
  note: BootNote;
  configStore: ConfigStore;
  humanPersonId: string;
  cwd: string;
}) {
  const { options, note, configStore, humanPersonId, cwd } = input;
  const config = configStore.current();
  const dataRoot = canonicalDataRoot(options.root);
  const storeId = (await ensureStoreIdentity(options.root)).id;

  const kimiCliPath = options.kimiCliPath
    ?? config.providers.kimi.cliPath
    ?? defaultKimiCliPath();
  const codexCliPath = options.codexCliPath
    ?? config.providers.codex.cliPath
    ?? defaultCodexCliPath();
  const claudeCliPath = options.claudeCliPath
    ?? config.providers.claude.cliPath
    ?? defaultClaudeCliPath();
  const kimiRuntime = createKimiCliRuntime({
    cwd: config.providers.kimi.cwd ?? cwd,
    cliPath: kimiCliPath,
  });
  const codexRuntime = createCodexCliRuntime({
    cwd: config.providers.codex.cwd ?? cwd,
    cliPath: codexCliPath,
  });
  const claudeRuntime = createClaudeCliRuntime({
    cwd: config.providers.claude.cwd ?? cwd,
    cliPath: claudeCliPath,
  });
  const providerRuntimes: Partial<
    Record<'kimi' | 'codex' | 'claude', ProviderCliRuntime>
  > = { kimi: kimiRuntime, codex: codexRuntime, claude: claudeRuntime };
  const agentsCtx = composeAgents({
    root: options.root,
    dataRoot,
    principal: humanPersonId,
    providerRuntimes,
    allowMock: config.dev.allowMock,
    cwd,
    storeId,
  });
  const agents = createAgentsContract(agentsCtx);
  const agentDirectory = messaging.createAgentDirectory(agents);
  const availability = (name: string, runtime: ProviderCliRuntime, cliPath: string): string =>
    `${name}=${runtime.isAvailable() ? cliPath : 'CLI NOT FOUND'}`;
  note(4, 'agents', [
    availability('kimi', kimiRuntime, kimiCliPath),
    availability('codex', codexRuntime, codexCliPath),
    availability('claude', claudeRuntime, claudeCliPath),
    `mock=${config.dev.allowMock ? 'dev' : 'disabled'}`,
  ].join(', '));

  const transcript = await messaging.createDefaultMessagingRuntime({
    root: options.root,
    dataRoot,
    ...(options.providerHome ? { providerHome: options.providerHome } : {}),
    agentDirectory,
    providerSend: messaging.createAgentsProviderSend(agents),
    conversationPrincipalId: humanPersonId,
    storeId,
    ...(configuredAdoption(config.transcript)),
  });
  note(
    5,
    'transcript',
    config.transcript.ingest
      ? 'Messaging transcript-first ingestion enabled (starts after transport)'
      : 'Messaging transcript-first ingestion disabled (config transcript.ingest=false)',
  );
  return {
    agentsCtx,
    agents,
    kimiRuntime,
    providerRuntimes,
    transcript,
  };
}

function configuredAdoption(
  config: import('../../contract/config.js').ServerConfig['transcript'],
): { externalAdoption?: messaging.ExternalAdoptionOptions } {
  const enabled = Object.values(config.adoptRoots).some((roots) => roots.length > 0);
  if (!enabled) return {};
  if (config.adoptionTeamId === undefined || config.adoptionMissionId === undefined) {
    throw new Error('transcript adoption roots require Team and Mission IDs');
  }
  return {
    externalAdoption: {
      roots: config.adoptRoots,
      limitPerTick: config.adoptionLimitPerTick,
      assignment: {
        teamId: config.adoptionTeamId,
        missionId: config.adoptionMissionId,
      },
    },
  };
}
