import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bestCall,
  callsByCondition,
  classifyValuation,
  isRenderableImage,
  maxBuyPrice,
  mergePreviewMeta,
  type BricksetHint,
  type CatalogHint,
  type EngineSetHint,
  type PreviewProvenance,
  type PreviewSources,
} from './setPreview.ts';
import { CONDITIONS, type Valuation } from './types.ts';
import { NO_DATA_REASON, verdict } from './verdict.ts';

const clean: PreviewProvenance = { derived: [], staleFrom: null };

function catalog(overrides: Partial<CatalogHint> = {}): CatalogHint {
  return {
    name: 'Millennium Falcon',
    year: 2017,
    theme: 'Star Wars',
    pieces: 7541,
    imageUrl: 'https://cdn.rebrickable.com/media/sets/75192-1.jpg',
    ...overrides,
  };
}

function brickset(overrides: Partial<BricksetHint> = {}): BricksetHint {
  return {
    name: 'Millennium Falcon (Brickset)',
    theme: 'Star Wars (Brickset)',
    year: 2016,
    usRetailPrice: 849.99,
    exitDate: new Date('2026-12-31T00:00:00Z'),
    imageUrl: 'https://images.brickset.com/sets/images/75192-1.jpg',
    ...overrides,
  };
}

function engine(overrides: Partial<EngineSetHint> = {}): EngineSetHint {
  return {
    name: 'Millennium Falcon (engine)',
    theme: 'Star Wars (engine)',
    pieces: 7500,
    msrp: 799.99,
    releaseYear: 2015,
    retireDate: new Date('2027-01-31T00:00:00Z'),
    ...overrides,
  };
}

function sources(overrides: Partial<PreviewSources> = {}): PreviewSources {
  return {
    setNumber: '75192-1',
    catalog: catalog(),
    brickset: brickset(),
    engine: engine(),
    cachedImageUrl: null,
    onWatchlist: false,
    ...overrides,
  };
}

function valuation(overrides: Partial<Valuation> = {}): Valuation {
  return {
    setNumber: '75192-1',
    condition: 'sealed',
    sealed: 1000,
    usedWithBox: 800,
    usedNoBox: null,
    partOut: 500,
    trend: 0.084,
    fetchedAt: new Date('2026-07-29T12:00:00Z'),
    fetchedOn: '2026-07-29',
    ...overrides,
  };
}

describe('maxBuyPrice — the ceiling a collapsed card shows instead of a fake BUY', () => {
  it('is the highest price that actually passes verdict(), to the cent', () => {
    const net = 958;
    const ceiling = maxBuyPrice(net);
    assert.ok(ceiling !== null);

    // The whole point: the number printed on the card must survive the engine's own test, and one
    // cent more must not. This pins the maths to verdict() rather than to a copied constant.
    assert.equal(verdict(ceiling, valuation({ sealed: 2000, partOut: 0 }), 'sealed').net > 0, true);
    const priced = valuation({ sealed: 1000, usedWithBox: null, partOut: 1 });
    const realNet = verdict(0, priced, 'sealed').net;
    const realCeiling = maxBuyPrice(realNet);
    assert.ok(realCeiling !== null);
    assert.equal(verdict(realCeiling, priced, 'sealed').buy, true);
    assert.equal(verdict(realCeiling + 0.01, priced, 'sealed').buy, false);
  });

  it('errs low rather than high when the bound lands exactly on a cent', () => {
    // net 1.25 / 1.25 = exactly 1.00, and `margin > buy * 0.25` is strict, so 1.00 PASSES.
    assert.equal(maxBuyPrice(1.25), 0.99);
  });

  it('has no answer when nothing clears the bar', () => {
    // Not 0, and not a negative: printing either would read as a ceiling that works.
    assert.equal(maxBuyPrice(0), null);
    assert.equal(maxBuyPrice(-40), null);
    assert.equal(maxBuyPrice(Number.NaN), null);
    assert.equal(maxBuyPrice(0.001), null);
  });
});

describe('callsByCondition — a set has an answer for every condition at once', () => {
  it('returns one per condition, in CONDITIONS order, from one stored row', () => {
    const calls = callsByCondition(valuation());
    assert.equal(calls.length, CONDITIONS.length);
    assert.deepEqual(
      calls.map((entry) => entry.condition),
      [...CONDITIONS],
    );
  });

  it('pins each ceiling to that condition’s own net', () => {
    const priced = valuation();
    for (const entry of callsByCondition(priced)) {
      assert.equal(entry.call.net, verdict(0, priced, entry.condition).net);
      assert.equal(entry.ceiling, maxBuyPrice(entry.call.net));
    }
  });

  it('reports "no used-market data" rather than pricing a used play off the sealed value', () => {
    // An in-production set: BrickEconomy publishes no used bands at all. 75192 is exactly this.
    const noUsed = valuation({ usedWithBox: null, usedNoBox: null });
    const calls = callsByCondition(noUsed);

    for (const condition of ['used_box', 'used_nobox'] as const) {
      const entry = calls.find((c) => c.condition === condition);
      assert.ok(entry);
      const resell = entry.call.strategies.find((s) => s.strategy === 'resell_used');
      assert.ok(resell);
      assert.equal(resell.eligible, false);
      if (!resell.eligible) assert.equal(resell.reason, NO_DATA_REASON);
    }

    // open_box gets there by a different route and must still never be priced: it is gated out
    // of resell_used entirely, so it reports the missing BAND rather than the missing data.
    const openBox = calls.find((c) => c.condition === 'open_box');
    assert.ok(openBox);
    const openResell = openBox.call.strategies.find((s) => s.strategy === 'resell_used');
    assert.ok(openResell);
    assert.equal(openResell.eligible, false);
    assert.equal(openBox.call.play, 'part_out');

    // The sealed answer is unaffected — the row still carries a real sealed figure.
    const sealed = calls.find((c) => c.condition === 'sealed');
    assert.ok(sealed);
    assert.equal(sealed.call.play, 'flip_sealed');
  });
});

describe('bestCall — the headline, which must never be shown without its condition', () => {
  it('picks the highest net across conditions', () => {
    const calls = callsByCondition(valuation());
    const best = bestCall(calls);
    assert.ok(best);
    assert.equal(best.call.net, Math.max(...calls.map((c) => c.call.net)));
  });

  it('breaks ties toward sealed, so an identical part-out net does not surface as "incomplete"', () => {
    // part_out is eligible under every condition and wins outright here, so all four nets tie.
    const partOutWins = valuation({ sealed: 1, usedWithBox: null, usedNoBox: null, partOut: 900 });
    const best = bestCall(callsByCondition(partOutWins));
    assert.ok(best);
    assert.equal(best.condition, 'sealed');
    assert.equal(best.call.play, 'part_out');
  });

  it('has no answer for an empty list', () => {
    assert.equal(bestCall([]), null);
  });
});

describe('classifyValuation — which cards may fill themselves in', () => {
  it('auto-fills only numbers fetched today', () => {
    assert.equal(classifyValuation('2026-07-29', clean, '2026-07-29'), 'fresh');
    assert.equal(classifyValuation('2026-07-28', clean, '2026-07-29'), 'stale');
  });

  it('treats a provisional row as stale even though it carries today’s date', () => {
    // The adapter files quota-exhausted fallbacks under today's key. Today's date is exactly what
    // makes one dangerous, so staleFrom has to outrank it or the card shows old money as current.
    const provisional: PreviewProvenance = { derived: [], staleFrom: '2026-07-01' };
    assert.equal(classifyValuation('2026-07-29', provisional, '2026-07-29'), 'stale');
  });
});

describe('mergePreviewMeta — best free source wins, and gaps stay gaps', () => {
  it('prefers the search payload for catalogue fields', () => {
    const meta = mergePreviewMeta(sources());
    assert.equal(meta.name, 'Millennium Falcon');
    assert.equal(meta.theme, 'Star Wars');
    assert.equal(meta.year, 2017);
    assert.equal(meta.pieces, 7541);
  });

  it('takes MSRP and the retirement date from Brickset, the only free source of either', () => {
    const meta = mergePreviewMeta(sources());
    assert.equal(meta.msrp, 849.99);
    assert.equal(meta.retireDate, '2026-12-31');
  });

  it('falls back through Brickset then the engine, then omits', () => {
    const only = mergePreviewMeta(sources({ catalog: null, brickset: null }));
    assert.equal(only.name, 'Millennium Falcon (engine)');
    assert.equal(only.pieces, 7500);
    assert.equal(only.msrp, 799.99);
    assert.equal(only.retireDate, '2027-01-31');

    const bare = mergePreviewMeta(
      sources({ setNumber: '99999-1', catalog: null, brickset: null, engine: null }),
    );
    assert.equal(bare.name, 'Set 99999-1');
    assert.equal(bare.theme, null);
    assert.equal(bare.year, null);
    assert.equal(bare.pieces, null);
    assert.equal(bare.msrp, null);
    assert.equal(bare.retireDate, null);
    assert.equal(bare.imageUrl, null);
  });

  it('reports a zero or blank source figure as missing, never as $0.00 or 0 pcs', () => {
    const meta = mergePreviewMeta(
      sources({
        catalog: catalog({ pieces: 0, theme: '   ', year: 0 }),
        brickset: brickset({ usRetailPrice: 0, theme: null, year: null }),
        engine: null,
      }),
    );
    assert.equal(meta.pieces, null);
    assert.equal(meta.msrp, null);
    assert.equal(meta.theme, null);
    assert.equal(meta.year, null);
  });

  it('prefers the search photo, then the cached one, then Brickset', () => {
    assert.equal(
      mergePreviewMeta(sources()).imageUrl,
      'https://cdn.rebrickable.com/media/sets/75192-1.jpg',
    );
    assert.equal(
      mergePreviewMeta(sources({ catalog: catalog({ imageUrl: null }), cachedImageUrl: 'https://cdn.rebrickable.com/cached.jpg' })).imageUrl,
      'https://cdn.rebrickable.com/cached.jpg',
    );
    assert.equal(
      mergePreviewMeta(sources({ catalog: catalog({ imageUrl: null }) })).imageUrl,
      'https://images.brickset.com/sets/images/75192-1.jpg',
    );
  });

  it('carries watchlist membership through untouched', () => {
    assert.equal(mergePreviewMeta(sources({ onWatchlist: true })).onWatchlist, true);
    assert.equal(mergePreviewMeta(sources()).onWatchlist, false);
  });
});

describe('isRenderableImage', () => {
  it('accepts the two hosts next.config.ts allowlists', () => {
    assert.equal(isRenderableImage('https://cdn.rebrickable.com/media/sets/a.jpg'), true);
    assert.equal(isRenderableImage('https://images.brickset.com/sets/images/a.jpg'), true);
  });

  it('rejects anything else, because next/image throws at render on an unconfigured host', () => {
    assert.equal(isRenderableImage('https://example.test/a.jpg'), false);
    assert.equal(isRenderableImage('http://cdn.rebrickable.com/a.jpg'), false);
    assert.equal(isRenderableImage(null), false);
  });
});
