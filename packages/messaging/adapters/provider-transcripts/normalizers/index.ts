import type { ProviderName } from "../../../contract/types.js";
import type { ProviderNormalizer } from "../../../contract/ports/provider-transcript-source.js";
import { claudeNormalizer } from "./claude.js";
import { codexNormalizer } from "./codex.js";
import { kimiNormalizer } from "./kimi.js";

const normalizers: Readonly<Record<ProviderName, ProviderNormalizer>> = {
  claude: claudeNormalizer,
  codex: codexNormalizer,
  kimi: kimiNormalizer,
};

/** Resolves the pure normalizer owned by one provider adapter. */
export const providerNormalizer = (provider: ProviderName): ProviderNormalizer =>
  normalizers[provider];
