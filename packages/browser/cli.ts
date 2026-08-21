// Thin CLI client. Binds a session id (--session or NVK_SESSION) and forwards one
// verb to that session's isolated browser. Fresh process per run — all state
// lives in the broker's registry, so the next run reconnects.
//
//   NVK_SESSION=<id> npx tsx packages/browser/cli.ts goto <url>
//   ... click <selector> | type <selector> <text...> | press <key>
//   ... text | eval <js...> | shot <path> | release
import { homedir } from 'node:os';
import path from 'node:path';
import { SessionBroker } from './broker.js';
import { ChromePool } from './provider/chrome-pool.js';
import { CdpControl } from './provider/cdp-control.js';
import type { ActionResult, BrowserCommand, CommandKind, LaunchSpec } from './domain/types.js';

const DEFAULT_REGISTRY_DIR = path.join(homedir(), '.novakai', 'browser', 'sessions');
// The single shared, watchable instance behind `--shared` (one for everyone).
const SHARED_SESSION_ID = '__shared__';

interface Invocation {
  sessionId: string;
  spec: LaunchSpec;
  verb: string;
  args: string[];
}

function parseInvocation(argv: string[]): Invocation {
  let sessionId = process.env.NVK_SESSION ?? '';
  let shared = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--session') {
      sessionId = argv[index + 1] ?? '';
      index += 1;
    } else if (argv[index] === '--shared') {
      shared = true;
    } else {
      rest.push(argv[index]);
    }
  }
  // Default: isolated, headless, one instance per agent (never fights, never
  // shows a window). `--shared`: one watchable windowed instance for everyone.
  if (shared) sessionId = SHARED_SESSION_ID;
  if (!sessionId) throw new Error('no session id: pass --session <id>, set NVK_SESSION, or use --shared');
  const [verb, ...args] = rest;
  if (!verb) throw new Error('no verb given');
  return { sessionId, spec: { headless: !shared }, verb, args };
}

function parseCommand(verb: string, args: string[]): BrowserCommand {
  switch (verb as CommandKind) {
    case 'goto': return { kind: 'goto', href: args[0] };
    case 'click': return { kind: 'click', selector: args[0] };
    case 'type': return { kind: 'type', selector: args[0], text: args.slice(1).join(' ') };
    case 'press': return { kind: 'press', text: args[0] };
    case 'text': return { kind: 'text' };
    case 'eval': return { kind: 'eval', script: args.join(' ') };
    case 'shot': return { kind: 'shot', shotPath: args[0] ?? path.join(process.cwd(), 'browse-shot.png') };
    default: throw new Error(`unknown verb "${verb}". Use: goto|click|type|press|text|eval|shot|release`);
  }
}

function emit(result: ActionResult): void {
  if (result.text !== undefined) process.stdout.write(`${result.text}\n`);
  const shot = result.shotPath ? `  -> ${result.shotPath}` : '';
  const problem = result.success ? '' : `  ERROR: ${result.error}`;
  process.stderr.write(`@ ${result.pageUrl}  "${result.title ?? ''}"${shot}${problem}\n`);
  if (!result.success) process.exitCode = 1;
}

async function main(): Promise<void> {
  const invocation = parseInvocation(process.argv.slice(2));
  const registryDir = process.env.NVK_BROWSER_REGISTRY ?? DEFAULT_REGISTRY_DIR;
  const broker = new SessionBroker({ provider: new ChromePool(), registryDir });
  if (invocation.verb === 'release') {
    await broker.release(invocation.sessionId);
    process.stderr.write(`released ${invocation.sessionId}\n`);
    return;
  }
  const command = parseCommand(invocation.verb, invocation.args);
  const handle = await broker.acquire(invocation.sessionId, process.env.NVK_AGENT ?? 'local', invocation.spec);
  const result = await new CdpControl().perform(handle.cdpEndpoint, command);
  if (result.success && command.kind === 'goto') broker.record(invocation.sessionId, result.pageUrl);
  emit(result);
}

main().catch((caught: unknown) => {
  process.stderr.write(`${caught instanceof Error ? caught.message : String(caught)}\n`);
  process.exitCode = 1;
});
