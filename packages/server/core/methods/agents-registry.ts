/** Existing Agent registry methods. */

import type { AgentsContract } from '../../../agents/contract/index.js';
import { objectVersion } from '../../../shell/contract/persistence.node.js';
import type { MethodTable } from '../../contract/protocol.js';
import type { ServerRuntime } from './runtime.js';

export function buildAgentRegistryMethods(runtime: ServerRuntime): MethodTable {
  return {
    async listAgents() {
      const result = await runtime.agents.listAgents() as {
        ok: boolean;
        value?: { items: Array<Record<string, unknown>> };
      };
      if (!result.ok || !result.value) return [];
      return Promise.all(result.value.items.map(async (agent) => ({
        ...agent,
        version: await objectVersion(runtime.persistence.handle, 'agent', String(agent.id)),
      })));
    },
    async defineAgent(params: never) {
      const input = params as {
        input: Parameters<AgentsContract['defineAgent']>[0];
        clientOpId: string;
      };
      return runtime.agents.defineAgent(input.input, input.clientOpId as never);
    },
    async updateAgent(params: never) {
      const input = params as {
        id: string;
        patch: Parameters<AgentsContract['updateAgent']>[1];
        expectedVersion: number;
        clientOpId: string;
      };
      return runtime.agents.updateAgent(
        input.id as never,
        input.patch,
        input.expectedVersion,
        input.clientOpId as never,
      );
    },
    async setAgentModel(params: never) {
      const input = params as { agentId: string; model: string; clientOpId: string };
      return runtime.agents.setModel(
        input.agentId as never,
        input.model,
        input.clientOpId as never,
      );
    },
    async listSkills() {
      const result = await runtime.agents.listSkills() as {
        ok: boolean;
        value?: { items: unknown[] };
      };
      return result.ok && result.value ? result.value.items : [];
    },
  };
}
