// shell/demo/ensureAgent.ts — G4 glitch fix: defineDemoAgent ran on EVERY
// bridge boot, appending fresh Kimi/Fable/Mock defs to the persisted registry
// (Agents screen listed every agent ×N boots). Seeding is now idempotent:
// reuse an existing def with the same displayName + provider; define only
// when missing.

export interface AgentListItem {
  id: string; displayName: string; provider: string; status: string;
}
export interface EnsureAgentsContract {
  listAgents(): Promise<
    | { ok: true; value: { items: AgentListItem[] } }
    | { ok: false; error: { message: string } }
  >;
  defineAgent(
    input: { displayName: string; provider: string; model: string; hooks: never[]; status: 'defined'; permissionLevel: 'private' },
    clientOpId: string,
  ): Promise<
    | { ok: true; value: { id: string } }
    | { ok: false; error: { message: string } }
  >;
}

/** Idempotent demo-agent seed: returns the agent id, defining only if absent. */
export async function ensureAgent(
  agents: EnsureAgentsContract,
  displayName: string,
  provider: 'mock' | 'kimi',
  mintOpId: () => string,
): Promise<string> {
  const listed = await agents.listAgents();
  if (listed.ok) {
    const existing = listed.value.items.find(
      (a) => a.displayName === displayName && a.provider === provider && a.status === 'defined',
    );
    if (existing) return existing.id;
  }
  const res = await agents.defineAgent(
    { displayName, provider, model: provider === 'kimi' ? 'cli-default' : 'mock-model', hooks: [], status: 'defined', permissionLevel: 'private' },
    mintOpId(),
  );
  if (!res.ok) throw new Error(`defineAgent failed: ${res.error.message}`);
  return res.value.id;
}
