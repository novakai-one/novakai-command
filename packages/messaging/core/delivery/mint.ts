import { createHash } from 'node:crypto';
import { idPatterns, MessagingError, type PendingDeliveryId } from '../../contract/types.js';

/**
 * The one branded value the delivery slice mints is born here, checked
 * against the contract pattern before the brand is applied. A failed check
 * means minting drifted from the contract — a defect, not bad input — so it
 * halts as a non-retryable dependency failure instead of writing an
 * off-pattern id.
 */

const pendingDeliveryIdPattern = new RegExp(idPatterns.PendingDeliveryId, 'u');

/**
 * Deterministic PendingDelivery id for one (line, recipient) pair, so a
 * reconciler re-scan of the same transcript evidence finds the existing
 * delivery instead of queueing a second one.
 */
export function mintPendingDeliveryId(lineId: string, recipientAgentId: string): PendingDeliveryId {
  const candidate = `pendingDelivery_${createHash('sha256')
    .update(`${lineId}:${recipientAgentId}`)
    .digest('hex')}`;
  if (!pendingDeliveryIdPattern.test(candidate)) {
    throw new MessagingError('DependencyUnavailable', {
      message: 'minted PendingDeliveryId no longer matches the contract pattern',
      fields: { dependency: 'delivery-mint', kind: 'PendingDeliveryId', candidate },
    });
  }
  return candidate as PendingDeliveryId;
}
