import { pathToFileURL } from 'node:url';
import {
  novakaiAgentIdEnvironmentKey,
  parseAgentIdentityMarker,
  type AgentIdentityMarker,
} from '../../contract/agent-identity.js';

/** Creates the one provider-neutral marker from a CLI child environment. */
export function markerFromEnvironment(
  environment: NodeJS.ProcessEnv,
): AgentIdentityMarker | undefined {
  return parseAgentIdentityMarker({
    kind: 'novakai-agent-identity',
    schemaVersion: 1,
    hookEvent: 'UserPromptSubmit',
    agentId: environment[novakaiAgentIdEnvironmentKey],
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

const INLINE_HOOK = `const a=process.env.NOVAKAI_AGENT_ID;if(/^agent_[A-Za-z0-9-]+$/.test(a||'')){const m={kind:'novakai-agent-identity',schemaVersion:1,hookEvent:'UserPromptSubmit',agentId:a};process.stdout.write('NOVAKAI_AGENT_IDENTITY '+JSON.stringify(m)+'\\n')}`;

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
