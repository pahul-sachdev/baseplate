// The engine's entire outside world. Everything here is implemented in src/db/ and
// injected — src/lib/ never imports an implementation.

import type { Condition, PartOutQuote, SetMeta, Valuation, ValueQuote } from './types.ts';

/** Sealed and used resale values. Backed by BrickEconomy once keys are wired. */
export interface ValueProvider {
  readonly name: string;
  getValues(setNumber: string): Promise<ValueQuote>;
}

/** Part-out value. Backed by the BrickLink price guide once keys are wired. */
export interface PartOutProvider {
  readonly name: string;
  getPartOut(setNumber: string): Promise<PartOutQuote>;
}

/** Set metadata. Backed by Rebrickable once keys are wired. */
export interface SetCatalogProvider {
  readonly name: string;
  getSet(setNumber: string): Promise<SetMeta | null>;
}

export interface ValuationKey {
  setNumber: string;
  condition: Condition;
  /** Day key, "YYYY-MM-DD". */
  fetchedOn: string;
}

/**
 * Persistence: the daily valuation cache plus the Set rows it references.
 * Both live here so a cache hit needn't re-call the catalog API just to render a set's name.
 */
export interface ValuationStore {
  readSet(setNumber: string): Promise<SetMeta | null>;
  upsertSet(meta: SetMeta): Promise<void>;
  readValuation(key: ValuationKey): Promise<Valuation | null>;
  writeValuation(valuation: Valuation): Promise<Valuation>;
}

/** Injected so day-boundary behaviour is testable without faking global time. */
export interface Clock {
  /** Today in the app's fixed timezone, as "YYYY-MM-DD". */
  today(): string;
  now(): Date;
}

export interface EngineDeps {
  values: ValueProvider;
  partOut: PartOutProvider;
  catalog: SetCatalogProvider;
  store: ValuationStore;
  clock: Clock;
}
