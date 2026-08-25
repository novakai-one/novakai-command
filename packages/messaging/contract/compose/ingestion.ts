import { homedir } from "node:os";
import path from "node:path";
import { createProviderTranscriptSource } from "../../adapters/provider-transcripts/source.js";
import { providerNormalizer } from "../../adapters/provider-transcripts/normalizers/index.js";
import { openFoundationTranscriptStore } from "../../adapters/stores/jsonl.js";
import { createMessagingRuntime } from "../../core/ingestion/watch.js";
import type { MessagingRuntimeApi } from "../runtime.js";
import type { AgentDirectory } from "../ports/agent-directory.js";
import type { AdoptionAssignment } from "../ports/agent-directory.js";
import type { ConversationDirectory } from "../ports/conversation-directory.js";
import type { ProviderSend } from "../ports/provider-send.js";
import { agentIdentityHookCommand } from "../../adapters/provider-hooks/agent-identity-hook.js";
import { ensureClaudeIdentityHook } from "../../adapters/provider-hooks/registrations/claude.js";
import { ensureCodexIdentityHook } from "../../adapters/provider-hooks/registrations/codex.js";
import { ensureKimiIdentityHook } from "../../adapters/provider-hooks/registrations/kimi.js";
import type { ProviderTranscriptRoots } from "../../adapters/provider-transcripts/source.js";

/** Explicit scope, operating assignment and rate limit for external-session adoption. */
export interface ExternalAdoptionOptions {
  readonly roots: ProviderTranscriptRoots;
  readonly limitPerTick?: number;
  readonly assignment: AdoptionAssignment;
  readonly conversations: ConversationDirectory;
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
  readonly installIdentityHooks?: boolean;
  readonly externalAdoption?: ExternalAdoptionOptions;
}

/** Running contract plus one idempotent resource teardown operation. */
export interface ComposedMessagingRuntime {
  readonly runtime: MessagingRuntimeApi;
  close(): Promise<void>;
}

/** Production composition for the one provider-file ingestion door. */
export async function createDefaultMessagingRuntime(
  options: DefaultMessagingRuntimeOptions,
): Promise<ComposedMessagingRuntime> {
  const home = options.providerHome ?? homedir();
  if (options.installIdentityHooks ?? true) {
    const command = agentIdentityHookCommand();
    await Promise.all([
      ensureClaudeIdentityHook({ providerHome: home, command }),
      ensureCodexIdentityHook({ providerHome: home, command }),
      ensureKimiIdentityHook({ providerHome: home, command }),
    ]);
  }
  const store = await openFoundationTranscriptStore({
    root: options.root,
    dataRoot: options.dataRoot ?? path.join(options.root, "stores"),
  });
  const runtime = createMessagingRuntime({
    store,
    source: createProviderTranscriptSource({
      claude: [path.join(home, ".claude", "projects")],
      codex: [
        path.join(home, ".codex", "sessions"),
        path.join(home, ".codex", "archived_sessions"),
      ],
      kimi: [path.join(home, ".kimi-code", "sessions")],
    }, {
      ...(options.externalAdoption === undefined
        ? {} : { adoptRoots: options.externalAdoption.roots }),
    }),
    normalizers: {
      claude: providerNormalizer("claude"),
      codex: providerNormalizer("codex"),
      kimi: providerNormalizer("kimi"),
    },
    ...(options.agentDirectory === undefined ? {} : { agentDirectory: options.agentDirectory }),
    ...(options.providerSend === undefined ? {} : { providerSend: options.providerSend }),
    ...(options.conversations === undefined ? {} : { conversations: options.conversations }),
    ...(options.externalAdoption === undefined ? {} : {
      adoption: {
        assignment: options.externalAdoption.assignment,
        conversations: options.externalAdoption.conversations,
        limitPerTick: options.externalAdoption.limitPerTick ?? 10,
      },
    }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
  });
  return {
    runtime,
    async close() {
      await runtime.stop();
      await store.close();
    },
  };
}
