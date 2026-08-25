import { loadTokens } from '@novakai/foundation/dist/contract/index.js';
import {
  CLI_DEFAULT_MODEL,
  DEFAULT_HISTORY_WINDOW_TURNS,
  DEFAULT_SUPERVISION,
  PROVIDER_NAMES,
  type ConfigObject,
  type ProviderName,
  type ProviderSettings,
  type ServerConfig,
} from '../../contract/config.js';

type PrincipalConfig = Extract<ConfigObject, { readonly configKind: 'principal' }>;
type TokenLookup = ReadonlyMap<string, { readonly bearer: string }>;

function defaultProviders(): Record<ProviderName, ProviderSettings> {
  const providers = {} as Record<ProviderName, ProviderSettings>;
  for (const provider of PROVIDER_NAMES) {
    providers[provider] = {
      provider,
      defaultModel: CLI_DEFAULT_MODEL,
      historyWindowTurns: DEFAULT_HISTORY_WINDOW_TURNS,
    };
  }
  return providers;
}

/** Resolves stored configuration and token references into the boot snapshot. */
export function resolveServerConfig(
  objects: readonly ConfigObject[],
  root: string,
): ServerConfig {
  const config: ServerConfig = {
    principals: [],
    unresolvedPrincipals: [],
    bindings: [],
    providers: defaultProviders(),
    supervision: { ...DEFAULT_SUPERVISION },
    dev: { allowMock: false, watchTranscripts: false },
    transcript: {
      ingest: false,
      adoptRoots: { claude: [], codex: [], kimi: [] },
      adoptionLimitPerTick: 10,
    },
  };
  const tokens = new Map(loadTokens(root).map((token) => [token.id, token]));
  for (const object of objects) applyObject(config, object, tokens);
  return config;
}

function applyObject(
  config: ServerConfig,
  object: ConfigObject,
  tokens: TokenLookup,
): void {
  switch (object.configKind) {
    case 'principal':
      applyPrincipal(config, object, tokens);
      return;
    case 'agentPersonBinding':
      config.bindings.push({ agentId: object.agentId, personId: object.personId });
      return;
    case 'provider': {
      const current = config.providers[object.provider];
      config.providers[object.provider] = {
        provider: object.provider,
        defaultModel: object.defaultModel ?? current.defaultModel,
        historyWindowTurns: object.historyWindowTurns ?? current.historyWindowTurns,
        ...(object.cliPath === undefined ? {} : { cliPath: object.cliPath }),
        ...(object.cwd === undefined ? {} : { cwd: object.cwd }),
      };
      return;
    }
    case 'supervision':
      config.supervision = {
        usageIntervalSec: object.usageIntervalSec ?? config.supervision.usageIntervalSec,
        driftIntervalSec: object.driftIntervalSec ?? config.supervision.driftIntervalSec,
        idleTimeoutSec: object.idleTimeoutSec ?? config.supervision.idleTimeoutSec,
      };
      return;
    case 'dev':
      config.dev = {
        allowMock: object.allowMock,
        watchTranscripts: object.watchTranscripts ?? false,
      };
      return;
    case 'transcript':
      config.transcript = {
        ingest: object.ingest,
        adoptRoots: object.adoptRoots ?? { claude: [], codex: [], kimi: [] },
        adoptionLimitPerTick: object.adoptionLimitPerTick ?? 10,
        ...(object.adoptionTeamId === undefined
          ? {} : { adoptionTeamId: object.adoptionTeamId }),
        ...(object.adoptionMissionId === undefined
          ? {} : { adoptionMissionId: object.adoptionMissionId }),
      };
  }
}

function applyPrincipal(
  config: ServerConfig,
  object: PrincipalConfig,
  tokens: TokenLookup,
): void {
  const token = tokens.get(object.tokenId);
  if (token === undefined) {
    config.unresolvedPrincipals.push({
      personId: object.personId,
      tokenId: object.tokenId,
      reason: `token record "${object.tokenId}" not found under tokens/`,
    });
    return;
  }
  config.principals.push({
    token: token.bearer,
    personId: object.personId,
    roles: object.roles,
    tokenId: object.tokenId,
  });
}
