// Who may do what to a terminal (§3.2 "authorise against current durable
// policy", §13.4, §22).
//
// B3a has one human at the keyboard, which is why this is small — but "one user
// today" is a fact about the deployment, not a property of the contract. The
// rules below are the ones §22 already states: a controller acts for the
// principal that created it, taking the keyboard from someone else is an act
// with authority, and stopping a session is lifecycle authority, never a window.
import {
  b3err, b3fail, b3ok, isSystemPrincipal,
  type B3ContractError, type B3Result, type B3SystemPrincipalId,
  type CommandContext, type PublicOperationName, type SystemCommandContext,
} from '@novakai/foundation/contract';
import { TERMINAL_TAKEOVER_SCOPE } from '../contract/api.js';
import type { ControllerAttachment } from '../contract/records.js';

export function permissionDenied(
  operation: PublicOperationName, reason: string, details: Readonly<Record<string, unknown>>,
): B3ContractError {
  return b3err('PermissionDenied', reason, { operation, ...details }, false);
}

/** Runtime and Terminal act for the machine; a window acts for one person. */
function actsForTheSystem(context: CommandContext): boolean {
  return context.principal.kind === 'system';
}

/**
 * A controller belongs to whoever opened it. Closing it, reshaping it, or
 * typing through it are all the same act — using that window — so they share
 * one rule rather than three that could drift apart.
 */
export function requireOwnAttachment(
  context: CommandContext, attachment: ControllerAttachment, operation: PublicOperationName,
): B3Result<null> {
  if (actsForTheSystem(context) || attachment.principalId === context.principal.id) {
    return b3ok(null);
  }
  return b3fail(permissionDenied(operation, 'that controller belongs to another principal', {
    attachmentId: attachment.id,
    terminalSessionId: attachment.terminalSessionId,
    reason: 'not-your-controller',
  }));
}

/**
 * §13.4: takeover is explicit AND authorised. Taking the keyboard back from
 * your own other window needs no permission — that is one person deciding where
 * they are typing. Taking it from someone else needs the verified scope.
 */
export function requireTakeoverAuthority(
  context: CommandContext, holder: ControllerAttachment, operation: PublicOperationName,
): B3Result<null> {
  if (actsForTheSystem(context) || holder.principalId === context.principal.id) return b3ok(null);
  if (context.principal.verifiedScopes.includes(TERMINAL_TAKEOVER_SCOPE)) return b3ok(null);
  return b3fail(permissionDenied(operation,
    'taking the input lease from another principal requires the terminal.takeover scope', {
      holderAttachmentId: holder.id,
      requiredScope: TERMINAL_TAKEOVER_SCOPE,
      reason: 'takeover-not-authorised',
    }));
}

/**
 * The system seams are typed as system-only, and a type is erased at runtime.
 * A forged context reaching a lifecycle command is exactly red gate 1's shape:
 * something that is not the Runtime stopping a session.
 */
export function requireSystemAuthority<Id extends B3SystemPrincipalId>(
  context: CommandContext, id: Id, operation: PublicOperationName,
): B3Result<SystemCommandContext<Id>> {
  if (isSystemPrincipal(context, id)) return b3ok(context);
  return b3fail(permissionDenied(operation, `only ${id} may perform this operation`, {
    principalId: context.principal.id, requiredPrincipalId: id, reason: 'lifecycle-authority',
  }));
}
