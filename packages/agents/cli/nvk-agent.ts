#!/usr/bin/env node
// nvk-agent — CLI adapter over the SAME contract functions the server calls.
// Verbs: define | get | list | set-model | spawn | send | events | close
// Root: NOVAKAI_ROOT (default ./.novakai).
// Auth: bearer token from .novakai/tokens/ via --token or NOVAKAI_TOKEN
// (mirrors nvk-store); the token's principal is the ONLY createdBy
// source — NOVAKAI_PRINCIPAL is NOT honored.
// Adapter: NVK_AGENTS_ADAPTER=mock (default) — the real terminal runtime is
// wired by the app composition root (TerminalManager / TerminalHostClient);
// a CLI without a host gets the mock seam.
import { mintClientOpId, authenticate } from '@novakai/foundation/dist/contract/index.js';
import type { AgentId, SessionId } from '@novakai/foundation/dist/contract/brands.js';
import { composeAgents } from '../core/composition.js';
import { createAgentsContract } from '../core/contract.js';

interface CliArgs { [k: string]: string | boolean }

function parseArgs(argv: string[]): { verb: string; args: CliArgs } {
  const [verb = 'help', ...rest] = argv;
  const args: CliArgs = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i += 1; }
      else args[key] = true;
    }
  }
  return { verb, args };
}

const out = (v: unknown): void => { process.stdout.write(`${JSON.stringify(v, null, 2)}\n`); };
const die = (e: unknown): never => { process.stderr.write(`${JSON.stringify(e)}\n`); process.exit(1); };
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') die({ code: 'Usage', message: `--${name} is required` });
  return v as string;
};

async function main(): Promise<void> {
  const { verb, args } = parseArgs(process.argv.slice(2));
  const root = process.env.NOVAKAI_ROOT ?? '.novakai';

  // Every verb requires bearer auth against .novakai/tokens/ (same law as
  // nvk-store); the principal derives from the token, never from the env.
  const bearer = typeof args.token === 'string' ? args.token : (process.env.NOVAKAI_TOKEN ?? '');
  if (!bearer) {
    process.stderr.write('auth: provide --token <bearer> or NOVAKAI_TOKEN\n');
    process.exit(2);
  }
  const token = authenticate(root, bearer);
  if (!token) {
    die({ code: 'AuthFailed', message: 'bearer token not recognized', details: { cause: 'unknown bearer' }, retryable: false });
  }
  const ctx = composeAgents({ root, principal: token!.principal });
  const agents = createAgentsContract(ctx);

  switch (verb) {
    case 'define': {
      const res = await agents.defineAgent({
        displayName: str(args['display-name'] ?? args.name, 'display-name'),
        provider: str(args.provider, 'provider') as 'kimi' | 'claude' | 'codex' | 'mock',
        model: str(args.model, 'model'),
        permissionLevel: (args['permission-level'] as 'private' | 'team' | 'external' | undefined) ?? 'private',
        hooks: [],
        status: 'defined',
      }, mintClientOpId());
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'get': {
      const res = await agents.getAgent(str(args.agent ?? args.id, 'agent') as AgentId);
      return res.ok ? out(res.value) : die({ code: 'Unreachable' });
    }
    case 'list': {
      const res = await agents.listAgents();
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'set-model': {
      const res = await agents.setModel(
        str(args.agent, 'agent') as AgentId, str(args.model, 'model'), mintClientOpId());
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'spawn': {
      const res = await agents.spawnAgent(str(args.agent, 'agent') as AgentId, {
        ...(typeof args.model === 'string' ? { model: args.model } : {}),
        ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
      });
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'send': {
      const sessionId = str(args.session, 'session') as SessionId;
      // Contract-level send path: hooks fire (onMessagePre/onMessagePost).
      const okSend = await agents.sendToSession(sessionId, str(args.input, 'input'));
      return okSend ? out({ sent: true, sessionId }) : die({ code: 'SendFailed', message: 'no live session in this process, or session not running' });
    }
    case 'attach-hook': {
      const res = await agents.attachHook(
        str(args.agent, 'agent') as AgentId,
        str(args.event, 'event') as never,
        args.text !== undefined
          ? { kind: 'inject-context-text', text: str(args.text, 'text') }
          : { kind: 'log-to-trace', message: typeof args.message === 'string' ? args.message : '' },
        mintClientOpId());
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'detach-hook': {
      const res = await agents.detachHook(
        str(args.agent, 'agent') as AgentId, str(args.hook, 'hook'), mintClientOpId());
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'register-skill': {
      const res = await agents.registerSkill({
        name: str(args.name, 'name'), path: str(args.path, 'path'),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
      }, mintClientOpId());
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'list-skills': {
      const res = await agents.listSkills();
      return res.ok ? out(res.value) : die(res.error);
    }
    case 'events': {
      const ms = typeof args.ms === 'string' ? Number(args.ms) : 1000;
      const unsub = agents.subscribeAgentEvents((e) => out(e));
      await new Promise((r) => setTimeout(r, ms));
      unsub();
      return;
    }
    case 'close': {
      const okClose = agents.closeSession(str(args.session, 'session') as SessionId);
      return okClose ? out({ closed: true }) : die({ code: 'NotFound', message: 'no such live session in this process' });
    }
    default:
      die({ code: 'Usage', message: 'verbs: define | get | list | set-model | spawn | send | events | close' });
  }
}

void main();
