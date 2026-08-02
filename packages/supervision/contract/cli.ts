import type { ContractError } from './errors.js';
import type { UpdateWatchRuleInput } from './api.js';
import type { WatchRule } from './records.js';

/** The seven canonical supervision CLI verbs from §17.1. */
export const SUPERVISION_CLI_COMMANDS = [
  'nvk watch add',
  'nvk watch list',
  'nvk watch update',
  'nvk watch remove',
  'nvk watch notifications',
  'nvk watch acknowledge',
  'nvk watch reset-drift',
] as const;

/** Canonical supervision CLI command prefix. */
export type SupervisionCliCommand = typeof SUPERVISION_CLI_COMMANDS[number];

/** Stable §17.2 JSON result envelope. */
export type CliOutput<Value> =
  | {
      readonly schemaVersion: 1;
      readonly ok: true;
      readonly command: string;
      readonly value: Value;
    }
  | {
      readonly schemaVersion: 1;
      readonly ok: false;
      readonly command: string;
      readonly error: ContractError;
    };

/** Stable process exit codes from §17.2. */
export type CliExitCode = 0 | 2 | 3 | 4 | 5 | 6;

/** Compile `nvk watch remove` into the existing CAS update; no delete path exists. */
export function watchRemoveRetirement(rule: WatchRule): UpdateWatchRuleInput {
  return {
    watchRuleId: rule.id,
    expectedRecordVersion: rule.recordVersion,
    replacement: {
      subject: rule.subject,
      condition: rule.condition,
      recipient: rule.recipient,
      deliveryMode: rule.deliveryMode,
      cooldownMs: rule.cooldownMs,
      status: 'retired',
      ...(rule.driftPolicy === undefined ? {} : { driftPolicy: rule.driftPolicy }),
      ...(rule.action === undefined ? {} : { action: rule.action }),
    },
  };
}
