import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { TerminalRuntime } from '../runtime/index.js';
import type { AgentHealth } from '../health/index.js';

/** Neutral resume prompt (AGENTS.md writing conventions: observation, not
 * evaluation — never "you are stuck"). */
export const NUDGE_PROMPT = '[operator nudge] No terminal output has been observed from this session recently. If you are mid-task, please continue. If you are waiting or blocked, please report your current state.';

/** Typing rhythm matches the transport submit lane's ruled timing (delivery
 * DEFAULT_TIMINGS: settle 900ms; kimi needs the 6s flush \r). Duplicated by
 * design — the messaging fence forbids importing the delivery module. */
const NUDGE_SETTLE_MS = 900;
const KIMI_FLUSH_MS = 6000;

export type NudgeResult =
  | { status: 'accepted'; nudgeId: string }
  | { status: 'rejected'; reason: string };

/** One recorded operator nudge, typed through the PTY owner's serialized
 * submit lane — never the message router (fence). Fresh id per nudge: the
 * action is harmless to a healthy agent, so rate stays operator-owned
 * (no auto-nudge in v1). */
export class NudgeAction {
  private readonly recordPath: string;

  constructor(
    private readonly terminals: TerminalRuntime,
    recordPath?: string,
  ) {
    this.recordPath = recordPath ?? path.join(process.cwd(), '.novakai-command', 'nudges.jsonl');
  }

  execute(agentId: string, healthBefore: AgentHealth | null): NudgeResult {
    const agent = this.terminals.list().find((candidate) => candidate.agentId === agentId);
    if (!agent) return { status: 'rejected', reason: 'agent not found' };
    if (agent.status !== 'running') return { status: 'rejected', reason: 'agent is not running' };
    const nudgeId = `nudge_${randomUUID()}`;
    const submitted = this.terminals.submit({
      agentId, messageId: nudgeId, text: NUDGE_PROMPT, settleMs: NUDGE_SETTLE_MS,
      ...(agent.provider === 'kimi' ? { flushMs: KIMI_FLUSH_MS } : {}),
    });
    if (!submitted) return { status: 'rejected', reason: 'terminal submit failed' };
    this.record(nudgeId, agentId, healthBefore);
    return { status: 'accepted', nudgeId };
  }

  /** A record failure must not fail a delivered nudge — log and continue. */
  private record(nudgeId: string, agentId: string, healthBefore: AgentHealth | null): void {
    try {
      mkdirSync(path.dirname(this.recordPath), { recursive: true });
      appendFileSync(this.recordPath, `${JSON.stringify({
        id: nudgeId, kind: 'nudge', 'ts': new Date().toISOString(), agentId, healthBefore,
      })}\n`);
    } catch (error) {
      console.error(`[nudge] record failed for ${agentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
