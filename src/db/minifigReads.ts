import { readSetRoster } from './brickeconomy/minifigRefs.ts';
import { mapMinifig } from './brickeconomy/minifig/map.ts';
import type { BrickEconomyMinifig } from './brickeconomy/minifig/types.ts';
import { prisma } from './client.ts';
import { systemClock } from './clock.ts';
import { readSetPreviews } from './previews.ts';
import {
  minifigBatchMaxFromEnv,
  minifigGapFromEnv,
  planMinifigBatch,
} from '../lib/minifigBatch.ts';
import { classifyMinifigId, normaliseMinifigNumber } from '../lib/minifigNumber.ts';
import type { MinifigDetail, SetMinifigPanel } from '../lib/minifigPanel.ts';
import {
  classifyMinifigValuation,
  type MinifigPreview,
  type MinifigProvenance,
  type MinifigValue,
} from '../lib/minifigPreview.ts';
import { idShapeNote } from '../lib/minifigRoster.ts';
import { minifigShare, richFlag, shareThresholdFromEnv } from '../lib/minifigShare.ts';

/**
 * Read models for minifigures. Every function here touches the database and stops.
 *
 * This is what makes a figure panel free. A set with twenty-four figures renders every one of
 * them — with its value, or with the honest reason it has none — from rows already on disk.
 * Nothing here can reach the network; spending a request is app/minifig/actions.ts's job and
 * requires a click.
 *
 * Two queries per panel whatever N is, plus the set's own preview read. The per-figure
 * alternative would be two queries each, which is fifty for one Hogwarts Castle.
 */

interface SnapshotRow {
  minifigNumber: string;
  fetchedOn: string;
  payload: string;
  provisional: boolean;
  sourceFetchedOn: string | null;
}

function parsePayload(payload: string): BrickEconomyMinifig | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    return typeof parsed === 'object' && parsed !== null ? (parsed as BrickEconomyMinifig) : null;
  } catch {
    return null;
  }
}

/**
 * A batched mirror of the set adapter's provenance rule, and the same rule deliberately: today's
 * row wins EVEN WHEN PROVISIONAL, because that row exists precisely to disclose that stale numbers
 * were served.
 *
 * Rows arrive ascending by fetchedAt, so the last of a group is the newest.
 */
function pickRow(rows: SnapshotRow[], today: string): SnapshotRow | undefined {
  const todays = rows.filter((row) => row.fetchedOn === today);
  return todays[todays.length - 1] ?? rows[rows.length - 1];
}

function stateFor(
  minifigNumber: string,
  rows: SnapshotRow[],
  absence: { status: number; confirmedOn: string; attempts: number } | undefined,
  today: string,
): MinifigValue {
  const idKind = classifyMinifigId(minifigNumber);

  // Structurally unaskable: no mapping exists from Rebrickable's space to BrickEconomy's, so
  // there is no request that could answer this, and no button is offered.
  if (idKind === 'rebrickable') return { kind: 'unaddressable', minifigNumber, idKind };

  // A confirmed absence is permanent and AGE-BLIND on purpose — re-checking it every midnight is
  // exactly the quota leak the table exists to prevent.
  if (absence !== undefined) {
    return {
      kind: 'absent',
      minifigNumber,
      status: absence.status,
      confirmedOn: absence.confirmedOn,
      attempts: absence.attempts,
    };
  }

  const row = pickRow(rows, today);
  if (row === undefined) return { kind: 'unvalued', minifigNumber, idKind };

  const payload = parsePayload(row.payload);
  if (payload === null) {
    return { kind: 'unreadable', minifigNumber, reason: 'the cached response could not be read' };
  }

  const facts = mapMinifig(minifigNumber, payload);
  const provenance: MinifigProvenance = {
    staleFrom: row.provisional ? row.sourceFetchedOn : null,
  };
  const freshness = classifyMinifigValuation(row.fetchedOn, provenance, today);

  // A record with no published value is its OWN state. Folding it into `valued` would let it
  // count toward coverage and print "3 of 5 valued" over a sum of two.
  if (facts.currentValueNew === null) {
    return { kind: 'no_price', minifigNumber, facts, fetchedOn: row.fetchedOn, freshness, provenance };
  }

  return {
    kind: 'valued',
    minifigNumber,
    facts,
    value: facts.currentValueNew,
    fetchedOn: row.fetchedOn,
    freshness,
    provenance,
  };
}

/**
 * Preview rows for a list of figures, in the order given. Two queries, whatever N is.
 *
 * Figure numbers have NO equivalence rule — a variant letter is part of the identity — so this
 * matches on the normalised string exactly, unlike every set read in this app.
 */
export async function readMinifigPreviews(
  minifigNumbers: readonly string[],
): Promise<MinifigPreview[]> {
  if (minifigNumbers.length === 0) return [];

  const requested = [...new Set(minifigNumbers.map(normaliseMinifigNumber))].filter((id) => id !== '');
  if (requested.length === 0) return [];

  const [snapshotRows, absenceRows] = await Promise.all([
    prisma.minifigSnapshot.findMany({
      where: { minifigNumber: { in: requested } },
      orderBy: { fetchedAt: 'asc' },
    }),
    prisma.minifigAbsence.findMany({ where: { minifigNumber: { in: requested } } }),
  ]);

  const today = systemClock.today();

  const byNumber = new Map<string, SnapshotRow[]>();
  for (const row of snapshotRows) {
    const bucket = byNumber.get(row.minifigNumber);
    if (bucket === undefined) byNumber.set(row.minifigNumber, [row]);
    else bucket.push(row);
  }
  const absences = new Map(absenceRows.map((row) => [row.minifigNumber, row]));

  return requested.map((minifigNumber) => {
    const state = stateFor(
      minifigNumber,
      byNumber.get(minifigNumber) ?? [],
      absences.get(minifigNumber),
      today,
    );
    return {
      minifigNumber,
      idKind: classifyMinifigId(minifigNumber),
      // Only known once valued — a set payload carries bare ids and nothing else.
      name: state.kind === 'valued' || state.kind === 'no_price' ? state.facts.name : null,
      imageUrl: null,
      state,
    };
  });
}

/**
 * The whole "Minifigures in this set" panel, assembled from cache. ZERO requests.
 *
 * The figure list comes out of the set's own BrickEconomy payload, which has been on disk since
 * the set was valued — so this works retroactively for every set ever looked up, and adds no
 * upstream dependency at all.
 */
export async function readSetMinifigPanel(setNumber: string): Promise<SetMinifigPanel> {
  const today = systemClock.today();
  const threshold = shareThresholdFromEnv();

  const [{ roster, fetchedOn }, [setPreview]] = await Promise.all([
    readSetRoster(setNumber),
    readSetPreviews([setNumber]),
  ]);

  const ids = roster.kind === 'listed' ? roster.figs.listed : [];
  const figs = await readMinifigPreviews(ids);

  const setValuation = setPreview?.valuation;
  const setSealed = setValuation !== undefined && setValuation.kind !== 'none' ? setValuation.valuation.sealed : null;
  const setFetchedOn = setValuation !== undefined && setValuation.kind !== 'none' ? setValuation.fetchedOn : null;
  const setStaleFrom =
    setValuation !== undefined && setValuation.kind !== 'none' ? setValuation.provenance.staleFrom : null;

  const share = minifigShare({ roster, figs, setSealed, setFetchedOn, setStaleFrom });
  const flag = richFlag(share, threshold);

  return {
    setNumber,
    roster,
    figs,
    share,
    flag,
    // Computed HERE, from the current cache, so the button's number cannot be inflated by a
    // client holding a stale panel.
    plan: planMinifigBatch({
      figs,
      today,
      gapMs: minifigGapFromEnv(),
      max: minifigBatchMaxFromEnv(),
    }),
    rosterFetchedOn: fetchedOn,
    shapeNote: idShapeNote(ids),
    threshold,
    today,
  };
}

/** One figure's own page. Cache only. */
export async function readMinifigDetail(minifigNumber: string): Promise<MinifigDetail | null> {
  const [preview] = await readMinifigPreviews([minifigNumber]);
  return preview === undefined ? null : { preview, today: systemClock.today() };
}

/** How many cached figures a free-text search may return, so a broad query cannot flood the grid. */
const SEARCH_LIMIT = 12;

/**
 * Figures already on disk whose NAME matches what was typed.
 *
 * Deliberately a local search and nothing more. BrickEconomy publishes no minifigure search
 * endpoint, and Rebrickable's answers in the fig-001549 id space with no bridge to sw0509 — so a
 * name search that could value its results does not exist to be built. Rather than pretend, Lookup
 * offers exact-number lookup plus this, which is honest about being a search over what you have
 * already valued.
 *
 * Zero requests, like everything else in this file.
 */
export async function searchCachedMinifigs(query: string): Promise<MinifigPreview[]> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  // The name lives inside the stored payload, so this filters on the raw JSON. Crude, but it
  // reaches only rows this machine already paid for and never leaves the database.
  const rows = await prisma.minifigSnapshot.findMany({
    where: { payload: { contains: `"name":"` }, AND: { payload: { contains: trimmed } } },
    orderBy: { fetchedAt: 'desc' },
    take: SEARCH_LIMIT * 4,
  });

  const seen = new Set<string>();
  const matches: string[] = [];
  for (const row of rows) {
    if (seen.has(row.minifigNumber)) continue;
    const payload = parsePayload(row.payload);
    const name = payload?.name;
    if (typeof name !== 'string' || !name.toLowerCase().includes(trimmed.toLowerCase())) continue;
    seen.add(row.minifigNumber);
    matches.push(row.minifigNumber);
    if (matches.length >= SEARCH_LIMIT) break;
  }

  return readMinifigPreviews(matches);
}
