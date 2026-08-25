import type { MessagingError } from "./types.js";

/** Typed public result; implementation exceptions never cross the door. */
export type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: MessagingError };
