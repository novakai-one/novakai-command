// Typed surface of the schema law for TypeScript hosts. The .mjs remains the
// single authority; this only describes it. Kept to what a host legitimately
// needs to author a legal block — which store holds which kinds, and how an id
// for a kind must be shaped.

/** filename → kinds allowed in that store. */
export const STORE_KINDS: Readonly<Record<string, readonly string[]>>;

/** Ref kinds any block may carry. */
export const REF_KINDS: readonly string[];

/** Ref kinds whose targets must resolve to a record in these stores. */
export const RESOLVABLE_REF_KINDS: readonly string[];

/** The id shape a given kind must match. */
export function idPattern(kind: string): RegExp;

/** ISO-8601-with-offset shape required on `ts`. */
export const TS_PATTERN: RegExp;

/** Tombstone status; a refiled record names its successor in `refiledTo`. */
export const TOMBSTONE_STATUS: string;
export const TOMBSTONE_TARGET_KINDS: readonly string[];
