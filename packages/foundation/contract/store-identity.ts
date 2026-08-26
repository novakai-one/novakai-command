declare const storeIdBrand: unique symbol;

/** Stable identity of one `.novakai` data authority. */
export type StoreId = string & { readonly [storeIdBrand]: 'StoreId' };

/** Foundation-owned JSONL record stored once per `.novakai` root. */
export interface StoreIdentity {
  readonly id: StoreId;
  readonly kind: 'storeIdentity';
  readonly schemaVersion: 1;
  readonly createdAt: string;
}
