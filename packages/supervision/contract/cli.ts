import type { ContractError } from './errors.js';

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
