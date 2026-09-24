import Image from 'next/image';
import Link from 'next/link';

import { formatPercent, formatUSD } from '../../src/lib/money.ts';
import { detailHref } from '../../src/lib/origin.ts';
import {
  forecastTier,
  forecastVerdict,
  legoComExit,
  monthsUntil,
  resolveRetirementDate,
  TIER_LABELS,
  type CachedForecast,
  type ForecastGrade,
  type ForecastTier,
  type ResolvedRetirement,
  type RetiringRow,
} from '../../src/lib/retiring.ts';
import {
  IMAGE_FIT,
  IMAGE_FRAME,
  IMAGE_FRAME_EMPTY,
  isRenderableImage,
} from '../../src/lib/setPreview.ts';
import { valueRetiringSetAction } from '../retiring/actions.ts';
import { SubmitButton } from './SubmitButton.tsx';

/** Reserves the exact image box, so a missing photo never shifts the layout. */
function ImageSlot({ imageUrl, alt }: { imageUrl: string | null; alt: string }) {
  // Gated on the allowlist, not just on null: next/image throws at render for an unconfigured
  // host, which would take the whole board down rather than lose one thumbnail.
  if (!isRenderableImage(imageUrl)) {
    return (
      <div className={IMAGE_FRAME_EMPTY}>
        <span className="text-xs text-muted">No image</span>
      </div>
    );
  }
  return (
    <div className={IMAGE_FRAME}>
      <Image
        src={imageUrl}
        alt={alt}
        fill
        sizes="(min-width: 1024px) 320px, (min-width: 640px) 45vw, 90vw"
        className={IMAGE_FIT}
      />
    </div>
  );
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * The resolved date, written at the precision its source actually claims.
 *
 * Measured: 2,489 of Brickset's 2,503 exit dates land on a month end and 2,055 of those on
 * December 31, so the day is almost never a fact. Rendering "2026-07-31" for a month bucket would
 * manufacture a precision that is not in the data — the same failure as inventing a date for a set
 * that has none, one step subtler. A day from LEGO.com or BrickEconomy is a real day and prints
 * as one, which is why the source is named either way.
 */
function retirementDetail(resolved: ResolvedRetirement): string {
  const { date, precision, source } = resolved;
  if (source !== 'brickset') return `${isoDay(date)} · ${source}`;

  switch (precision) {
    case 'year':
      return `Brickset lists end of ${date.getUTCFullYear()} — a year, not a date`;
    case 'month':
      return `Brickset lists end of ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} — a month, not a date`;
    case 'day':
      return `${isoDay(date)} · brickset`;
  }
}

/**
 * The retirement line.
 *
 * A missing date says so, rather than borrowing one from launchDate. A bucketed one is labelled as
 * the bucket it is. A date already in the past is called out rather than run through "retires in N
 * months", which would floor to zero and read as a prediction about something that has happened.
 *
 * The LEGO.com line underneath is a DIFFERENT event — direct sales ending, which happens before
 * the set leaves the market — so it sits beside the retirement date and never replaces it.
 */
function ExitLine({
  row,
  forecast,
  today,
}: {
  row: RetiringRow;
  forecast: CachedForecast | undefined;
  today: Date;
}) {
  const resolved = resolveRetirementDate(row, forecast, today);
  const legoExit = legoComExit(row, today);

  const legoLine =
    legoExit === null ? null : (
      <span className="tabular block text-xs text-muted">
        LEGO.com stopped {isoDay(legoExit)}
      </span>
    );

  if (resolved === null) {
    return (
      <p className="text-sm">
        <span className="italic text-muted">Retirement date unknown</span>
        {legoLine}
      </p>
    );
  }

  const months = monthsUntil(resolved.date, today);
  const label = resolved.isPast
    ? resolved.source === 'brickeconomy'
      ? 'Already retired'
      : 'Retirement date has passed'
    : months === 0
      ? 'Retires within a month'
      : `Retires in ${months} month${months === 1 ? '' : 's'}`;

  return (
    <p className="text-sm">
      <span className="font-medium">{label}</span>
      <span className="tabular block text-xs text-muted">{retirementDetail(resolved)}</span>
      {legoLine}
    </p>
  );
}

/**
 * How loud each tier is allowed to be.
 *
 * Only the two act-on-it tiers touch `buy`, so no amount of prominence can make Flat or Negative
 * read as a buy signal. Loudness is not goodness: Negative is a real finding and stays legible,
 * while Flat — the non-event — is the quietest badge on the card.
 *
 * Negative is `pass`, not `warn`. globals.css reserves warn for stale and mock notices, "which must
 * not be mistaken for either verdict", and a tier IS a verdict; `pass` is already this app's word
 * for "not this one", sitting opposite BUY in the valuation card.
 *
 * That leaves Flat and Negative near-identical in hue — pass is oklch(48% 0.02 260), muted is
 * oklch(53% 0.018 260) — so they are separated STRUCTURALLY instead: Flat is a bare outline with no
 * fill, Negative is a filled badge in the same shape as Positive.
 *
 * Whole literal strings, never assembled from the tier name, so Tailwind's scanner emits them all.
 */
const TIER_BADGE: Readonly<Record<ForecastTier, string>> = {
  strong: 'border-buy bg-buy/15 font-semibold text-buy',
  positive: 'border-buy/40 bg-buy/10 font-medium text-buy',
  flat: 'border-border font-normal text-muted',
  negative: 'border-pass/40 bg-pass/10 font-medium text-pass',
};

/**
 * The band, the percentage it came from, and the dollars behind it — all three, always.
 *
 * Both numbers, because the band alone would repeat the old badge's sin one level up: "Positive"
 * covers everything from +15% to +39%, and the reader deserves to see which. formatUSD prints its
 * own minus, so the inline plus only ever fires on a gain.
 */
function TierBadge({ grade }: { grade: ForecastGrade }) {
  return (
    <p
      className={`inline-flex items-baseline gap-1 rounded border px-2 py-0.5 text-xs ${TIER_BADGE[grade.tier]}`}
    >
      <span>{TIER_LABELS[grade.tier]}</span>
      <span aria-hidden="true">·</span>
      <span className="tabular">
        {formatPercent(grade.growthPct)} ({grade.growthAbs >= 0 ? '+' : ''}
        {formatUSD(grade.growthAbs)})
      </span>
    </p>
  );
}

/**
 * The forecast block.
 *
 * A set with no cached BrickEconomy snapshot says "not valued yet" and offers a button. It is
 * never auto-fetched: the board routinely holds hundreds of candidates, and valuing them on
 * render would spend the entire 100/day quota on a single page load.
 */
function ForecastBlock({
  setNumber,
  forecast,
  months,
}: {
  setNumber: string;
  forecast: CachedForecast | undefined;
  months: string;
}) {
  if (forecast === undefined) {
    return (
      <div className="mt-auto space-y-2 border-t border-border pt-3">
        <p className="text-xs">
          <span className="italic text-muted">Not valued yet</span>
        </p>
        {/* z-20 lifts this above the card's link cover; without it the card swallows the click. */}
        <form action={valueRetiringSetAction} className="relative z-20">
          <input type="hidden" name="setNumber" value={setNumber} />
          <input type="hidden" name="months" value={months} />
          <SubmitButton
            variant="quiet"
            pendingLabel="Valuing…"
            confirm={`Value ${setNumber}? This spends 1 of your 100 daily BrickEconomy requests.`}
          >
            Value (spends 1 request)
          </SubmitButton>
        </form>
      </div>
    );
  }

  const verdict = forecastVerdict(forecast);
  const grade = forecastTier(forecast);

  return (
    <div className="mt-auto space-y-2 border-t border-border pt-3">
      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted">Sealed</dt>
          <dd className="tabular font-medium">
            {verdict.sealed === null ? <span className="text-muted">—</span> : formatUSD(verdict.sealed)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">12m</dt>
          <dd className={`tabular font-medium ${verdict.growth12m !== null && verdict.growth12m > 0 ? 'text-buy' : ''}`}>
            {verdict.growth12m === null ? <span className="text-muted">—</span> : formatPercent(verdict.growth12m)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">2y forecast</dt>
          <dd className="tabular font-medium">
            {verdict.forecast2y === null ? (
              <span className="text-muted">—</span>
            ) : (
              formatUSD(verdict.forecast2y)
            )}
          </dd>
        </div>
      </dl>

      {grade === null ? (
        // Not the same as a rejected forecast: BrickEconomy had no figure to judge it on. A sealed
        // value of zero lands here too — there is no percentage to band against.
        <p className="text-xs italic text-muted">Forecast unavailable for this set</p>
      ) : (
        <TierBadge grade={grade} />
      )}

      <p className="tabular text-xs text-muted">Valued {forecast.fetchedOn}</p>
    </div>
  );
}

/**
 * One candidate. Renders only cached data — nothing here can reach a provider.
 *
 * The whole card opens the detail view via the stretched-link pattern; see SetCard for why the
 * link sits inside the heading rather than wrapping the card.
 *
 * `from` carries the board's CURRENT view, so Back lands on the same filtered, sorted board the
 * card was clicked from. The board computes it — this component must not, because the view lives
 * in RetiringBoard's state.
 */
export function RetiringCard({
  row,
  today,
  forecast,
  months,
  from,
}: {
  row: RetiringRow;
  today: Date;
  forecast: CachedForecast | undefined;
  months: string;
  /** The board's current URL, as a relative path plus query. See src/lib/origin.ts. */
  from: string;
}) {
  const name = row.name ?? `Set ${row.setNumber}`;

  return (
    // `isolate` contains the z-20 controls below; see SetCard for the full reasoning.
    <article className="group relative isolate flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 transition-colors duration-150 hover:border-accent/60 focus-within:border-accent">
      <ImageSlot imageUrl={row.imageUrl} alt={name} />

      <div>
        <h3 className="truncate text-sm font-semibold" title={name}>
          <Link
            href={detailHref(row.setNumber, from)}
            prefetch={false}
            className="cursor-pointer transition-colors duration-150 after:absolute after:inset-0 after:z-10 after:rounded-xl group-hover:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {name}
          </Link>
        </h3>
        <p className="tabular text-xs text-muted">
          {row.setNumber}
          {row.theme === null ? '' : ` · ${row.theme}`}
        </p>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <ExitLine row={row} forecast={forecast} today={today} />
        <span className="tabular shrink-0 text-sm">
          {row.usRetailPrice === null ? (
            <span className="text-xs italic text-muted">MSRP unknown</span>
          ) : (
            formatUSD(row.usRetailPrice)
          )}
        </span>
      </div>

      <ForecastBlock setNumber={row.setNumber} forecast={forecast} months={months} />

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="tabular text-xs text-muted">Synced {isoDay(row.lastSynced)}</span>
      </div>
    </article>
  );
}
