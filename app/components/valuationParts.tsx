import type { PreviewProvenance } from '../../src/lib/setPreview.ts';
import { formatUSD, formatUSDDelta } from '../../src/lib/money.ts';
import { STRATEGY_LABELS } from '../../src/lib/labels.ts';
import type { PlatformComparison } from '../../src/lib/platformNets.ts';
import type { Strategy, Verdict } from '../../src/lib/types.ts';
import type { AbsentPlay, ActMatrix } from '../../src/lib/waysToAct.ts';

/**
 * The honesty layer and the strategy table, in a file both sides of the RSC boundary can import.
 *
 * Everything here depends only on src/lib, which is pure. That is the whole reason the file
 * exists: src/composition.ts value-imports Prisma and installs the API log at module load, so a
 * client component can never reach it — yet the client-rendered cards and dialog have to make
 * exactly the same disclosures as a server-rendered one, and duplicating the wording is how two
 * copies drift apart. Anything from composition.ts (MOCK_BACKED_STRATEGIES) arrives as a prop,
 * spread into a plain array by a server component.
 */

export function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
      <span aria-hidden="true">!</span>
      <span>{children}</span>
    </p>
  );
}

/** Stale prices, shown on every render — the failure this exists to prevent is silent staleness. */
export function StaleNotice({
  provenance,
  today,
}: {
  provenance: PreviewProvenance;
  today: string;
}) {
  if (provenance.staleFrom === null) return null;
  const age = Math.max(
    0,
    Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${provenance.staleFrom}T00:00:00Z`)) /
        86_400_000,
    ),
  );
  return (
    <Notice>
      <strong className="font-semibold">Stale prices</strong> — from {provenance.staleFrom}
      {age > 0 ? ` (${age} day${age === 1 ? '' : 's'} old)` : ''}. The BrickEconomy daily quota was
      exhausted, so these are the most recent numbers on file.
    </Notice>
  );
}

/** Values the adapter had to estimate because the source reported nothing. */
export function EstimatedNotice({ provenance }: { provenance: PreviewProvenance }) {
  if (provenance.derived.length === 0) return null;
  return (
    <Notice>
      <strong className="font-semibold">Estimated, not observed</strong> —{' '}
      {provenance.derived.join(', ')}.
    </Notice>
  );
}

/**
 * The recommended play rests on mock data. Loud, because it is easy to act on by mistake.
 *
 * Takes the mock-backed list as a prop rather than importing it, because the list lives in
 * src/composition.ts. A server component spreads MOCK_BACKED_STRATEGIES into an array; a client
 * component receives that array across the RSC boundary.
 */
export function MockNotice({
  play,
  mockStrategies,
}: {
  play: Strategy;
  mockStrategies: readonly string[];
}) {
  if (!mockStrategies.includes(play)) return null;
  return (
    <p className="flex gap-2 rounded-md border-2 border-warn bg-warn/15 px-3 py-2.5 text-sm font-medium text-warn">
      <span aria-hidden="true">!</span>
      <span>
        <strong className="font-semibold">Part-out: mock data.</strong> BrickLink is not wired yet —
        this is not a real quote. Do not act on this number.
      </span>
    </p>
  );
}

/**
 * The compact form of the same disclosure, for a collapsed preview card.
 *
 * A grid of twenty cards each shouting the full banner teaches people to scroll past it, including
 * on the one card where it matters. This chip carries the same fact at card scale and the full
 * banner is one click away, on the expanded card.
 */
export function MockChip({
  play,
  mockStrategies,
}: {
  play: Strategy;
  mockStrategies: readonly string[];
}) {
  if (!mockStrategies.includes(play)) return null;
  return (
    <span
      title="BrickLink is not wired yet — the part-out figure is mock data, not a real quote."
      className="rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warn"
    >
      mock
    </span>
  );
}

/** A value that does not exist. A styled state with a reason, never an error and never $0.00. */
export function Unavailable({ reason }: { reason: string }) {
  return (
    <span className="text-sm text-muted">
      <span aria-hidden="true" className="mr-1.5">
        —
      </span>
      <span className="italic">{reason}</span>
    </span>
  );
}

export function FreshnessTag({ fetchedOn, isStale }: { fetchedOn: string; isStale: boolean }) {
  return (
    <span className="tabular text-xs text-muted">
      {fetchedOn}
      {isStale ? (
        <span className="ml-1.5 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
          cached
        </span>
      ) : null}
    </span>
  );
}

/** Re-exported so existing call sites keep working; the labels themselves live in src/lib. */
export { STRATEGY_LABELS };

/** The row-level mark. Small, but present on every render of a mock-backed play. */
function MockTag() {
  return (
    <span
      title="BrickLink is not wired yet — this figure is mock data, not a real quote."
      className="ml-2 rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-warn"
    >
      mock
    </span>
  );
}

/**
 * What a venue costs you beyond its fees.
 *
 * Deliberately neutral: `warn` is reserved for stale and mock notices, and buy/pass would read as
 * a verdict. This is a fact about the work, not a judgement about the deal — and it is a tag
 * rather than a dollar deduction because subtracting an invented cost of your time would put a
 * made-up number in a column of measured ones.
 */
function EffortTag({ tag }: { tag: string }) {
  return (
    <span className="ml-2 rounded border border-border px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted">
      {tag}
    </span>
  );
}

/** "a", "a and b", "a, b and c" — an honest list needs to read like one. */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The plays this set has no price for, disclosed once.
 *
 * The alternative — a table row per unpriced play saying "unavailable" — crowded the numbers out
 * with reasons that are mostly obvious, and read as though the play had been judged and rejected.
 * A play is either shown with a real net or cleanly absent; this is what stops "absent" from
 * quietly becoming "we never mentioned it".
 */
export function AbsentNote({ absent }: { absent: readonly AbsentPlay[] }) {
  if (absent.length === 0) return null;

  // Grouped by reason, so four plays missing for one reason read as one sentence, not four.
  const byReason = new Map<string, string[]>();
  for (const play of absent) {
    const labels = byReason.get(play.reason);
    if (labels === undefined) byReason.set(play.reason, [play.label]);
    else labels.push(play.label);
  }

  return (
    <div className="space-y-1 border-t border-border pt-3">
      {[...byReason.entries()].map(([reason, labels]) => (
        <p key={reason} className="text-sm text-muted">
          Not priced: {listWords(labels)} <Unavailable reason={reason} />
        </p>
      ))}
    </div>
  );
}

/**
 * Every priced way to act on a set, whatever condition you happen to have.
 *
 * Takes an ActMatrix rather than a Verdict, and that is the whole point: a Verdict is scored for
 * ONE condition, so rendering this from one made the opportunity map a slice of itself and let the
 * condition selector silently hide avenues.
 *
 * `mockStrategies` is required rather than optional: a table that silently forgot to mark part-out
 * would present a mock number as a real quote, which is the one thing this app must never do.
 */
export function WaysToActTable({
  matrix,
  mockStrategies,
  className,
}: {
  matrix: ActMatrix;
  mockStrategies: readonly string[];
  className?: string;
}) {
  if (matrix.rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No play is priced for this set yet — every band is missing from the numbers on file.
      </p>
    );
  }

  return (
    <table className={`w-full text-sm ${className ?? ''}`}>
      <caption className="sr-only">Net return by play, across every condition</caption>
      <thead>
        <tr className="text-xs uppercase tracking-wide text-muted">
          <th scope="col" className="pb-1 text-left font-normal">
            Play
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Market value
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Fees
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Net
          </th>
        </tr>
      </thead>
      <tbody>
        {matrix.rows.map((row) => {
          // Flagged on the ROW, not only when this play wins. "Flip sealed is real, part-out is
          // mock" is a structural fact about the data, true whether or not part_out came top.
          const isMock = mockStrategies.includes(row.strategy);
          const isBest = row.key === matrix.bestKey;
          return (
            <tr key={row.key} className={`border-t border-border ${isBest ? 'bg-accent/5' : ''}`}>
              <th scope="row" className="py-2.5 pr-3 text-left font-medium">
                <span>
                  {row.label}
                  {isMock ? <MockTag /> : null}
                  {isBest ? (
                    <span className="ml-2 text-xs font-normal text-accent">best</span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs font-normal text-muted">
                  {row.appliesTo} · net after {row.venueLabel}
                </span>
              </th>
              <td className="tabular py-2.5 text-right align-top text-muted">
                {formatUSD(row.marketValue)}
              </td>
              <td className="tabular py-2.5 text-right align-top text-muted">
                {formatUSD(row.fees)}
              </td>
              <td className="tabular py-2.5 text-right align-top font-medium">
                {formatUSD(row.net)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The recommended play, priced on every venue that can actually host it.
 *
 * The verdict is anchored to one platform so BUY/PASS stays a single call; this is the rest of the
 * truth, so "PASS on eBay" is not mistaken for "PASS". Rows rank by net dollars, but the "best
 * avenue" mark only ever lands on a shipped-reach row — a local cash sale keeps the whole price by
 * giving up reach and buyer protection, and must never look like a free win.
 */
export function PlatformStrip({
  comparison,
  mockStrategies,
  className,
}: {
  comparison: PlatformComparison;
  mockStrategies: readonly string[];
  className?: string;
}) {
  const isMock = mockStrategies.includes(comparison.play);

  return (
    <table className={`w-full text-sm ${className ?? ''}`}>
      <caption className="sr-only">
        Net by platform for {comparison.playLabel}, {comparison.marketValueLabel}
      </caption>
      <thead>
        <tr className="text-xs uppercase tracking-wide text-muted">
          <th scope="col" className="pb-1 text-left font-normal">
            Where you sell it
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            Net
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            vs {comparison.anchor.platform.label}
          </th>
          <th scope="col" className="pb-1 text-right font-normal">
            {comparison.mode === 'verdict' ? 'Margin' : 'Buy under'}
          </th>
        </tr>
      </thead>
      <tbody>
        {comparison.rows.map((row) => {
          const isBest = row.platform.id === comparison.best.platform.id;
          return (
            <tr
              key={row.platform.id}
              className={`border-t border-border ${isBest ? 'bg-accent/5' : ''}`}
            >
              <th scope="row" className="py-2.5 pr-3 text-left font-medium">
                {row.platform.label}
                {isMock ? <MockTag /> : null}
                <EffortTag tag={row.platform.effort.tag} />
                {isBest ? (
                  <span className="ml-2 text-xs font-normal text-accent">best avenue</span>
                ) : null}
              </th>
              <td className="tabular py-2.5 text-right font-medium">{formatUSD(row.net)}</td>
              <td className="tabular py-2.5 text-right text-muted">
                {row.isAnchor ? (
                  <span aria-hidden="true">—</span>
                ) : (
                  formatUSDDelta(row.deltaVsAnchor)
                )}
              </td>
              <td className="tabular py-2.5 text-right">
                {row.mode === 'verdict' ? (
                  <>
                    {formatUSD(row.margin)}
                    {row.clears ? (
                      <span className="ml-1.5 text-buy" title="clears the 25% bar">
                        ✓
                      </span>
                    ) : null}
                  </>
                ) : row.ceiling === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  formatUSD(row.ceiling)
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** BUY/PASS against a real buy price. Never rendered without one — see maxBuyPrice for why. */
export function VerdictBar({
  call,
  buyPrice,
  threshold,
  className,
}: {
  call: Verdict;
  buyPrice: number;
  threshold: number;
  className?: string;
}) {
  return (
    <footer
      className={`flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-4 ${className ?? ''}`}
    >
      <span
        className={`rounded-md px-3 py-1.5 text-sm font-semibold ${
          call.buy ? 'bg-buy/15 text-buy' : 'bg-pass/15 text-pass'
        }`}
      >
        {call.buy ? 'BUY' : 'PASS'}
      </span>
      <div className="tabular text-sm">
        <span className="text-muted">Margin </span>
        <span className="font-semibold">{formatUSD(call.margin)}</span>
      </div>
      <div className="tabular text-sm">
        <span className="text-muted">Net </span>
        <span className="font-semibold">{formatUSD(call.net)}</span>
      </div>
      <span className="tabular text-xs text-muted">
        needs margin &gt; {formatUSD(threshold)} on a {formatUSD(buyPrice)} buy
      </span>
    </footer>
  );
}
