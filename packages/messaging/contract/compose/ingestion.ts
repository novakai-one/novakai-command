import { homedir } from "node:os";
import path from "node:path";
import { createProviderTranscriptSource } from "../../adapters/provider-transcripts/source.js";
import { providerNormalizer } from "../../adapters/provider-transcripts/normalizers/index.js";
import { openFoundationTranscriptStore } from "../../adapters/stores/jsonl.js";
import { createMessagingRuntime } from "../../core/ingestion/watch.js";
import type { MessagingRuntimeApi } from "../runtime.js";

/** Production roots and cadence accepted by the Messaging composition door. */
export interface DefaultMessagingRuntimeOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly providerHome?: string;
  readonly intervalMs?: number;
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
    }),
    normalizers: {
      claude: providerNormalizer("claude"),
      codex: providerNormalizer("codex"),
      kimi: providerNormalizer("kimi"),
    },
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
