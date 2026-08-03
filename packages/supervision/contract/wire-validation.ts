import {
  isValidId,
  type B3Page,
  type B3Result,
} from '@novakai/foundation/contract';
import type { CliOutput } from './cli.js';
import type { ContractError } from './errors.js';
import { SUPERVISION_ERROR_CODES } from './errors.js';
import { isUrlSafeEventCursor, parseNotificationRecord } from './event-validation.js';
import type { Notification, WatchDeadline, WatchRule } from './records.js';
import { parseWatchDeadline, parseWatchRule } from './record-validation.js';
import {
  finish,
  nonEmpty,
  objectValue,
  oneOf,
  wholeNumber,
  type ValidationIssue,
} from './validation-support.js';

/** Runtime parser for the visibility-aware Notification page output. */
export function parseNotificationPage(candidate: unknown): B3Result<B3Page<Notification>> {
  return parseRecordPage(candidate, parseNotificationRecord);
}

/** Runtime parser for the visibility-aware WatchRule page output. */
export function parseWatchRulePage(candidate: unknown): B3Result<B3Page<WatchRule>> {
  return parseRecordPage(candidate, parseWatchRule);
}

function parseRecordPage<Value>(
  candidate: unknown,
  parser: (value: unknown) => B3Result<Value>,
): B3Result<B3Page<Value>> {
  const issues: ValidationIssue[] = [];
  const page = objectValue(candidate, 'page', issues);
  if (!Array.isArray(page.items)) {
    issues.push({ path: 'items', message: 'must be an array' });
  } else {
    page.items.forEach((item, index) => {
      const parsed = parser(item);
      if (!parsed.ok) issues.push({ path: `items.${index}`, message: parsed.error.message });
    });
  }
  if (page.nextCursor !== undefined && !isUrlSafeEventCursor(page.nextCursor)) {
    issues.push({ path: 'nextCursor', message: 'must be a non-empty URL-safe string' });
  }
  if (!Array.isArray(page.omissions)) {
    issues.push({ path: 'omissions', message: 'must be an array' });
  } else {
    page.omissions.forEach((item, index) => validateOmission(item, index, issues));
  }
  return finish<B3Page<Value>>(candidate, issues);
}

function validateOmission(
  value: unknown,
  index: number,
  issues: ValidationIssue[],
): void {
  const omission = objectValue(value, `omissions.${index}`, issues);
  oneOf(
    omission.reason,
    ['permission', 'unsupported-version'],
    `omissions.${index}.reason`,
    issues,
  );
  wholeNumber(omission.count, 0, `omissions.${index}.count`, issues);
}

/** Runtime parser for install/create/update WatchRule outputs. */
export function parseWatchRuleList(candidate: unknown): B3Result<readonly WatchRule[]> {
  return parseRecordList(candidate, parseWatchRule, 'watchRules');
}

/** Runtime parser for claim/reset WatchDeadline outputs. */
export function parseWatchDeadlineList(candidate: unknown): B3Result<readonly WatchDeadline[]> {
  return parseRecordList(candidate, parseWatchDeadline, 'watchDeadlines');
}

function parseRecordList<Value>(
  candidate: unknown,
  parser: (value: unknown) => B3Result<Value>,
  path: string,
): B3Result<readonly Value[]> {
  const issues: ValidationIssue[] = [];
  if (!Array.isArray(candidate)) {
    issues.push({ path, message: 'must be an array' });
  } else {
    candidate.forEach((item, index) => {
      const parsed = parser(item);
      if (!parsed.ok) issues.push({ path: `${path}.${index}`, message: parsed.error.message });
    });
  }
  return finish<readonly Value[]>(candidate, issues);
}

function parseContractError(candidate: unknown): B3Result<ContractError> {
  const issues: ValidationIssue[] = [];
  const error = objectValue(candidate, 'error', issues);
  oneOf(error.code, SUPERVISION_ERROR_CODES, 'error.code', issues);
  nonEmpty(error.message, 'error.message', issues);
  objectValue(error.details, 'error.details', issues);
  if (error.code === 'RecoveryRequired') {
    const details = objectValue(error.details, 'error.details', issues);
    const operationId = details.operationId;
    const ownedOperation = isValidId(operationId, 'watchEvaluation', 'base32sha256')
      || isValidId(operationId, 'notificationDeliveryFenceOperation', 'base32sha256')
      || isValidId(operationId, 'receipt', 'base32sha256');
    if (!ownedOperation) {
      issues.push({
        path: 'error.details.operationId',
        message: 'must identify the owning Supervision evaluation, delivery fence, or claim receipt',
      });
    }
  }
  if (typeof error.retryable !== 'boolean') {
    issues.push({ path: 'error.retryable', message: 'must be a boolean' });
  }
  return finish<ContractError>(candidate, issues);
}

/** Runtime parser for §17.2 CLI JSON output using the command-specific value parser. */
export function parseCliOutput<Value>(
  candidate: unknown,
  parseValue: (value: unknown) => B3Result<Value>,
): B3Result<CliOutput<Value>> {
  const issues: ValidationIssue[] = [];
  const output = objectValue(candidate, 'cliOutput', issues);
  if (output.schemaVersion !== 1) {
    issues.push({ path: 'schemaVersion', message: 'must be 1' });
  }
  nonEmpty(output.command, 'command', issues);
  if (output.ok === true) {
    const value = parseValue(output.value);
    if (!value.ok) issues.push({ path: 'value', message: value.error.message });
  } else if (output.ok === false) {
    const error = parseContractError(output.error);
    if (!error.ok) issues.push({ path: 'error', message: error.error.message });
  } else {
    issues.push({ path: 'ok', message: 'must be a boolean' });
  }
  return finish<CliOutput<Value>>(candidate, issues);
}
