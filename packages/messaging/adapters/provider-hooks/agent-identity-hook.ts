import { pathToFileURL } from 'node:url';
import {
  novakaiAgentIdEnvironmentKey,
  novakaiStoreIdEnvironmentKey,
  parseAgentIdentityMarker,
  type AgentIdentityMarker,
} from '../../contract/agent-identity.js';
import { present } from '../../core/sparse.js';

/** Creates the one provider-neutral marker from a CLI child environment. */
export function markerFromEnvironment(
  environment: NodeJS.ProcessEnv,
): AgentIdentityMarker | undefined {
  const storeId = environment[novakaiStoreIdEnvironmentKey];
  return parseAgentIdentityMarker({
    kind: 'novakai-agent-identity',
    schemaVersion: storeId === undefined ? 1 : 2,
    hookEvent: 'UserPromptSubmit',
    agentId: environment[novakaiAgentIdEnvironmentKey],
    ...present('storeId', storeId),
  });
}

/** Provider-hook entry point. It reads no Novakai store and emits one JSON line. */
export function runAgentIdentityHook(
  environment: NodeJS.ProcessEnv,
  write: (line: string) => void,
): boolean {
  const marker = markerFromEnvironment(environment);
  if (marker === undefined) return false;
  write(`NOVAKAI_AGENT_IDENTITY ${JSON.stringify(marker)}\n`);
  return true;
}

// Self-contained by design: provider configs execute this via `node -e`
// with no module resolution, so it cannot import the contract. Its two
// regex literals duplicate AGENT_ID / STORE_ID in contract/agent-identity.ts
// — a change there is only complete when this copy changes with it.
const INLINE_HOOK = `const a=process.env.NOVAKAI_AGENT_ID,s=process.env.NOVAKAI_STORE_ID;if(/^agent_[A-Za-z0-9-]+$/.test(a||'')){const v=/^store_[0-9a-f-]{36}$/.test(s||'')?2:1,m={kind:'novakai-agent-identity',schemaVersion:v,hookEvent:'UserPromptSubmit',agentId:a,...v===2?{storeId:s}:{}};process.stdout.write('NOVAKAI_AGENT_IDENTITY '+JSON.stringify(m)+'\\n')}`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Stable command embedded in provider hook configuration. */
export function agentIdentityHookCommand(nodePath = process.execPath): string {
  return `${shellQuote(nodePath)} -e ${shellQuote(INLINE_HOOK)}`;
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  process.stdin.resume();
  runAgentIdentityHook(process.env, (line) => process.stdout.write(line));
}
