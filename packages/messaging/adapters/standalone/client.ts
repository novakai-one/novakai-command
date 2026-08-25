/** Authenticated standalone-session command and query dispatch. */

import { MessagingError } from "../../contract/schemas.js";
import type { MessagingSession, Outcome } from "../../contract/api.js";
import type { PresenceId } from "../../contract/schemas.js";
import { WS_PROTOCOL_VERSION } from "../../contract/standalone/frames.js";
import type {
  AuthenticateFrame,
  CommandFrame,
  QueryFrame,
} from "../../contract/standalone/frames.js";
import type { CoreStack } from "../../contract/compose/stack.js";

export type SendProtocolError = (error: MessagingError, requestId?: string) => void;

export interface AuthenticationResult {
  session: MessagingSession;
}

export async function authenticateClient(
  stack: CoreStack,
  frame: AuthenticateFrame,
  sendError: SendProtocolError,
  sendAuthenticated: (session: MessagingSession) => void,
): Promise<AuthenticationResult | undefined> {
  if (frame.protocolVersion !== undefined && frame.protocolVersion !== WS_PROTOCOL_VERSION) {
    sendError(
      new MessagingError("VersionUnsupported", {
        message: `protocol version ${frame.protocolVersion} is not supported by this server`,
        retryable: false,
        fields: { supported: [WS_PROTOCOL_VERSION] },
      }),
      frame.requestId,
    );
    return undefined;
  }
  const outcome = await stack.authenticate(frame.credential);
  if (outcome.kind !== "authenticated") {
    sendError(outcome.error, frame.requestId);
    return undefined;
  }
  sendAuthenticated(outcome.session);
  return { session: outcome.session };
}

export interface CommandDispatchDeps {
  session: MessagingSession;
  stack: CoreStack;
  frame: CommandFrame;
  bindPresence: (presenceId: PresenceId) => boolean;
}

export interface CommandDispatchResult {
  outcome: Outcome<unknown>;
  presenceId?: PresenceId;
}

export async function dispatchClientCommand(
  deps: CommandDispatchDeps,
): Promise<CommandDispatchResult> {
  const { session, stack, frame } = deps;
  let outcome: Outcome<unknown>;
  switch (frame.name) {
    case "SendMessage":
      outcome = await session.sendMessage(frame.input);
      break;
    case "SendFromTemplate":
      outcome = await session.sendFromTemplate(frame.input);
      break;
    case "OpenPresence": {
      const opened = await session.openPresence(frame.input);
      if (opened.kind !== "ok") return { outcome: opened };
      const bound = deps.bindPresence(opened.value.presenceId);
      if (!bound) {
        await stack.registry.closePath(opened.value.presenceId);
        return {
          outcome: {
            kind: "error",
            error: new MessagingError("DependencyUnavailable", {
              message: "the connection's socket died before the Presence could be bound — the Presence was closed",
              retryable: false,
              fields: { dependency: "presence-transport", retryable: false },
            }),
          },
        };
      }
      return { outcome: opened, presenceId: opened.value.presenceId };
    }
    case "ClosePresence":
      outcome = await session.closePresence(frame.input);
      break;
    case "SetDndPolicy":
      outcome = await session.setDndPolicy(frame.input);
      break;
    case "SetContactPolicy":
      outcome = await session.setContactPolicy(frame.input);
      break;
    case "UpsertTemplate":
      outcome = await session.upsertTemplate(frame.input);
      break;
    case "RetireTemplate":
      outcome = await session.retireTemplate(frame.input);
      break;
  }
  return { outcome };
}

export async function dispatchClientQuery(
  session: MessagingSession,
  frame: QueryFrame,
): Promise<Outcome<unknown>> {
  switch (frame.name) {
    case "GetThread":
      return session.getThread(frame.input);
    case "ListThreadsForPerson":
      return session.listThreadsForPerson(frame.input);
    case "GetMessages":
      return session.getMessages(frame.input);
    case "GetInbox":
      return session.getInbox(frame.input);
    case "GetDelivery":
      return session.getDelivery(frame.input);
    case "GetPolicy":
      return session.getPolicy(frame.input);
    case "ListTemplates":
      return session.listTemplates(frame.input);
    case "GetPresence":
      return session.getPresence(frame.input);
  }
}

export function unexpectedInternalError(cause: unknown): MessagingError {
  return new MessagingError("DependencyUnavailable", {
    message: `unexpected internal error: ${cause instanceof Error ? cause.message : String(cause)}`,
    retryable: false,
    fields: { dependency: "internal", retryable: false },
  });
}
