import { homedir } from 'node:os';
import path from 'node:path';
import { ensureStoreIdentity, type StoreId } from '@novakai/foundation/contract';
import { createProviderTranscriptSource } from '../../adapters/provider-transcripts/source.js';
import type { ProviderTranscriptRoots } from '../../adapters/provider-transcripts/source.js';
import { providerNormalizer } from '../../adapters/provider-transcripts/normalizers/index.js';
import { openFoundationTranscriptStore } from '../../adapters/stores/jsonl.js';
import { agentIdentityHookCommand } from '../../adapters/provider-hooks/agent-identity-hook.js';
import { ensureClaudeIdentityHook } from '../../adapters/provider-hooks/registrations/claude.js';
import { ensureCodexIdentityHook } from '../../adapters/provider-hooks/registrations/codex.js';
import { ensureKimiIdentityHook } from '../../adapters/provider-hooks/registrations/kimi.js';
import { createMessagingRuntime } from '../../core/runtime/messaging-runtime.js';
import { present } from '../../core/sparse.js';
import { thrownMessageOr } from '../../core/thrown.js';
import type { MessagingRuntimeApi } from '../runtime.js';
import type { AgentDirectory, AdoptionAssignment } from '../ports/agent-directory.js';
import type { ConversationDirectory } from '../ports/conversation-directory.js';
import type { ProviderSend } from '../ports/provider-send.js';
import type { TranscriptStore } from '../ports/transcript-store.js';
import { MessagingError } from '../types.js';
import type { MessagingTraceSink } from '../trace.js';

/**
 * The default trace rendering: one line per observable moment on stdout, so
 * `grep send_abc123` (or a stage name) reads one journey top to bottom. The
 * sink stamps the time it observed the event — that is the trace contract's
 * job for a sink, so the wall clock is read here and nowhere else.
 */
const consoleTraceSink: MessagingTraceSink = (event) => {
  const parts = [event.sendId, event.sessionId, event.detail]
    .filter((part): part is string => part !== undefined);
  console.log(`[messaging] ${new Date().toISOString()} ${event.stage} ${parts.join(' ')}`);
};

/** Explicit scope, operating assignment and rate limit for external-session adoption. */
export interface ExternalAdoptionOptions {
  readonly roots: ProviderTranscriptRoots;
  readonly limitPerTick?: number;
  readonly assignment: AdoptionAssignment;
  readonly conversations?: ConversationDirectory;
}

/** Production roots and cadence accepted by the Messaging composition door. */
export interface DefaultMessagingRuntimeOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly providerHome?: string;
  readonly intervalMs?: number;
  readonly agentDirectory?: AgentDirectory;
  readonly providerSend?: ProviderSend;
  readonly conversations?: ConversationDirectory;
  readonly conversationPrincipalId?: string;
  readonly installIdentityHooks?: boolean;
  readonly externalAdoption?: ExternalAdoptionOptions;
  readonly storeId?: StoreId;
  /**
   * Trace sink for observable messaging moments. Default-on: when omitted,
   * one structured line per moment goes to stdout. Pass a no-op to silence —
   * the sink is the only output channel this composition writes to.
   */
  readonly trace?: MessagingTraceSink;
}

/** Running contract plus one idempotent resource teardown operation. */
export interface ComposedMessagingRuntime {
  readonly runtime: MessagingRuntimeApi;
  close(): Promise<void>;
}

/**
 * Production composition for the one provider-file ingestion door.
 *
 * Failure modes: startup wiring fails fast with a typed `DependencyUnavailable`
 * naming the step in `fields.dependency` — `store-identity` (foundation could
 * not establish the store id), `provider-hooks` (a hook registration could not
 * be written), or `messaging-store` (the durable store could not be opened).
 * Foundation and the filesystem throw untyped errors; they are wrapped here so
 * no raw exception escapes the door. Once composed, the runtime speaks
 * `Outcome` for every operation.
 *
 * Crash recovery: every step is safe to retry — hook installs report
 * `unchanged` when already present — so the recovery owner is the caller
 * invoking this door again.
 */
export async function createDefaultMessagingRuntime(
  options: DefaultMessagingRuntimeOptions,
): Promise<ComposedMessagingRuntime> {
  const home = options.providerHome ?? homedir();
  const storeId = await composeStoreId(options);
  await installIdentityHooks(home, options.installIdentityHooks ?? true);
  const store = await composeStep('messaging-store', () => openMessagingStore(options));
  const runtime = createMessagingRuntime({
    store,
    source: createProviderTranscriptSource(providerRoots(home), {
      ...present('adoptRoots', options.externalAdoption?.roots),
    }),
    normalizers: {
      claude: providerNormalizer('claude'),
      codex: providerNormalizer('codex'),
      kimi: providerNormalizer('kimi'),
    },
    storeId,
    trace: options.trace ?? consoleTraceSink,
    ...present('agentDirectory', options.agentDirectory),
    ...present('providerSend', options.providerSend),
    ...present('conversations', options.conversations),
    ...present('conversationPrincipalId', options.conversationPrincipalId),
    ...present('adoption', adoptionOptions(options.externalAdoption)),
    ...present('intervalMs', options.intervalMs),
  });
  return {
    runtime,
    async close() {
      await runtime.stop();
      await store.close();
    },
  };
}

/** The store id the host supplied, or the one foundation establishes for this root. */
async function composeStoreId(options: DefaultMessagingRuntimeOptions): Promise<StoreId> {
  if (options.storeId !== undefined) return options.storeId;
  return composeStep('store-identity', async () => (await ensureStoreIdentity(options.root)).id);
}

/** Registers Novakai's identity hook with all three providers, unless the host opted out. */
async function installIdentityHooks(home: string, install: boolean): Promise<void> {
  if (!install) return;
  const command = agentIdentityHookCommand();
  await composeStep('provider-hooks', () => Promise.all([
    ensureClaudeIdentityHook({ providerHome: home, command }),
    ensureCodexIdentityHook({ providerHome: home, command }),
    ensureKimiIdentityHook({ providerHome: home, command }),
  ]));
}

/** The durable messaging store under the host's root. */
function openMessagingStore(options: DefaultMessagingRuntimeOptions): Promise<TranscriptStore> {
  return openFoundationTranscriptStore({
    root: options.root,
    dataRoot: options.dataRoot ?? path.join(options.root, 'stores'),
  });
}

/** Where each provider persists its session transcripts. */
function providerRoots(home: string): ProviderTranscriptRoots {
  return {
    claude: [path.join(home, '.claude', 'projects')],
    codex: [
      path.join(home, '.codex', 'sessions'),
      path.join(home, '.codex', 'archived_sessions'),
    ],
    kimi: [path.join(home, '.kimi-code', 'sessions')],
  };
}

/**
 * One startup wiring step. Foundation and fs failures arrive untyped; they
 * leave as a typed `DependencyUnavailable` naming the step. An already-typed
 * MessagingError passes through unchanged.
 */
const composeStep = async <T>(dependency: string, step: () => Promise<T> | T): Promise<T> => {
  try {
    return await step();
  } catch (cause) {
    if (cause instanceof MessagingError) throw cause;
    throw new MessagingError('DependencyUnavailable', {
      message: thrownMessageOr(cause, `Messaging compose failed: ${dependency}`),
      retryable: true,
      fields: { dependency },
    });
  }
};

/** The runtime's adoption wiring, or undefined when adoption is not configured. */
function adoptionOptions(externalAdoption: ExternalAdoptionOptions | undefined) {
  if (externalAdoption === undefined) return undefined;
  return {
    assignment: externalAdoption.assignment,
    ...present('conversations', externalAdoption.conversations),
    limitPerTick: externalAdoption.limitPerTick ?? 10,
  };
}
