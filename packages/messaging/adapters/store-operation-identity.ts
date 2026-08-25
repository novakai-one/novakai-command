import { createHash } from 'node:crypto';
import { canonicalJson } from '@novakai/foundation/contract';
import type { StoreOp } from './store-shared.js';

/** Stable logical identity shared by live persistence and one-time migration. */
export function operationKeyOf(operation: StoreOp): string {
  switch (operation.op) {
    case 'acceptance': return `acceptance:${operation.message.id}`;
    case 'room-thread': return `room-thread:${operation.thread.id}`;
    case 'delivery-transition':
      return `delivery-transition:${operation.delivery.id}:${operation.journal.sequence}`;
    case 'attempt': return `attempt:${operation.attempt.id}`;
    case 'policy':
      return `policy:${operation.contact?.personId ?? operation.dnd?.personId ?? '?'}:${operation.journal.sequence}`;
    case 'template': return `template:${operation.template.id}:${operation.journal.sequence}`;
    case 'settled': return `settled:${operation.messageId}`;
    case 'agent-endpoint-claim':
      return `agent-endpoint-claim:${operation.claim.id}:${operation.claim.state}`;
    case 'agent-inbox-transition':
      return `agent-inbox-transition:${operation.item.id}:${operation.item.state}`;
    case 'agent-endpoint-transfer':
      return `agent-endpoint-transfer:${operation.oldClaim.id}->${operation.newClaim.id}`;
    case 'direct-thread': return `direct-thread:${operation.thread.id}`;
  }
}

/** Canonical content digest used to reject same-key/different-payload retries. */
export const digestOf = (operation: StoreOp): string =>
  createHash('sha256').update(canonicalJson(operation), 'utf8').digest('hex');
