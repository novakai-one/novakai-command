/** Boot steps 3–5: Messaging, Agents/provider runtimes and Transcript. */

import path from 'node:path';
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
import { canonicalDataRoot } from '../store-route.js';
import { createLiveAuthority } from '../session/authority.js';
import { composeTranscriptServerHost } from '../b2b/composition.js';
import type { ConfigStore } from '../config/store.js';
import type { BootNote, BootOptions } from './contract.js';

export async function composeCapabilities(input: {
  options: BootOptions;
  note: BootNote;
  configStore: ConfigStore;
  humanPersonId: string;
  cwd: string;
}) {
  const { options, note, configStore, humanPersonId, cwd } = input;
  const config = configStore.current();
  const clock = messaging.createSystemClock();
  const store = await messaging.openJsonlStore(clock, {
    path: path.join(options.root, 'messaging.jsonl'),
  });
  const authority = createLiveAuthority({ snapshot: () => configStore.current(), clock });
  const embedded = messaging.createEmbeddedMessaging({
    clock,
    store,
    authority: authority as never,
  });
  await embedded.start();
  note(
    3,
    'messaging',
    `embedded capability up with ${config.principals.length} configured principal(s)`,
  );

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
    dataRoot: canonicalDataRoot(options.root),
    principal: humanPersonId,
    providerRuntimes,
    allowMock: config.dev.allowMock,
    cwd,
  });
  const agents = createAgentsContract(agentsCtx);
  const availability = (name: string, runtime: ProviderCliRuntime, cliPath: string): string =>
    `${name}=${runtime.isAvailable() ? cliPath : 'CLI NOT FOUND'}`;
  note(4, 'agents', [
    availability('kimi', kimiRuntime, kimiCliPath),
    availability('codex', codexRuntime, codexCliPath),
    availability('claude', claudeRuntime, claudeCliPath),
    `mock=${config.dev.allowMock ? 'dev' : 'disabled'}`,
  ].join(', '));

  const transcript = composeTranscriptServerHost({
    root: options.root,
    ...(options.providerHome ? { providerHome: options.providerHome } : {}),
  });
  note(
    5,
    'transcript',
    config.transcript.ingest
      ? 'copy custody + ingestion enabled (starts after transport)'
      : 'copy custody + ingestion disabled (config transcript.ingest=false)',
  );
  return {
    embedded,
    agentsCtx,
    agents,
    kimiRuntime,
    providerRuntimes,
    transcript,
  };
}
