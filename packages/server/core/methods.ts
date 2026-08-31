/** The nvk-ws v1 method table, assembled from focused method modules. */

import type { MethodTable } from '../contract/protocol.js';
import { buildB2aMethods } from './b2a/methods.js';
import { buildAgentRegistryMethods } from './methods/agents-registry.js';
import { buildConversationMethods } from './methods/conversations.js';
import { buildMessageMethods } from './methods/messages.js';
import { buildRuntimeMethods } from './methods/runtime.js';
import type { ServerRuntime } from './methods/runtime.js';
import { buildSessionMethods } from './methods/sessions.js';
import { buildShellStateMethods } from './methods/shell-state.js';
import { buildSpawnMethods } from './methods/spawn.js';

export type { Conversation, ServerRuntime } from './methods/runtime.js';
export { persistView, summarize } from './methods/runtime.js';

export function buildMethods(runtime: ServerRuntime): MethodTable {
  return {
    ...buildB2aMethods(runtime.b2a),
    ...buildRuntimeMethods(runtime),
    ...buildConversationMethods(runtime),
    ...buildSpawnMethods(runtime),
    ...buildMessageMethods(runtime),
    ...buildShellStateMethods(runtime),
    ...buildAgentRegistryMethods(runtime),
    ...buildSessionMethods(runtime),
  };
}
