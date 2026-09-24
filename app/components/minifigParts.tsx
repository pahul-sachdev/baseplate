import { MINIFIG_ID_RULES } from '../../src/lib/minifigNumber.ts';
import { formatUSD } from '../../src/lib/money.ts';
import type { MinifigPreview } from '../../src/lib/minifigPreview.ts';
import { ROSTER_NOTES, type MinifigRoster } from '../../src/lib/minifigRoster.ts';
import { shareLines, type MinifigRichFlag, type MinifigShare } from '../../src/lib/minifigShare.ts';

/**
 * The minifigure honesty layer.
 *
 * A new file rather than additions to valuationParts.tsx, so the two features never contend for
 * the same file — but the same principle: it depends only on src/lib, so the RSC and client sides
 * import identical wording and cannot drift apart.
 *
 * No 'use client' directive. Neutral, and absorbed into whichever bundle imports it.
 */

/**
 * The share, and it is impossible to render the percentage without the rest.
 *
 * shareLines() is the only way to get words out of a MinifigShare, and it returns the coverage
 * sentence and the dates alongside the headline — so this component could not print a bare "58%"
 * even if someone tried to make it.
 */
export function ShareBlock({
  share,
  flag,
}: {
  share: MinifigShare;
  flag: MinifigRichFlag;
}) {
  const lines = shareLines(share, flag);
  const warn = lines.tone === 'warn';

  return (
    <div
      className={`space-y-1.5 rounded-lg border px-3 py-2.5 ${
        warn ? 'border-warn/40 bg-warn/5' : 'border-border bg-bg'
      }`}
    >
      <p className="text-sm font-medium">{lines.headline}</p>
      <p className="text-xs text-muted">{lines.coverage}</p>
      {lines.dates === null ? null : <p className="text-xs text-warn">{lines.dates}</p>}
    </div>
  );
}

/**
 * The minifig-rich chip. Three-valued, because a floor under the bar proves nothing — rendering
 * that as "not minifig-rich" is the lie the flag type exists to prevent.
 */
export function RichChip({ flag, threshold }: { flag: MinifigRichFlag; threshold: number }) {
  const bar = `${Math.round(threshold * 100)}%`;

  if (flag.kind === 'rich') {
    return (
      <span
        title={
          flag.proven === 'measured'
            ? `Minifigures are at or above ${bar} of this set's sealed value.`
            : `Already at or above ${bar} from the figures valued so far — valuing the rest can only raise it.`
        }
        className="rounded border border-buy/50 bg-buy/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-buy"
      >
        minifig-rich{flag.proven === 'floor' ? ' (at least)' : ''}
      </span>
    );
  }

  if (flag.kind === 'not_rich') {
    return (
      <span
        title={`Minifigures are under ${bar} of this set's sealed value, with every figure accounted for.`}
        className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted"
      >
        under {bar}
      </span>
    );
  }

  return (
    <span
      title={flag.reason}
      className="rounded border border-dashed border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted"
    >
      not yet assessable
    </span>
  );
}

/** Why a set has no figure list. Never rendered as an empty grid. */
export function RosterNote({ roster }: { roster: MinifigRoster }) {
  const note = ROSTER_NOTES[roster.kind];
  if (note === '') return null;
  return (
    <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-sm text-muted">
      {note}
    </p>
  );
}

/**
 * An advisory about id SHAPES, offered before anything is spent.
 *
 * An observation about strings framed as a possibility, never a claim about value — and it never
 * blocks the attempt.
 */
export function ShapeAdvisory({ note }: { note: { unusual: readonly string[] } | null }) {
  if (note === null) return null;
  const { unusual } = note;
  return (
    <p className="rounded-md border border-border bg-bg px-3 py-2 text-xs text-muted">
      {unusual.length} of these ids {unusual.length === 1 ? 'is' : 'are'} shaped like a BrickLink
      part number rather than a minifigure number
      {unusual.length <= 3 ? ` (${unusual.join(', ')})` : ''}. BrickEconomy lists some microfigures
      that way and usually has no minifigure record for them, so they are left out of bulk valuing.
      You can still ask about one individually.
    </p>
  );
}

/**
 * What one figure is worth, or the specific reason it has no number.
 *
 * Six states, six different sentences. A dash would read as zero, and "not valued yet" beside a
 * figure BrickEconomy has never heard of would offer to spend a request already known to fail.
 */
export function FigValue({ preview }: { preview: MinifigPreview }) {
  const { state } = preview;

  switch (state.kind) {
    case 'valued':
      return (
        <span className="tabular text-sm font-semibold">
          {formatUSD(state.value)}
          {state.freshness === 'stale' ? (
            <span className="ml-1.5 text-[10px] font-normal uppercase tracking-wide text-warn">
              {state.provenance.staleFrom === null ? `from ${state.fetchedOn}` : 'stale'}
            </span>
          ) : null}
        </span>
      );

    case 'unvalued':
      return <span className="text-xs italic text-muted">not valued yet</span>;

    case 'no_price':
      // NOT "not valued yet": BrickEconomy knows this figure and publishes no value, so asking
      // again would spend a request to be told the same thing.
      return (
        <span
          title="BrickEconomy has a record for this minifigure but publishes no value for it."
          className="text-xs italic text-muted"
        >
          no published value
        </span>
      );

    case 'absent':
      return (
        <span
          title={`BrickEconomy answered HTTP ${state.status} for this id on ${state.confirmedOn}. It is not in their minifigure catalogue.`}
          className="text-xs italic text-muted"
        >
          no BrickEconomy record
        </span>
      );

    case 'unaddressable':
      return (
        <span title={MINIFIG_ID_RULES[state.idKind].note} className="text-xs italic text-muted">
          cannot be looked up
        </span>
      );

    case 'unreadable':
      return (
        <span title={state.reason} className="text-xs italic text-muted">
          could not be read
        </span>
      );

    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled minifig state: ${String(exhaustive)}`);
    }
  }
}

/**
 * The exclusivity slot — and it is REAL DATA, not a labelled-empty box.
 *
 * BrickEconomy ships `set_count` and `sets` with every figure value (measured), so "appears in N
 * sets" arrives free with the price and needs no BrickLink access. BrickLink supersets would still
 * be a richer cross-check later.
 *
 * `exclusiveTo` is asserted ONLY when the list NAMES exactly this set. A reported count of 1 with
 * no list supports "appears in 1 set" and NOT "exclusive to this set" — the second is a claim
 * about identity, and a count is not an identity.
 */
export function ExclusivitySlot({
  preview,
  inSet = null,
}: {
  preview: MinifigPreview;
  inSet?: string | null;
}) {
  const facts = preview.state.kind === 'valued' || preview.state.kind === 'no_price' ? preview.state.facts : null;
  const appearsIn = facts?.appearsIn ?? null;

  if (appearsIn === null) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-2.5">
        <h4 className="text-xs font-medium">Exclusivity</h4>
        <p className="mt-0.5 text-xs text-muted">
          {facts === null
            ? 'Not known yet — value this minifigure and BrickEconomy reports how many sets it appears in.'
            : 'BrickEconomy returned no set list for this minifigure, and BrickLink supersets are not wired yet. There is nothing honest to show here.'}
        </p>
      </div>
    );
  }

  const count = appearsIn.reported ?? appearsIn.listed.length;
  const exclusiveToThisSet =
    inSet !== null && appearsIn.listed.length === 1 && appearsIn.listed[0] === inSet;

  return (
    <div className="rounded-lg border border-border bg-bg px-3 py-2.5">
      <h4 className="text-xs font-medium">
        Exclusivity
        {exclusiveToThisSet ? (
          <span className="ml-2 rounded border border-buy/50 bg-buy/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-buy">
            exclusive to this set
          </span>
        ) : null}
      </h4>
      <p className="mt-0.5 text-xs text-muted">
        {count === 0
          ? 'BrickEconomy lists no sets for this minifigure.'
          : `Appears in ${count} ${count === 1 ? 'set' : 'sets'}.`}
        {appearsIn.listed.length > 0 ? ` BrickEconomy names: ${appearsIn.listed.join(', ')}.` : ''}
        {appearsIn.reported !== null && appearsIn.reported > appearsIn.listed.length
          ? ` It counts ${appearsIn.reported} but names ${appearsIn.listed.length}.`
          : ''}
      </p>
    </div>
  );
}
