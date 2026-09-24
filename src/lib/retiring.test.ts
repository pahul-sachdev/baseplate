import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  absoluteUpside,
  applyBoardView,
  boardThemes,
  boardViewToQuery,
  DEFAULT_VIEW,
  parseBoardView,
  countUnpricedHidden,
  EXITED_AVAILABILITY,
  exitDatePrecision,
  forecastTier,
  forecastVerdict,
  isCandidate,
  isPositiveOrBetter,
  legoComExit,
  matchesBoardQuery,
  matchesFilters,
  monthsUntil,
  NO_FILTERS,
  POSITIVE_GROWTH,
  rankCandidates,
  relativeUpside,
  resolveRetirementDate,
  resolveWindowMonths,
  RETIRING_AVAILABILITY,
  retiringWindowFromEnv,
  sortCandidates,
  STRONG_GROWTH,
  TIER_LABELS,
  windowEnd,
  type BoardFilters,
  type CachedForecast,
  type RetiringInput,
  type RetiringRow,
} from './retiring.ts';

const TODAY = new Date('2026-07-28T00:00:00Z');
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function row(overrides: Partial<RetiringInput> = {}): RetiringInput {
  return { setNumber: '10312-1', exitDate: null, availability: null, ...overrides };
}

function boardRow(overrides: Partial<RetiringRow> = {}): RetiringRow {
  return {
    setNumber: '10312-1',
    name: 'Jazz Club',
    theme: 'Icons',
    year: 2023,
    exitDate: d('2026-12-31'),
    launchDate: null,
    availability: 'LEGO exclusive',
    usRetailPrice: 229.99,
    usDateLastAvailable: null,
    imageUrl: null,
    lastSynced: TODAY,
    ...overrides,
  };
}

function forecast(overrides: Partial<CachedForecast> = {}): CachedForecast {
  return {
    sealed: 100,
    forecast2y: 150,
    growth12m: 0.03,
    retiredDate: null,
    fetchedOn: '2026-07-28',
    ...overrides,
  };
}

const noForecasts = new Map<string, CachedForecast>();

describe('window configuration', () => {
  it('defaults to six months', () => {
    assert.equal(retiringWindowFromEnv({}), 6);
    assert.equal(retiringWindowFromEnv({ RETIRING_WINDOW_MONTHS: '' }), 6);
  });

  it('reads a valid override from the environment', () => {
    assert.equal(retiringWindowFromEnv({ RETIRING_WINDOW_MONTHS: '12' }), 12);
  });

  it('falls back rather than emptying the board on junk input', () => {
    // An empty board reads as "nothing is retiring" — a claim the data never made. Falling back
    // to the default keeps the page honest when the input is nonsense.
    for (const raw of ['abc', '-3', '0', '3.5', '999']) {
      assert.equal(retiringWindowFromEnv({ RETIRING_WINDOW_MONTHS: raw }), 6, raw);
    }
  });

  it('lets ?months= override the env default', () => {
    assert.equal(resolveWindowMonths('12', { RETIRING_WINDOW_MONTHS: '3' }), 12);
  });

  it('falls back to the env default when ?months= is absent or junk', () => {
    assert.equal(resolveWindowMonths(undefined, { RETIRING_WINDOW_MONTHS: '3' }), 3);
    assert.equal(resolveWindowMonths('abc', { RETIRING_WINDOW_MONTHS: '3' }), 3);
    assert.equal(resolveWindowMonths('-1', {}), 6);
  });

  it('moves the horizon by whole months', () => {
    assert.equal(windowEnd(TODAY, 6).toISOString().slice(0, 10), '2027-01-28');
  });
});

describe('isCandidate', () => {
  it('includes a set exiting inside the window', () => {
    assert.equal(isCandidate(row({ exitDate: d('2026-11-30') }), TODAY, 6), true);
  });

  it('includes one exiting exactly on the horizon', () => {
    assert.equal(isCandidate(row({ exitDate: d('2027-01-28') }), TODAY, 6), true);
  });

  it('excludes one exiting past the horizon', () => {
    assert.equal(isCandidate(row({ exitDate: d('2027-01-29') }), TODAY, 6), false);
  });

  it('excludes one that has already gone', () => {
    assert.equal(isCandidate(row({ exitDate: d('2026-07-27') }), TODAY, 6), false);
  });

  it('includes one exiting today', () => {
    assert.equal(isCandidate(row({ exitDate: TODAY }), TODAY, 6), true);
  });

  it('excludes a set with no exit date and no availability signal', () => {
    // "We don't know when this retires" is not evidence that it retires soon. Without this the
    // board fills with the entire catalogue.
    assert.equal(isCandidate(row(), TODAY, 6), false);
  });

  it('ignores distribution labels — they are not retirement signals', () => {
    // MEASURED over a full 4,814-set sync: all fourteen distinct availability values are
    // distribution labels, and none is a retirement state. Treating "LEGO exclusive" as one
    // would pull 908 sets onto the board on the strength of how they are sold.
    for (const label of ['LEGO exclusive', 'Retail', 'Promotional', 'Magazine gift', '{Not specified}']) {
      assert.equal(isCandidate(row({ availability: label }), TODAY, 6), false, label);
    }
  });

  it('keeps both availability lists empty, because the data has nothing to put in them', () => {
    // Empty by evidence, not by omission — the constants exist so a future sync can be re-checked
    // against them. If either ever gains a value, the branches below start firing.
    assert.deepEqual([...RETIRING_AVAILABILITY], []);
    assert.deepEqual([...EXITED_AVAILABILITY], []);
  });

  it('widens with the window', () => {
    const far = row({ exitDate: d('2027-06-30') });
    assert.equal(isCandidate(far, TODAY, 6), false);
    assert.equal(isCandidate(far, TODAY, 12), true);
  });
});

describe('rankCandidates', () => {
  it('puts the soonest exit first', () => {
    const ranked = rankCandidates([
      row({ setNumber: 'c', exitDate: d('2026-12-31') }),
      row({ setNumber: 'a', exitDate: d('2026-08-01') }),
      row({ setNumber: 'b', exitDate: d('2026-10-15') }),
    ]);
    assert.deepEqual(ranked.map((r) => r.setNumber), ['a', 'b', 'c']);
  });

  it('sinks unknown exit dates to the bottom', () => {
    // An unknown date is the weakest signal on the board; floating it to the top would rank
    // ignorance as urgency.
    const ranked = rankCandidates([
      row({ setNumber: 'unknown', exitDate: null }),
      row({ setNumber: 'known', exitDate: d('2026-12-31') }),
    ]);
    assert.deepEqual(ranked.map((r) => r.setNumber), ['known', 'unknown']);
  });

  it('breaks ties on set number so the order is stable across renders', () => {
    const ranked = rankCandidates([
      row({ setNumber: '10313-1', exitDate: d('2026-12-31') }),
      row({ setNumber: '10312-1', exitDate: d('2026-12-31') }),
    ]);
    assert.deepEqual(ranked.map((r) => r.setNumber), ['10312-1', '10313-1']);
  });

  it('does not mutate its input', () => {
    const input = [row({ setNumber: 'b', exitDate: d('2026-12-31') }), row({ setNumber: 'a', exitDate: d('2026-08-01') })];
    rankCandidates(input);
    assert.equal(input[0]?.setNumber, 'b');
  });
});

describe('monthsUntil', () => {
  it('counts whole months', () => {
    assert.equal(monthsUntil(d('2026-11-28'), TODAY), 4);
  });

  it('does not round a partial month up', () => {
    // 2026-11-27 is one day short of four whole months; claiming four would overstate the runway.
    assert.equal(monthsUntil(d('2026-11-27'), TODAY), 3);
  });

  it('floors at zero rather than reporting negative months', () => {
    assert.equal(monthsUntil(d('2026-07-01'), TODAY), 0);
  });
});

describe('exitDatePrecision', () => {
  it('reads December 31 as a year bucket', () => {
    // 2,055 of the 2,503 exit dates in a full sync are December 31. 10312 lists 2025-12-31 while
    // LEGO.com actually stopped on 2025-11-22 — the day is not a fact.
    assert.equal(exitDatePrecision(d('2025-12-31')), 'year');
    assert.equal(exitDatePrecision(d('2026-12-31')), 'year');
  });

  it('reads any other month end as a month bucket', () => {
    // 475 of the 476 candidates in the live six-month window land on the 31st. Rendering
    // "2026-07-31" as an exact day would invent precision one step more subtly than inventing
    // a date outright.
    assert.equal(exitDatePrecision(d('2026-07-31')), 'month');
    assert.equal(exitDatePrecision(d('2026-11-30')), 'month');
    assert.equal(exitDatePrecision(d('2026-02-28')), 'month');
  });

  it('handles a leap February', () => {
    assert.equal(exitDatePrecision(d('2028-02-29')), 'month');
    assert.equal(exitDatePrecision(d('2028-02-28')), 'day');
  });

  it('reads a genuine mid-month date as a day', () => {
    // The handful that are real: promos and gifts-with-purchase, e.g. 40779-1 on 2026-01-18.
    assert.equal(exitDatePrecision(d('2026-01-18')), 'day');
    assert.equal(exitDatePrecision(d('2025-11-22')), 'day');
    assert.equal(exitDatePrecision(d('2025-12-30')), 'day');
  });
});

describe('forecastVerdict', () => {
  it('flags a forecast above the current sealed value', () => {
    const verdict = forecastVerdict({ sealed: 918, forecast2y: 1100, growth12m: 0.031 });
    assert.equal(verdict.positive, true);
  });

  it('does not flag a forecast below current value', () => {
    assert.equal(forecastVerdict({ sealed: 918, forecast2y: 800, growth12m: null }).positive, false);
  });

  it('does not flag a flat forecast', () => {
    // Strictly greater: breaking even is not a positive forecast.
    assert.equal(forecastVerdict({ sealed: 918, forecast2y: 918, growth12m: null }).positive, false);
  });

  it('answers null when a figure is missing, never false and never zero', () => {
    // "We cannot tell" is a third answer. Collapsing it to false would render an unvalued set
    // identically to one that was valued and rejected.
    assert.equal(forecastVerdict({ sealed: null, forecast2y: 1100, growth12m: null }).positive, null);
    assert.equal(forecastVerdict({ sealed: 918, forecast2y: null, growth12m: null }).positive, null);
    assert.equal(forecastVerdict({ sealed: null, forecast2y: null, growth12m: null }).sealed, null);
  });

  it('passes the figures through untouched', () => {
    const verdict = forecastVerdict({ sealed: 918, forecast2y: 1100, growth12m: 0.031 });
    assert.equal(verdict.sealed, 918);
    assert.equal(verdict.forecast2y, 1100);
    assert.equal(verdict.growth12m, 0.031);
  });
});

describe('forecastTier', () => {
  const at = (sealed: number | null, forecast2y: number | null) =>
    forecastTier({ sealed, forecast2y, growth12m: null });

  it('bands growth into four tiers', () => {
    // The whole point: forecastVerdict calls +5% and +100% alike, and these do not.
    assert.equal(at(100, 75)?.tier, 'negative');
    assert.equal(at(100, 105)?.tier, 'flat'); // real growth, still not worth acting on
    assert.equal(at(100, 125)?.tier, 'positive');
    assert.equal(at(100, 200)?.tier, 'strong');
  });

  it('treats a small LOSS as flat too — the band is symmetric', () => {
    // -0.5% forecasts nothing, exactly as +0.5% does. Calling one Flat and the other Negative
    // would put a warning colour on the arithmetic sign rather than on a finding.
    assert.equal(at(100, 99.5)?.tier, 'flat');
    assert.equal(at(100, 90)?.tier, 'flat'); // -10%: inside the band, so still a non-event
    assert.equal(at(100, 84)?.tier, 'negative'); // -16%: past the bar, a real drop
  });

  it('puts every boundary in the HIGHER tier — lower bounds are inclusive', () => {
    assert.equal(at(100, 85)?.tier, 'flat'); // exactly -POSITIVE_GROWTH
    assert.equal(at(100, 100)?.tier, 'flat'); // exactly zero: a non-event, not a loss
    assert.equal(at(100, 115)?.tier, 'positive'); // exactly POSITIVE_GROWTH
    assert.equal(at(100, 140)?.tier, 'strong'); // exactly STRONG_GROWTH
  });

  it('puts a hair under a boundary in the lower tier', () => {
    assert.equal(at(100, 84.99)?.tier, 'negative');
    assert.equal(at(100, 114.99)?.tier, 'flat');
    assert.equal(at(100, 139.99)?.tier, 'positive');
  });

  it('uses ONE threshold for both edges of the flat band', () => {
    // Mirrored, not a second magic number: the flat band is exactly POSITIVE_GROWTH wide on each
    // side of zero, so retuning that one constant moves both bars together. Read the edges back
    // off the grades rather than multiplying through them — 100 * (1 - 0.15) is not exactly 85.
    assert.equal(at(100, 85)?.growthPct, -POSITIVE_GROWTH);
    assert.equal(at(100, 115)?.growthPct, POSITIVE_GROWTH);
    assert.equal(at(100, 85)?.tier, 'flat');
    assert.equal(at(100, 115)?.tier, 'positive');
  });

  it('pins the thresholds, so retuning them is a deliberate edit', () => {
    // These two numbers are what the badge means, and the fixtures above are written against them.
    assert.equal(POSITIVE_GROWTH, 0.15);
    assert.equal(STRONG_GROWTH, 0.4);
    assert.ok(POSITIVE_GROWTH < STRONG_GROWTH); // otherwise 'positive' is an unreachable band
  });

  it('carries both numbers: the fraction and the dollars', () => {
    // The badge shows both, because "Positive" alone spans +15% to +39%.
    assert.deepEqual(at(100, 150), { tier: 'strong', growthPct: 0.5, growthAbs: 50 });
  });

  it('answers null when there is nothing to grade, never a tier', () => {
    // "We cannot tell" is a third answer. Flat would render an unvalued set identically to one
    // that was valued and found to be going nowhere.
    assert.equal(forecastTier(undefined), null);
    assert.equal(at(null, 150), null);
    assert.equal(at(100, null), null);
  });

  it('refuses to grade a set priced at nothing, even with a forecast', () => {
    // Growth from zero is undefined, not +400% — and Infinity clears STRONG_GROWTH, so this guard
    // is all that stands between a worthless set and a Strong badge. Its DOLLAR upside is still
    // real and still sorts; only the percentage is missing, so only the tier is.
    assert.equal(at(0, 500), null);
    assert.equal(at(-10, 500), null);
    assert.equal(absoluteUpside({ sealed: 0, forecast2y: 500, growth12m: null }), 500);
  });

  it('never grades a non-finite figure as Strong', () => {
    // readModels.finite() means NaN cannot arrive from the cache, but NaN loses every comparison
    // in the band chain and would fall out the far end labelled Strong.
    assert.equal(at(Number.NaN, 150), null);
    assert.equal(at(100, Number.NaN), null);
    assert.equal(at(100, Number.POSITIVE_INFINITY), null);
  });
});

describe('isPositiveOrBetter', () => {
  const grade = (sealed: number, forecast2y: number) =>
    forecastTier({ sealed, forecast2y, growth12m: null });

  it('passes Positive and Strong, and nothing else', () => {
    assert.equal(isPositiveOrBetter(grade(100, 200)), true);
    assert.equal(isPositiveOrBetter(grade(100, 125)), true);
    // The bug this replaces: +5% used to count as a positive forecast.
    assert.equal(isPositiveOrBetter(grade(100, 105)), false);
    assert.equal(isPositiveOrBetter(grade(100, 100)), false);
    assert.equal(isPositiveOrBetter(grade(100, 90)), false); // flat-by-symmetry
    assert.equal(isPositiveOrBetter(grade(100, 75)), false); // genuinely negative
  });

  it('does not pass an ungraded forecast — unjudged is not judged good', () => {
    assert.equal(isPositiveOrBetter(null), false);
  });
});

describe('TIER_LABELS', () => {
  it('names every tier, distinctly', () => {
    // The Record type already forbids a missing key; this guards what it cannot — empty or
    // duplicate labels, which would make two bands indistinguishable on the badge.
    const labels = Object.values(TIER_LABELS);
    assert.equal(labels.length, 4);
    assert.equal(new Set(labels).size, 4);
    assert.ok(labels.every((label) => label !== ''));
  });
});

describe('resolveRetirementDate — precedence by event, not by source rank', () => {
  it('takes a FUTURE LEGO.com date as the retirement day', () => {
    const resolved = resolveRetirementDate(
      { exitDate: d('2026-12-31'), usDateLastAvailable: d('2026-09-15') },
      undefined,
      TODAY,
    );
    assert.equal(resolved?.source, 'lego.com');
    assert.equal(resolved?.precision, 'day');
    assert.equal(resolved?.isPast, false);
    assert.equal(resolved?.date.toISOString().slice(0, 10), '2026-09-15');
  });

  it('does NOT let a past LEGO.com date take the headline', () => {
    // dateLastAvailable marks a DIFFERENT event — direct sales ending, which happens first. A past
    // one says the channel closed, not that the set retired. MEASURED: all 4,814 synced rows carry
    // only past values, so this is the branch that actually runs.
    const resolved = resolveRetirementDate(
      { exitDate: d('2026-07-31'), usDateLastAvailable: d('2026-05-12') },
      undefined,
      TODAY,
    );
    assert.equal(resolved?.source, 'brickset');
    assert.equal(resolved?.date.toISOString().slice(0, 10), '2026-07-31');
  });

  it('prefers a BrickEconomy retired_date over a Brickset bucket, even when past', () => {
    // Both date the same event; BrickEconomy observed it and Brickset guessed at it. A past value
    // means "already retired, Brickset has not caught up" — better information, not worse.
    const resolved = resolveRetirementDate(
      { exitDate: d('2026-12-31'), usDateLastAvailable: null },
      forecast({ retiredDate: d('2026-06-02') }),
      TODAY,
    );
    assert.equal(resolved?.source, 'brickeconomy');
    assert.equal(resolved?.precision, 'day');
    assert.equal(resolved?.isPast, true);
  });

  it('falls through to Brickset when the cached snapshot has no retired_date', () => {
    // The normal case for a retiring-soon set: BrickEconomy publishes retired_date only once a set
    // has actually retired, so a candidate's snapshot carries none.
    const resolved = resolveRetirementDate(
      { exitDate: d('2026-12-31'), usDateLastAvailable: null },
      forecast({ retiredDate: null }),
      TODAY,
    );
    assert.equal(resolved?.source, 'brickset');
  });

  it('keeps Brickset’s bucketing honest at every precision', () => {
    const at = (iso: string) =>
      resolveRetirementDate({ exitDate: d(iso), usDateLastAvailable: null }, undefined, TODAY);
    assert.equal(at('2026-12-31')?.precision, 'year');
    assert.equal(at('2026-08-31')?.precision, 'month');
    assert.equal(at('2026-08-14')?.precision, 'day');
  });

  it('returns null when nothing is known, rather than inventing a date', () => {
    assert.equal(resolveRetirementDate({ exitDate: null, usDateLastAvailable: null }, undefined, TODAY), null);
    // A past LEGO.com date alone is not a retirement date, so this stays null too.
    assert.equal(
      resolveRetirementDate({ exitDate: null, usDateLastAvailable: d('2026-05-12') }, undefined, TODAY),
      null,
    );
  });
});

describe('legoComExit', () => {
  it('surfaces a past date as its own separate fact', () => {
    assert.equal(legoComExit({ usDateLastAvailable: d('2026-05-12') }, TODAY)?.toISOString().slice(0, 10), '2026-05-12');
  });

  it('stays silent for a future date, which is already the headline', () => {
    assert.equal(legoComExit({ usDateLastAvailable: d('2026-09-15') }, TODAY), null);
    assert.equal(legoComExit({ usDateLastAvailable: null }, TODAY), null);
  });
});

describe('upside metrics', () => {
  it('separates absolute dollars from relative percentage', () => {
    // The whole reason "opportunity" and "discount to forecast" are two sorts: a big set can lead
    // on dollars while a small one leads on percentage.
    const big = forecast({ sealed: 650, forecast2y: 750 });
    const small = forecast({ sealed: 30, forecast2y: 50 });

    assert.equal(absoluteUpside(big), 100);
    assert.equal(absoluteUpside(small), 20);
    assert.ok((relativeUpside(small) ?? 0) > (relativeUpside(big) ?? 0));
  });

  it('answers null when a figure is missing, never zero', () => {
    assert.equal(absoluteUpside(undefined), null);
    assert.equal(absoluteUpside(forecast({ sealed: null })), null);
    assert.equal(relativeUpside(forecast({ forecast2y: null })), null);
  });

  it('refuses to divide by a zero sealed value', () => {
    // Infinity would sort a worthless set above every genuine opportunity on the board.
    assert.equal(relativeUpside(forecast({ sealed: 0, forecast2y: 50 })), null);
  });
});

describe('sortCandidates', () => {
  const eiffel = boardRow({ setNumber: '10307-1', exitDate: d('2026-07-31') });
  const optimus = boardRow({ setNumber: '10302-1', exitDate: d('2026-07-31') });
  const plain = boardRow({ setNumber: '99999-1', exitDate: d('2026-07-31') });
  const rows = [plain, optimus, eiffel];

  const forecasts = new Map<string, CachedForecast>([
    ['10307-1', forecast({ sealed: 629.99, forecast2y: 923.54 })],
    ['10302-1', forecast({ sealed: 179.99, forecast2y: 194.91 })],
  ]);

  it('ranks opportunity by absolute dollars', () => {
    // Eiffel gains $293.55, Optimus $14.92.
    const sorted = sortCandidates(rows, forecasts, 'opportunity', TODAY);
    assert.deepEqual(sorted.map((r) => r.setNumber), ['10307-1', '10302-1', '99999-1']);
  });

  it('ranks discount by percentage, which can disagree with dollars', () => {
    // Eiffel +46.6%, Optimus +8.3% — same order here, but computed from a different metric.
    const cheap = boardRow({ setNumber: '00001-1', exitDate: d('2026-07-31') });
    const withCheap = new Map(forecasts);
    withCheap.set('00001-1', forecast({ sealed: 10, forecast2y: 30 })); // +$20 but +200%

    const byDollars = sortCandidates([...rows, cheap], withCheap, 'opportunity', TODAY);
    const byPercent = sortCandidates([...rows, cheap], withCheap, 'discount', TODAY);

    assert.equal(byDollars[0]?.setNumber, '10307-1');
    assert.equal(byPercent[0]?.setNumber, '00001-1');
  });

  it('ranks value by current sealed price', () => {
    const sorted = sortCandidates(rows, forecasts, 'value', TODAY);
    assert.deepEqual(sorted.map((r) => r.setNumber), ['10307-1', '10302-1', '99999-1']);
  });

  it('parks unvalued sets at the bottom of every value-based sort', () => {
    // Never coerced to 0, which would file them below a genuinely loss-making forecast and turn
    // "nobody looked" into a verdict.
    const losing = boardRow({ setNumber: '00002-1', exitDate: d('2026-07-31') });
    const withLoser = new Map(forecasts);
    withLoser.set('00002-1', forecast({ sealed: 100, forecast2y: 40 })); // -$60

    for (const sort of ['opportunity', 'value', 'discount'] as const) {
      const sorted = sortCandidates([...rows, losing], withLoser, sort, TODAY);
      assert.equal(sorted[sorted.length - 1]?.setNumber, '99999-1', sort);
    }
  });

  it('hides nothing — every sort returns every row', () => {
    for (const sort of ['retiring', 'opportunity', 'value', 'discount'] as const) {
      assert.equal(sortCandidates(rows, forecasts, sort, TODAY).length, rows.length, sort);
    }
  });

  it('does not mutate its input', () => {
    const input = [plain, optimus, eiffel];
    sortCandidates(input, forecasts, 'value', TODAY);
    assert.equal(input[0]?.setNumber, '99999-1');
  });
});

describe('sortCandidates — retiring first', () => {
  it('orders by the RESOLVED date, so a BrickEconomy day beats a Brickset bucket', () => {
    const bucket = boardRow({ setNumber: 'bucket-1', exitDate: d('2026-08-31') });
    const observed = boardRow({ setNumber: 'observed-1', exitDate: d('2026-12-31') });
    const forecasts = new Map([['observed-1', forecast({ retiredDate: d('2026-08-01') })]]);

    const sorted = sortCandidates([bucket, observed], forecasts, 'retiring', TODAY);
    assert.deepEqual(sorted.map((r) => r.setNumber), ['observed-1', 'bucket-1']);
  });

  it('breaks a shared bucket on LEGO.com having already closed', () => {
    // 475 of 476 candidates share one bucketed date, so ties are the norm. A set whose direct
    // channel has already shut is demonstrably further along than a peer with no such evidence —
    // this is the one place those past dates can honestly move the order.
    const closed = boardRow({ setNumber: 'zzz-1', exitDate: d('2026-07-31'), usDateLastAvailable: d('2026-05-12') });
    const open = boardRow({ setNumber: 'aaa-1', exitDate: d('2026-07-31'), usDateLastAvailable: null });

    const sorted = sortCandidates([open, closed], noForecasts, 'retiring', TODAY);
    assert.deepEqual(sorted.map((r) => r.setNumber), ['zzz-1', 'aaa-1']);
  });

  it('falls back to set number so renders are stable', () => {
    const b = boardRow({ setNumber: 'b-1', exitDate: d('2026-07-31') });
    const a = boardRow({ setNumber: 'a-1', exitDate: d('2026-07-31') });
    assert.deepEqual(
      sortCandidates([b, a], noForecasts, 'retiring', TODAY).map((r) => r.setNumber),
      ['a-1', 'b-1'],
    );
  });

  it('sinks a set with no known date to the bottom', () => {
    const unknown = boardRow({ setNumber: 'aaa-1', exitDate: null });
    const known = boardRow({ setNumber: 'zzz-1', exitDate: d('2026-12-31') });
    assert.deepEqual(
      sortCandidates([unknown, known], noForecasts, 'retiring', TODAY).map((r) => r.setNumber),
      ['zzz-1', 'aaa-1'],
    );
  });
});

describe('matchesFilters', () => {
  const filters = (overrides: Partial<BoardFilters> = {}): BoardFilters => ({ ...NO_FILTERS, ...overrides });

  it('passes everything when nothing is set', () => {
    assert.equal(matchesFilters(boardRow(), undefined, NO_FILTERS), true);
  });

  it('filters by theme', () => {
    assert.equal(matchesFilters(boardRow({ theme: 'Icons' }), undefined, filters({ theme: 'Icons' })), true);
    assert.equal(matchesFilters(boardRow({ theme: 'City' }), undefined, filters({ theme: 'Icons' })), false);
  });

  it('includes both price bounds', () => {
    const row229 = boardRow({ usRetailPrice: 229.99 });
    assert.equal(matchesFilters(row229, undefined, filters({ priceMin: 229.99 })), true);
    assert.equal(matchesFilters(row229, undefined, filters({ priceMax: 229.99 })), true);
    assert.equal(matchesFilters(row229, undefined, filters({ priceMin: 230 })), false);
    assert.equal(matchesFilters(row229, undefined, filters({ priceMax: 229 })), false);
  });

  it('drops an unpriced set ONLY when a price filter is active', () => {
    // Absence is not a price, so it cannot be inside a range — but with no range asked for, a
    // missing MSRP is no reason to hide the set.
    const unpriced = boardRow({ usRetailPrice: null });
    assert.equal(matchesFilters(unpriced, undefined, NO_FILTERS), true);
    assert.equal(matchesFilters(unpriced, undefined, filters({ priceMin: 10 })), false);
    assert.equal(matchesFilters(unpriced, undefined, filters({ theme: 'Icons' })), true);
  });

  it('valued-only drops sets with no cached snapshot', () => {
    assert.equal(matchesFilters(boardRow(), forecast(), filters({ valuedOnly: true })), true);
    assert.equal(matchesFilters(boardRow(), undefined, filters({ valuedOnly: true })), false);
  });

  it('positive-or-better excludes flat, negative and unvalued', () => {
    // The bar moved: it used to be "any growth at all", so a faint +10% slipped through as a
    // positive forecast. Flat is a judged non-event, and an unvalued set is unjudged — neither
    // belongs on a board claiming to show only forecasts worth acting on.
    const positive = filters({ positiveOnly: true });
    assert.equal(matchesFilters(boardRow(), forecast({ sealed: 100, forecast2y: 150 }), positive), true);
    assert.equal(matchesFilters(boardRow(), forecast({ sealed: 100, forecast2y: 125 }), positive), true);
    assert.equal(matchesFilters(boardRow(), forecast({ sealed: 100, forecast2y: 110 }), positive), false); // passed before this change
    assert.equal(matchesFilters(boardRow(), forecast({ sealed: 100, forecast2y: 100 }), positive), false);
    assert.equal(matchesFilters(boardRow(), forecast({ sealed: 100, forecast2y: 90 }), positive), false);
    assert.equal(matchesFilters(boardRow(), forecast({ sealed: 100, forecast2y: 75 }), positive), false);
    assert.equal(matchesFilters(boardRow(), undefined, positive), false);
    assert.equal(matchesFilters(boardRow(), forecast({ forecast2y: null }), positive), false);
  });
});

describe('countUnpricedHidden', () => {
  const rows = [boardRow({ setNumber: 'a-1' }), boardRow({ setNumber: 'b-1', usRetailPrice: null })];

  it('counts unpriced sets only while a price filter is on', () => {
    assert.equal(countUnpricedHidden(rows, NO_FILTERS), 0);
    assert.equal(countUnpricedHidden(rows, { ...NO_FILTERS, priceMin: 10 }), 1);
  });
});

describe('matchesBoardQuery', () => {
  const jazz = boardRow({ setNumber: '10312-1', name: 'Jazz Club', theme: 'Icons' });

  it('matches everything on an empty query', () => {
    assert.equal(matchesBoardQuery(jazz, ''), true);
    assert.equal(matchesBoardQuery(jazz, '   '), true);
  });

  it('matches a name substring, ignoring case and stray whitespace', () => {
    assert.equal(matchesBoardQuery(jazz, 'jazz'), true);
    assert.equal(matchesBoardQuery(jazz, '  JAZZ   club '), true);
    assert.equal(matchesBoardQuery(jazz, 'club'), true);
  });

  it('resolves a bare number to the suffixed set number', () => {
    // The board stores "10312-1"; nobody types the suffix.
    assert.equal(matchesBoardQuery(jazz, '10312'), true);
    assert.equal(matchesBoardQuery(jazz, '10312-1'), true);
    assert.equal(matchesBoardQuery(jazz, '10313'), false);
  });

  it('matches theme too', () => {
    assert.equal(matchesBoardQuery(jazz, 'icons'), true);
  });

  it('returns false for a query that matches nothing, rather than falling open', () => {
    assert.equal(matchesBoardQuery(jazz, 'zzzz'), false);
  });

  it('survives a row with no name or theme', () => {
    const bare = boardRow({ name: null, theme: null });
    assert.equal(matchesBoardQuery(bare, 'jazz'), false);
    assert.equal(matchesBoardQuery(bare, ''), true);
  });
});

describe('board view <-> query string', () => {
  const from = (params: Record<string, string>) => parseBoardView((key) => params[key]);

  it('defaults to retiring-first with nothing filtered', () => {
    assert.deepEqual(from({}), DEFAULT_VIEW);
  });

  it('reads every control back out of the URL', () => {
    const view = from({ sort: 'value', theme: 'Icons', min: '100', max: '300', pos: '1', valued: '1', q: 'falcon' });
    assert.deepEqual(view, {
      sort: 'value',
      theme: 'Icons',
      priceMin: 100,
      priceMax: 300,
      positiveOnly: true,
      valuedOnly: true,
      query: 'falcon',
    });
  });

  it('falls back on an unknown sort rather than emptying the board', () => {
    assert.equal(from({ sort: 'cheapest' }).sort, 'retiring');
  });

  it('treats a junk price as unbounded, never as zero', () => {
    // Parsing "abc" to 0 would silently apply a real filter nobody asked for.
    assert.equal(from({ min: 'abc' }).priceMin, null);
    assert.equal(from({ min: '-5' }).priceMin, null);
    assert.equal(from({ min: '0' }).priceMin, 0);
  });

  it('round-trips back to a query string, omitting defaults', () => {
    assert.equal(boardViewToQuery(DEFAULT_VIEW, ''), '');
    const view = { ...DEFAULT_VIEW, sort: 'discount' as const, theme: 'Icons', query: ' falcon ' };
    const query = boardViewToQuery(view, '12');
    assert.deepEqual(from(Object.fromEntries(new URLSearchParams(query))), { ...view, query: 'falcon' });
    // months belongs to the server render; dropping it would resize the window on reload.
    assert.match(query, /months=12/);
  });
});

describe('applyBoardView', () => {
  it('filters then sorts, so the server and client cannot drift apart', () => {
    const rows = [
      boardRow({ setNumber: 'a-1', theme: 'Icons', usRetailPrice: 50 }),
      boardRow({ setNumber: 'b-1', theme: 'City', usRetailPrice: 50 }),
      boardRow({ setNumber: 'c-1', theme: 'Icons', usRetailPrice: 500 }),
    ];
    const forecasts = new Map([['a-1', forecast({ sealed: 10, forecast2y: 20 })]]);

    const view = { ...DEFAULT_VIEW, theme: 'Icons', priceMax: 100 };
    assert.deepEqual(
      applyBoardView(rows, forecasts, view, TODAY).map((r) => r.setNumber),
      ['a-1'],
    );
  });

  it('returns every row for the default view', () => {
    const rows = [boardRow({ setNumber: 'a-1' }), boardRow({ setNumber: 'b-1' })];
    assert.equal(applyBoardView(rows, noForecasts, DEFAULT_VIEW, TODAY).length, 2);
  });
});

describe('boardThemes', () => {
  it('counts distinct themes alphabetically, skipping nulls', () => {
    const themes = boardThemes([
      boardRow({ setNumber: 'a-1', theme: 'Icons' }),
      boardRow({ setNumber: 'b-1', theme: 'City' }),
      boardRow({ setNumber: 'c-1', theme: 'Icons' }),
      boardRow({ setNumber: 'd-1', theme: null }),
    ]);
    assert.deepEqual(themes, [
      { theme: 'City', count: 1 },
      { theme: 'Icons', count: 2 },
    ]);
  });
});
