// packages/server/core/config/store.ts — the config capability's implementation
// (DEC-B1-3). Deep module: the whole "what is configured" question sits behind
// current()/reload()/set(). Callers never read config.jsonl, never construct
// envelopes, never resolve bearer tokens themselves.
//
// Laws honored: server is the SOLE writer of kind 'config' (scoped handle,
// allowedKinds ['config']); every write is a single-object mutation carrying a
// clientOpId (R3-10/R3-18); latest line wins per config key (§13 disposition 6);
// bearer secrets live only in `.novakai/tokens/` (red gate 1).
import {
  composeHandle, createObject, updateObject, listObjects, loadTokens, mintToken,
} from '@novakai/foundation/dist/contract/index.js';
import type { ClientOpId, ObjectId } from '@novakai/foundation/dist/contract/brands.js';
import type { Result, ScopedStoreHandle } from '@novakai/foundation/dist/contract/types.js';
import type { StoreError } from '@novakai/foundation/dist/contract/errors.js';
import {
  CLI_DEFAULT_MODEL, ConfigObjectInput, DEFAULT_HISTORY_WINDOW_TURNS,
  DEFAULT_SUPERVISION, PROVIDER_NAMES, configKeyOf,
  type ConfigObject, type ProviderName, type ProviderSettings, type ServerConfig,
} from '../../contract/config.js';

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

export interface OpenConfigStoreOptions {
  /** `.novakai/` root. */
  root: string;
  /** The principal foundation stamps onto config writes (server identity). */
  principal: string;
}

export interface MintPrincipalTokenInput {
  personId: string;
  roles: string[];
  grants: string[];
}

export interface ConfigStore {
  /** The resolved snapshot. Cheap — callers may read it per request. */
  current(): ServerConfig;
  /** Re-read the store from disk (live-reload path, §13 disposition 6). */
  reload(): Promise<ServerConfig>;
  /** Write one config object; returns the snapshot it produced. */
  set(input: ConfigObjectInput, clientOpId: ClientOpId): Promise<Result<ServerConfig, StoreError>>;
  /** Mint a bearer token record for a principal. The secret never enters config. */
  mintPrincipalToken(input: MintPrincipalTokenInput): { id: string; bearer: string };
  /** @internal composition-root use: the raw config objects, latest per key. */
  objects(): ConfigObject[];
}

type StoredConfig = ConfigObject & { id: string; version: number };

function defaultProviders(): Record<ProviderName, ProviderSettings> {
  const out = {} as Record<ProviderName, ProviderSettings>;
  for (const provider of PROVIDER_NAMES) {
    out[provider] = {
      provider,
      defaultModel: CLI_DEFAULT_MODEL,
      historyWindowTurns: DEFAULT_HISTORY_WINDOW_TURNS,
    };
  }
  return out;
}

/** Resolve stored config objects + the token store into the boot snapshot. */
function resolve(objects: StoredConfig[], root: string): ServerConfig {
  const config: ServerConfig = {
    principals: [],
    unresolvedPrincipals: [],
    bindings: [],
    providers: defaultProviders(),
    supervision: { ...DEFAULT_SUPERVISION },
    dev: { allowMock: false },
  };
  const tokens = new Map(loadTokens(root).map((t) => [t.id, t]));
  for (const obj of objects) {
    switch (obj.configKind) {
      case 'principal': {
        const token = tokens.get(obj.tokenId);
        if (!token) {
          config.unresolvedPrincipals.push({
            personId: obj.personId,
            tokenId: obj.tokenId,
            reason: `token record "${obj.tokenId}" not found under tokens/`,
          });
          break;
        }
        config.principals.push({
          token: token.bearer, personId: obj.personId, roles: obj.roles, tokenId: obj.tokenId,
        });
        break;
      }
      case 'agentPersonBinding':
        config.bindings.push({ agentId: obj.agentId, personId: obj.personId });
        break;
      case 'provider': {
        const current = config.providers[obj.provider];
        config.providers[obj.provider] = {
          provider: obj.provider,
          defaultModel: obj.defaultModel ?? current.defaultModel,
          historyWindowTurns: obj.historyWindowTurns ?? current.historyWindowTurns,
          ...(obj.cliPath !== undefined ? { cliPath: obj.cliPath } : {}),
          ...(obj.cwd !== undefined ? { cwd: obj.cwd } : {}),
        };
        break;
      }
      case 'supervision':
        config.supervision = {
          usageIntervalSec: obj.usageIntervalSec ?? config.supervision.usageIntervalSec,
          driftIntervalSec: obj.driftIntervalSec ?? config.supervision.driftIntervalSec,
          idleTimeoutSec: obj.idleTimeoutSec ?? config.supervision.idleTimeoutSec,
        };
        break;
      case 'dev':
        config.dev = { allowMock: obj.allowMock };
        break;
    }
  }
  return config;
}

async function readObjects(handle: ScopedStoreHandle): Promise<Result<StoredConfig[], StoreError>> {
  const res = await listObjects<Record<string, unknown>>(handle, 'config', undefined, { limit: 10_000 });
  if (!res.ok) return fail(res.error);
  const out: StoredConfig[] = [];
  for (const item of res.value.items) {
    const parsed = ConfigObjectInput.safeParse(item.object);
    // A config line we cannot parse is drawn absence, never a boot crash (DEC-F2).
    if (!parsed.success) continue;
    out.push({ ...parsed.data, id: String(item.object.id), version: item.version });
  }
  return ok(out);
}

/**
 * Open (and on first boot materialize) the server config store.
 *
 * First-boot materialization writes the DEFAULT provider/supervision/dev
 * objects and NO principals — the demo's hardcoded authority table does not
 * come back (§2 "what the demo hacked", DEC-B1-3).
 */
export async function openConfigStore(
  options: OpenConfigStoreOptions,
): Promise<Result<ConfigStore, StoreError>> {
  const handle = composeHandle({
    root: options.root,
    capability: 'server',
    allowedKinds: ['config'],
    principal: options.principal,
  });

  let objects: StoredConfig[] = [];
  let snapshot: ServerConfig = resolve(objects, options.root);

  const refresh = async (): Promise<Result<ServerConfig, StoreError>> => {
    const read = await readObjects(handle);
    if (!read.ok) return fail(read.error);
    objects = read.value;
    snapshot = resolve(objects, options.root);
    return ok(snapshot);
  };

  const write = async (input: ConfigObjectInput, clientOpId: ClientOpId): Promise<Result<ServerConfig, StoreError>> => {
    const parsed = ConfigObjectInput.safeParse(input);
    if (!parsed.success) {
      return fail({
        code: 'InvalidEnvelope', name: 'InvalidEnvelope',
        message: `config object rejected: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        details: {}, retryable: false,
      } as unknown as StoreError);
    }
    const object = parsed.data;
    const id = configKeyOf(object);
    const existing = objects.find((o) => o.id === id);
    const record = {
      ...object,
      kind: 'config' as const,
      id,
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      permissionLevel: 'private' as const,
      createdBy: 'overridden-by-foundation', // red gate 4: foundation stamps the principal
    };
    const res = existing
      ? await updateObject<Record<string, unknown>>(handle, id as ObjectId, record, existing.version, clientOpId)
      : await createObject<Record<string, unknown>>(handle, record, clientOpId);
    if (!res.ok) return fail(res.error);
    return refresh();
  };

  const first = await refresh();
  if (!first.ok) return fail(first.error);

  // First boot: no config file yet → materialize the defaults (never principals).
  if (objects.length === 0) {
    for (const provider of PROVIDER_NAMES) {
      const seeded = await write({ configKind: 'provider', provider, defaultModel: CLI_DEFAULT_MODEL }, mintOpId());
      if (!seeded.ok) return fail(seeded.error);
    }
    const sup = await write({ configKind: 'supervision', ...DEFAULT_SUPERVISION }, mintOpId());
    if (!sup.ok) return fail(sup.error);
    const dev = await write({ configKind: 'dev', allowMock: false }, mintOpId());
    if (!dev.ok) return fail(dev.error);
  }

  return ok({
    current: () => snapshot,
    reload: async () => {
      const res = await refresh();
      return res.ok ? res.value : snapshot;
    },
    set: write,
    mintPrincipalToken: (input) => {
      const token = mintToken(options.root, input.personId, input.grants, options.principal);
      return { id: token.id, bearer: token.bearer };
    },
    objects: () => objects.map(({ id: _id, version: _version, ...rest }) => rest as ConfigObject),
  });
}

// Local mint so the config store never depends on a caller-supplied op id for
// its own first-boot materialization (R3-10 still satisfied: every write has one).
function mintOpId(): ClientOpId {
  return `op_${globalThis.crypto.randomUUID()}` as ClientOpId;
}
