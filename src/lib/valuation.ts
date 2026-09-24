import { round2, round2OrNull } from './money.ts';
import type { EngineDeps } from './ports.ts';
import { SetNotFoundError, type Condition, type SetMeta, type ValuationResult } from './types.ts';

/**
 * The valuation engine. Pure in the sense that matters: it performs no I/O of its own and
 * imports no adapter — everything it touches arrives through `deps`.
 *
 * Caching is per set/condition/day. A hit returns without calling any provider.
 */
export async function getValuation(
  setNumber: string,
  condition: Condition,
  deps: EngineDeps,
): Promise<ValuationResult> {
  const fetchedOn = deps.clock.today();
  const set = await resolveSet(setNumber, deps);

  const cached = await deps.store.readValuation({ setNumber, condition, fetchedOn });
  if (cached !== null) {
    return {
      set,
      valuation: cached,
      source: 'cache',
      providers: { values: deps.values.name, partOut: deps.partOut.name },
    };
  }

  const [values, partOut] = await Promise.all([
    deps.values.getValues(setNumber),
    deps.partOut.getPartOut(setNumber),
  ]);

  const valuation = await deps.store.writeValuation({
    setNumber,
    condition,
    sealed: round2(values.sealed),
    // round2OrNull, not round2: a null band means "no data", and coercing it to 0 would
    // publish a $0.00 price.
    usedWithBox: round2OrNull(values.usedWithBox),
    usedNoBox: round2OrNull(values.usedNoBox),
    partOut: round2(partOut.partOut),
    trend: values.trend,
    fetchedAt: deps.clock.now(),
    fetchedOn,
  });

  return {
    set,
    valuation,
    source: 'fresh',
    providers: { values: deps.values.name, partOut: deps.partOut.name },
  };
}

/** Reads the stored Set row, falling back to the catalog on first sight of a set. */
async function resolveSet(setNumber: string, deps: EngineDeps): Promise<SetMeta> {
  const stored = await deps.store.readSet(setNumber);
  if (stored !== null) return stored;

  const fetched = await deps.catalog.getSet(setNumber);
  if (fetched === null) throw new SetNotFoundError(setNumber);

  await deps.store.upsertSet(fetched);
  return fetched;
}
