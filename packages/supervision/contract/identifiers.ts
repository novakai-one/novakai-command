import {
  isValidId,
  uuidv7,
  type B3Brand,
} from '@novakai/foundation/contract';

/** One mutable watcher definition, minted by Supervision as UUIDv7 (§4.1). */
export type WatchRuleId = B3Brand<string, 'WatchRuleId'>;

/** One deterministic deadline identity, owned by Supervision (§4.1). */
export type WatchDeadlineId = B3Brand<string, 'WatchDeadlineId'>;

/** One deterministic logical notification identity (§4.1, §9.2). */
export type NotificationId = B3Brand<string, 'NotificationId'>;

/** One deterministic activity-drift episode identity (§4.1, §9.2). */
export type DriftEpisodeId = B3Brand<string, 'DriftEpisodeId'>;

/** Agents-owned authoritative provider measurement evidence (§4.1, §5.5). */
export type ProviderUsageEvidenceId = B3Brand<string, 'ProviderUsageEvidenceId'>;

/** Terminal-owned deterministic reservation for one Notification delivery effect. */
export type NotificationInputReservationId = B3Brand<string, 'NotificationInputReservationId'>;

/** One resumable Supervision evaluation keyed by its committed trigger. */
export type WatchEvaluationId = B3Brand<string, 'WatchEvaluationId'>;

/** One retryable delivery-fence rebind operation. */
export type NotificationDeliveryFenceOperationId =
  B3Brand<string, 'NotificationDeliveryFenceOperationId'>;

/** Mint a new WatchRule identity using the mandated lowercase UUIDv7 body. */
export const mintWatchRuleId = (): WatchRuleId =>
  `watchRule_${uuidv7()}` as WatchRuleId;

/** Runtime guard for WatchRule identities. */
export const isWatchRuleId = (value: unknown): value is WatchRuleId =>
  isValidId(value, 'watchRule', 'uuidv7');

/** Runtime guard for WatchDeadline identities. */
export const isWatchDeadlineId = (value: unknown): value is WatchDeadlineId =>
  isValidId(value, 'watchDeadline', 'base32sha256');

/** Runtime guard for Notification identities. */
export const isNotificationId = (value: unknown): value is NotificationId =>
  isValidId(value, 'notification', 'base32sha256');

/** Runtime guard for DriftEpisode identities. */
export const isDriftEpisodeId = (value: unknown): value is DriftEpisodeId =>
  isValidId(value, 'driftEpisode', 'base32sha256');

/** Runtime guard for ProviderUsageEvidence identities crossing into Supervision. */
export const isProviderUsageEvidenceId = (
  value: unknown,
): value is ProviderUsageEvidenceId =>
  isValidId(value, 'providerUsage', 'base32sha256');

/** Runtime guard for Terminal's deterministic Notification input reservation. */
export const isNotificationInputReservationId = (
  value: unknown,
): value is NotificationInputReservationId =>
  isValidId(value, 'notificationInput', 'base32sha256');

/** Runtime guard for WatchEvaluation identities. */
export const isWatchEvaluationId = (value: unknown): value is WatchEvaluationId =>
  isValidId(value, 'watchEvaluation', 'base32sha256');

/** Runtime guard for Notification delivery-fence operation identities. */
export const isNotificationDeliveryFenceOperationId = (
  value: unknown,
): value is NotificationDeliveryFenceOperationId =>
  isValidId(value, 'notificationDeliveryFenceOperation', 'base32sha256');
