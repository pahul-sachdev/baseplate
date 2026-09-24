import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Clock, EngineDeps, PartOutProvider, SetCatalogProvider, ValuationKey, ValuationStore, ValueProvider } from './ports.ts';
import { SetNotFoundError, type SetMeta, type Valuation } from './types.ts';
import { getValuation } from './valuation.ts';

const FALCON: SetMeta = {
  setNumber: '75192',
  name: 'Millennium Falcon (UCS)',
  theme: 'Star Wars',
  pieces: 7541,
  msrp: 799.99,
  releaseYear: 2017,
  retireDate: new Date('2023-12-31T00:00:00Z'),
  retired: true,
};

/** In-memory ValuationStore — the whole reason the engine takes ports. */
function memoryStore(seed: SetMeta[] = []) {
  const sets = new Map(seed.map((s) => [s.setNumber, s]));
  const valuations = new Map<string, Valuation>();
  const key = (k: ValuationKey) => `${k.setNumber}|${k.condition}|${k.fetchedOn}`;

  const store: ValuationStore = {
    readSet: async (setNumber) => sets.get(setNumber) ?? null,
    upsertSet: async (meta) => void sets.set(meta.setNumber, meta),
    readValuation: async (k) => valuations.get(key(k)) ?? null,
    writeValuation: async (v) => {
      valuations.set(key(v), v);
      return v;
    },
  };
  return { store, sets, valuations };
}

function countingProviders() {
  const calls = { values: 0, partOut: 0, catalog: 0 };

  const values: ValueProvider = {
    name: 'test-values',
    getValues: async () => {
      calls.values += 1;
      return { sealed: 749.99, usedWithBox: 520, usedNoBox: 430, trend: 0.042 };
    },
  };
  const partOut: PartOutProvider = {
    name: 'test-partout',
    getPartOut: async () => {
      calls.partOut += 1;
      return { partOut: 812.4, lotCount: 940 };
    },
  };
  const catalog: SetCatalogProvider = {
    name: 'test-catalog',
    getSet: async (setNumber) => {
      calls.catalog += 1;
      return setNumber === FALCON.setNumber ? FALCON : null;
    },
  };
  return { values, partOut, catalog, calls };
}

function stubClock(day: string): Clock & { set(day: string): void } {
  let current = day;
  return {
    today: () => current,
    now: () => new Date(`${current}T12:00:00Z`),
    set: (next: string) => {
      current = next;
    },
  };
}

function harness(options: { seedSets?: SetMeta[]; day?: string } = {}) {
  const { store, valuations, sets } = memoryStore(options.seedSets ?? []);
  const { values, partOut, catalog, calls } = countingProviders();
  const clock = stubClock(options.day ?? '2026-07-28');
  const deps: EngineDeps = { values, partOut, catalog, store, clock };
  return { deps, calls, clock, valuations, sets };
}

describe('getValuation — daily cache', () => {
  it('fetches from the providers on a cold call', async () => {
    const { deps, calls } = harness();

    const result = await getValuation('75192', 'sealed', deps);

    assert.equal(result.source, 'fresh');
    assert.equal(result.valuation.sealed, 749.99);
    assert.equal(result.valuation.partOut, 812.4);
    assert.equal(result.valuation.fetchedOn, '2026-07-28');
    assert.equal(calls.values, 1);
    assert.equal(calls.partOut, 1);
  });

  it('skips the refetch when the same set/condition was already fetched today', async () => {
    const { deps, calls } = harness();

    const first = await getValuation('75192', 'sealed', deps);
    const second = await getValuation('75192', 'sealed', deps);

    assert.equal(first.source, 'fresh');
    assert.equal(second.source, 'cache');
    // The point of the test: the providers were not touched a second time.
    assert.equal(calls.values, 1);
    assert.equal(calls.partOut, 1);
    assert.deepEqual(second.valuation, first.valuation);
  });

  it('treats a different condition as a separate cache entry', async () => {
    const { deps, calls, valuations } = harness();

    await getValuation('75192', 'sealed', deps);
    const other = await getValuation('75192', 'used_box', deps);

    assert.equal(other.source, 'fresh');
    assert.equal(calls.values, 2);
    assert.equal(valuations.size, 2);
  });

  it('refetches once the day rolls over', async () => {
    const { deps, calls, clock } = harness({ day: '2026-07-28' });

    await getValuation('75192', 'sealed', deps);
    clock.set('2026-07-29');
    const tomorrow = await getValuation('75192', 'sealed', deps);

    assert.equal(tomorrow.source, 'fresh');
    assert.equal(tomorrow.valuation.fetchedOn, '2026-07-29');
    assert.equal(calls.values, 2);
  });
});

describe('getValuation — set resolution', () => {
  it('falls back to the catalog and stores the set on first sight', async () => {
    const { deps, calls, sets } = harness();

    const result = await getValuation('75192', 'sealed', deps);

    assert.equal(calls.catalog, 1);
    assert.equal(result.set.name, 'Millennium Falcon (UCS)');
    assert.equal(sets.size, 1);
  });

  it('does not call the catalog when the set row already exists', async () => {
    const { deps, calls } = harness({ seedSets: [FALCON] });

    await getValuation('75192', 'sealed', deps);

    assert.equal(calls.catalog, 0);
  });

  it('throws SetNotFoundError for a set no catalog knows', async () => {
    const { deps } = harness();

    await assert.rejects(() => getValuation('00000', 'sealed', deps), SetNotFoundError);
  });
});

describe('getValuation — reporting', () => {
  it('names the providers behind the numbers', async () => {
    const { deps } = harness();

    const result = await getValuation('75192', 'sealed', deps);

    assert.deepEqual(result.providers, { values: 'test-values', partOut: 'test-partout' });
  });
});
