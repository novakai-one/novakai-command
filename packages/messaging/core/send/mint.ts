import { createHash } from 'node:crypto';
import {
  idPatterns,
  MessagingError,
  type RequestHash,
  type SendAttemptId,
  type SendId,
} from '../../contract/types.js';

/**
 * Every branded value the send slice mints is born here, checked against the
 * contract pattern before the brand is applied. A failed check means minting
 * drifted from the contract — a defect, not bad input — so it halts as a
 * non-retryable dependency failure instead of writing an off-pattern id.
 */

const sendIdPattern = new RegExp(idPatterns.SendId, 'u');
const sendAttemptIdPattern = new RegExp(idPatterns.SendAttemptId, 'u');
const requestHashPattern = new RegExp(idPatterns.RequestHash, 'u');

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

function mintDrift(kind: string, candidate: string): MessagingError {
  return new MessagingError('DependencyUnavailable', {
    message: `minted ${kind} no longer matches the contract pattern`,
    fields: { dependency: 'send-mint', kind, candidate },
  });
}

/** Deterministic Send id for one (issuer, clientOpId) pair; a retry finds the same journal. */
export function mintSendId(issuedBy: string, clientOpId: string): SendId {
  const candidate = `send_${sha256Hex(`${issuedBy}:${clientOpId}`)}`;
  if (!sendIdPattern.test(candidate)) throw mintDrift('SendId', candidate);
  return candidate as SendId;
}

/** Attempt id derived from the send and its attempt position. */
export function mintSendAttemptId(sendId: SendId, attemptIndex: number): SendAttemptId {
  const candidate = `sendAttempt_${sha256Hex(`${sendId}:${attemptIndex}`)}`;
  if (!sendAttemptIdPattern.test(candidate)) throw mintDrift('SendAttemptId', candidate);
  return candidate as SendAttemptId;
}

/** Key-sorted JSON, so two equal requests hash equal regardless of property order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonicalJson(item)}`).join(',')}}`;
}

/** Content hash of one accepted request; detects same-clientOpId-different-payload retries. */
export function mintRequestHash(payload: unknown): RequestHash {
  const candidate = sha256Hex(canonicalJson(payload));
  if (!requestHashPattern.test(candidate)) throw mintDrift('RequestHash', candidate);
  return candidate as RequestHash;
}
