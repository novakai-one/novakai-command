#!/usr/bin/env node
// nvk-child — an agent spawns a child agent headlessly. No server involved.
//
//   nvk child spawn --name <name> --brief <text> [--model <id>] [--parent <agentId>]
//   nvk child send --session <sessionId> --agent <agentId> --text <text>
//
// spawn: appends the child Agent record (parentAgentId = caller, origin
// agent-spawned) directly to the store, then runs ONE provider CLI turn with
// the Novakai identity hook env set to the child's id. The child's reply and
// its provider sessionId come back on stdout as one JSON line.
//
// send: resumes that provider session for another turn. Same identity env.
//
// The running app is not contacted. Its Ingestion discovers the provider
// session file on its own and matches sessionId ↔ agentId from the hook's
// persisted evidence — the same path every other conversation takes.
//
// Caller identity comes from NOVAKAI_AGENT_ID (already present in every
// agent's environment) or --parent. Auth for the store write is the local
// bearer token from .novakai/tokens/ (NOVAKAI_TOKEN overrides).
import { spawn as spawnProcess } from 'node:child_process';
import {
  mintClientOpId, authenticate, loadTokens, ensureStoreIdentity,
} from '@novakai/foundation/dist/contract/index.js';
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

const out = (v: unknown): void => { process.stdout.write(`${JSON.stringify(v)}\n`); };
const die = (e: unknown): never => { process.stderr.write(`${JSON.stringify(e)}\n`); process.exit(1); };
const str = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || v === '') die({ code: 'Usage', message: `--${name} is required` });
  return v as string;
};

/** One `claude -p` turn. Returns the reply text and the provider sessionId. */
function oneClaudeTurn(input: {
  text: string;
  agentId: string;
  storeId: string;
  model?: string;
  resume?: string;
  cwd?: string;
}): Promise<{ reply: string; sessionId: string | null; exitCode: number | null }> {
  const cliPath = process.env.NVK_CLAUDE_CLI ?? 'claude';
  const args = ['-p', input.text, '--output-format', 'stream-json', '--verbose'];
  if (input.resume) args.push('--resume', input.resume);
  if (input.model && input.model !== 'cli-default') args.push('--model', input.model);
  return new Promise((resolve, reject) => {
    const child = spawnProcess(cliPath, args, {
      cwd: input.cwd ?? process.cwd(),
      env: {
        ...process.env,
        NOVAKAI_AGENT_ID: input.agentId,
        NOVAKAI_STORE_ID: input.storeId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let sessionId: string | null = null;
    const parts: string[] = [];
    let buffer = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        let parsed: {
          type?: string; session_id?: string;
          message?: { content?: unknown };
        };
        try { parsed = JSON.parse(line); } catch { continue; }
        if (sessionId === null && typeof parsed.session_id === 'string') {
          sessionId = parsed.session_id;
        }
        if (parsed.type !== 'assistant') continue;
        const content = parsed.message?.content;
        if (typeof content === 'string') { parts.push(content); continue; }
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (typeof part === 'object' && part !== null
            && (part as { type?: string }).type === 'text'
            && typeof (part as { text?: unknown }).text === 'string') {
            parts.push((part as { text: string }).text);
          }
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (cause) => reject(new Error(`failed to start ${cliPath}: ${cause.message}`)));
    child.on('close', (code) => {
      if (code !== 0 && parts.length === 0) {
        reject(new Error(`${cliPath} exited with code ${code}: ${stderr.trim().slice(-300)}`));
        return;
      }
      resolve({ reply: parts.join(''), sessionId, exitCode: code });
    });
  });
}

async function main(): Promise<void> {
  const { verb, args } = parseArgs(process.argv.slice(2));
  const root = (typeof args.root === 'string' ? args.root : undefined)
    ?? process.env.NOVAKAI_ROOT ?? '.novakai';

  // Local bearer: explicit flag/env first, otherwise the first token on disk.
  // This is a single-user local store; the caller can read the file anyway.
  const bearer = (typeof args.token === 'string' ? args.token : undefined)
    ?? process.env.NOVAKAI_TOKEN ?? loadTokens(root)[0]?.bearer ?? '';
  const token = authenticate(root, bearer);
  if (!token) {
    die({ code: 'AuthFailed', message: `no usable bearer token under ${root}/tokens` });
  }
  const storeId = (await ensureStoreIdentity(root)).id;
  const ctx = composeAgents({ root, principal: token!.principal, storeId });
  const agents = createAgentsContract(ctx);

  switch (verb) {
    case 'spawn': {
      const name = str(args.name, 'name');
      const brief = str(args.brief, 'brief');
      const parent = (typeof args.parent === 'string' ? args.parent : undefined)
        ?? process.env.NOVAKAI_AGENT_ID;
      const provider = (typeof args.provider === 'string' ? args.provider : 'claude') as 'claude';
      if (provider !== 'claude') {
        die({ code: 'Unsupported', message: 'only --provider claude is wired so far' });
      }
      const model = typeof args.model === 'string' ? args.model : 'cli-default';
      const defined = await agents.defineAgent({
        displayName: name,
        provider,
        model,
        origin: 'agent-spawned',
        ...(parent ? { parentAgentId: parent } : {}),
      }, mintClientOpId());
      if (!defined.ok) return die(defined.error);
      const child = defined.value;
      const turn = await oneClaudeTurn({
        text: brief,
        agentId: child.id,
        storeId,
        model,
        ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
      });
      return out({
        ok: true,
        childAgentId: child.id,
        ...(parent ? { parentAgentId: parent } : {}),
        sessionId: turn.sessionId,
        reply: turn.reply,
      });
    }
    case 'send': {
      const sessionId = str(args.session, 'session');
      const agentId = str(args.agent, 'agent');
      const text = str(args.text, 'text');
      const turn = await oneClaudeTurn({
        text,
        agentId,
        storeId,
        resume: sessionId,
        ...(typeof args.cwd === 'string' ? { cwd: args.cwd } : {}),
      });
      return out({
        ok: true,
        agentId,
        sessionId: turn.sessionId ?? sessionId,
        reply: turn.reply,
      });
    }
    default:
      process.stderr.write(
        'usage: nvk child spawn --name <name> --brief <text> [--model <id>] [--parent <agentId>]\n'
        + '       nvk child send --session <sessionId> --agent <agentId> --text <text>\n',
      );
      process.exit(verb === 'help' ? 0 : 2);
  }
}

main().catch((cause: unknown) => {
  die({ code: 'Failed', message: cause instanceof Error ? cause.message : String(cause) });
});
