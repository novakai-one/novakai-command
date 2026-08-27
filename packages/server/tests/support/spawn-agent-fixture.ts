import type { AgentRunView } from '../../../agent-runtime/contract/index.js';
import { connectRuntime } from '../../core/b3/client.js';

export interface SpawnAgentFixtureInput {
  readonly root: string;
  readonly port: number;
  readonly roleName: string;
  readonly displayName: string;
  readonly workingDirectory: string;
}

/** Test setup through the internal Runtime door, never the removed public CLI verb. */
export async function spawnAgentFixture(input: SpawnAgentFixtureInput): Promise<AgentRunView> {
  const client = await connectRuntime({ root: input.root, port: input.port });
  try {
    const role = await client.call<{ id: string }>(
      'b3.agent.resolveRoleByName', { displayName: input.roleName },
    );
    if (!role.ok) throw new Error(`fixture role resolution failed: ${role.error.message}`);
    const spawned = await client.call<AgentRunView>('b3.agent.spawn', {
      roleProfileId: role.value.id,
      displayName: input.displayName,
      workingDirectory: input.workingDirectory,
    });
    if (!spawned.ok) throw new Error(`fixture spawn failed: ${spawned.error.message}`);
    return spawned.value;
  } finally {
    client.close();
  }
}
