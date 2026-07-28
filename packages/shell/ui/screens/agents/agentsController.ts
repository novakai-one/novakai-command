// shell/ui/screens/agents/agentsController.ts — the Agents screen's logic,
// separated so it is testable without a DOM. Every mutation mints its
// clientOpId at this interaction layer (DEC-S2-12) and goes through the
// ShellServices agents seam (shell stores NO agent/model truth, DEC-S2-5).
import type { AgentDefView, ShellServices } from '../../../contract/index.js';
import { mintShellOpId } from '../../../contract/index.js';

export interface AgentDraft {
  displayName: string;
  provider: AgentDefView['provider'];
  model: string;
  instructions: string;
  skills: string[]; // selected skill ids
}

/**
 * L15: every storable provider is pickable — mock included. The draft shows the
 * STORED provider verbatim; nothing is silently rewritten on display or save.
 */
export const PROVIDER_OPTIONS = [
  { value: 'kimi', label: 'kimi' },
  { value: 'claude', label: 'claude' },
  { value: 'codex', label: 'codex' },
  { value: 'mock', label: 'mock' },
] as const;

/** The edit draft for an existing def — stored values, verbatim (L15). */
export function draftFromAgent(agent: AgentDefView): AgentDraft {
  return {
    displayName: agent.displayName,
    provider: agent.provider,
    model: agent.model,
    instructions: agent.instructions,
    skills: agent.skills,
  };
}

type OpResult = { ok: true; value: AgentDefView } | { ok: false; error: { code: string; message: string } };

const unavailable = (): OpResult => ({
  ok: false,
  error: { code: 'ProviderUnavailable', message: 'agents service is not available in this host' },
});

/** AGT-003/DEC-S2-5: the model picker writes via agents.setModel ONLY. */
export async function saveModel(
  services: ShellServices, agentId: string, model: string,
): Promise<OpResult> {
  const trimmed = model.trim();
  if (!trimmed) {
    return { ok: false, error: { code: 'InvalidEnvelope', message: 'model must be a non-empty string' } };
  }
  if (!services.agents) return unavailable();
  return services.agents.setModel(agentId, trimmed, mintShellOpId());
}

/** Create (current = null) or edit (CAS at the def's current version). */
export async function saveDefinition(
  services: ShellServices, current: AgentDefView | null, draft: AgentDraft,
): Promise<OpResult> {
  if (!services.agents) return unavailable();
  const displayName = draft.displayName.trim();
  if (!displayName) {
    return { ok: false, error: { code: 'InvalidEnvelope', message: 'displayName must be a non-empty string' } };
  }
  if (current === null) {
    return services.agents.defineAgent({
      displayName, provider: draft.provider, model: draft.model.trim() || 'kimi-k2',
      instructions: draft.instructions, skills: draft.skills,
    }, mintShellOpId());
  }
  // Single-object mutation (R3-18): model has its own guaranteed path
  // (setModel) and is patched here only when unchanged drafts carry it along.
  return services.agents.updateAgent(current.id, {
    displayName, provider: draft.provider,
    instructions: draft.instructions, skills: draft.skills,
  }, current.version, mintShellOpId());
}
