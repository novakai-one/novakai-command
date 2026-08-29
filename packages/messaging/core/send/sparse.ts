/**
 * Builds one present-only field for a sparse record: `undefined` contributes
 * nothing, so absent keys stay absent under `exactOptionalPropertyTypes`
 * instead of being stored as explicit `undefined`. The cast is owned here —
 * it is the one place the "key is present exactly when the value is"
 * invariant is asserted.
 */
export function present<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): { readonly [K in Key]: Value } | Record<string, never> {
  const field = value === undefined ? {} : { [key]: value };
  return field as { readonly [K in Key]: Value } | Record<string, never>;
}
