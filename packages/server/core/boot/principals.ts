/** Boot steps 1–2: config, Human principal and Foundation persistence. */

import path from 'node:path';
import { composeShellPersistence } from '../../../shell/contract/persistence.node.js';
import { openConfigStore, type ConfigStore } from '../config/store.js';
import { canonicalDataRoot } from '../store-paths.js';
import type { BootNote, BootOptions, BootResult } from './contract.js';
import { refuse } from './contract.js';

const HUMAN_ROLE = 'Human';
const MINT_RUNBOOK =
  'run: npx tsx packages/server/cli/nvk-token.ts mint person_chris --grants layout,settings,conversationView --roles Human';

export async function composePrincipals(options: BootOptions, note: BootNote) {
  const opened = await openConfigStore({ root: options.root, principal: 'sys_spine' });
  if (!opened.ok) {
    return { ok: false as const, result: refuse('ConfigUnavailable', opened.error.message) };
  }
  const configStore: ConfigStore = opened.value;
  const config = configStore.current();
  note(
    1,
    'config',
    `${config.principals.length} principal(s), ${config.bindings.length} binding(s), allowMock=${config.dev.allowMock}`,
  );
  for (const missing of config.unresolvedPrincipals) {
    console.warn(
      `[nvk-server] principal "${missing.personId}" is unresolvable — ${missing.reason} (drawn absence, not a crash)`,
    );
  }
  const human = config.principals.find((principal) => principal.roles.includes(HUMAN_ROLE));
  if (!human) {
    const result: BootResult = refuse(
      'NoHumanPrincipal',
      `no principal with role "${HUMAN_ROLE}" in `
        + `${path.join(options.root, 'stores', 'config.jsonl')} — ${MINT_RUNBOOK}`,
    );
    return { ok: false as const, result };
  }
  const persistence = composeShellPersistence({
    root: options.root,
    dataRoot: canonicalDataRoot(options.root),
    principal: human.personId,
  });
  note(2, 'foundation', `store open at ${options.root} as ${human.personId}`);
  return { ok: true as const, configStore, config, human, persistence };
}
