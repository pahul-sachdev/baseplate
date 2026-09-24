import { parseArgs } from 'node:util';

import {
  MOCK_BACKED_STRATEGIES,
  buildDeps,
  closeDeps,
  getDataProvenance,
} from '../src/composition.ts';
import type { Provenance } from '../src/db/brickeconomy/source.ts';
import { BrickEconomyError } from '../src/db/brickeconomy/types.ts';
import { formatPercent, formatUSD } from '../src/lib/money.ts';
import { trendDirection } from '../src/lib/trend.ts';
import { CONDITIONS, SetNotFoundError, isCondition, type Condition, type SetMeta, type StrategyResult, type ValuationResult, type Verdict } from '../src/lib/types.ts';
import { getValuation } from '../src/lib/valuation.ts';
import { verdict } from '../src/lib/verdict.ts';

const USAGE = `
  Usage: pnpm valuate <setNumber> --buy <price> [--condition <condition>]

    <setNumber>    e.g. 75192
    --buy          what you'd pay, in dollars
    --condition    ${CONDITIONS.join(' | ')}   (default: sealed)

  Example: pnpm valuate 75192 --buy 120 --condition sealed
`;

const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;
const bold = (s: string): string => (useColor ? `[1m${s}[0m` : s);
const dim = (s: string): string => (useColor ? `[2m${s}[0m` : s);
const green = (s: string): string => (useColor ? `[32m${s}[0m` : s);
const red = (s: string): string => (useColor ? `[31m${s}[0m` : s);

const DASH = '—';

class UsageError extends Error {}

interface Args {
  setNumber: string;
  buyPrice: number;
  condition: Condition;
}

function parse(argv: string[]): Args {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      buy: { type: 'string' },
      condition: { type: 'string', default: 'sealed' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help === true) throw new UsageError('');

  const setNumber = positionals[0];
  if (setNumber === undefined) throw new UsageError('Missing set number.');
  if (positionals.length > 1) throw new UsageError(`Unexpected argument: ${String(positionals[1])}`);

  if (values.buy === undefined) throw new UsageError('Missing --buy.');
  const buyPrice = Number(values.buy);
  if (!Number.isFinite(buyPrice) || buyPrice < 0) {
    throw new UsageError(`--buy must be a non-negative number, got "${values.buy}".`);
  }

  const condition = values.condition ?? 'sealed';
  if (!isCondition(condition)) {
    throw new UsageError(`--condition must be one of ${CONDITIONS.join(', ')}, got "${condition}".`);
  }

  return { setNumber, buyPrice, condition };
}

function describeSet(set: SetMeta): string {
  const status =
    set.retired && set.retireDate !== null
      ? `retired ${set.retireDate.toISOString().slice(0, 10)}`
      : set.retired
        ? 'retired'
        : 'in production';
  return `${set.theme} · ${set.pieces.toLocaleString('en-US')} pcs · MSRP ${formatUSD(set.msrp)} · ${status}`;
}

function strategyRow(result: StrategyResult, isBest: boolean): string {
  const name = result.strategy.padEnd(12);

  if (!result.eligible) {
    const blanks = DASH.padStart(9) + DASH.padStart(10) + DASH.padStart(10);
    return `  ${name}${blanks}   ${dim(`n/a: ${result.reason}`)}`;
  }

  const fees = result.gross - result.net;
  const cells =
    formatUSD(result.gross).padStart(9) +
    formatUSD(fees).padStart(10) +
    formatUSD(result.net).padStart(10);
  return `  ${name}${cells}${isBest ? `   ${green('← best')}` : ''}`;
}

/** Days between two "YYYY-MM-DD" day keys, for phrasing how stale the data is. */
function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.round(ms / 86_400_000);
}

function warnings(result: ValuationResult, call: Verdict, provenance: Provenance): string[] {
  const lines: string[] = [];

  if (provenance.staleFrom !== null) {
    const age = daysBetween(provenance.staleFrom, result.valuation.fetchedOn);
    lines.push(
      red(
        `! STALE: prices from ${provenance.staleFrom}` +
          (age > 0 ? ` (${age} day${age === 1 ? '' : 's'} old)` : '') +
          ' — BrickEconomy quota was exhausted',
      ),
    );
  }

  // Never let an estimated number pass as an observed one.
  if (provenance.derived.length > 0) {
    lines.push(red(`! estimated, not observed: ${provenance.derived.join(', ')}`));
  }

  // The recommended play deserves louder treatment than a provider label in the header.
  if (MOCK_BACKED_STRATEGIES.has(call.play)) {
    lines.push(
      red(`! ${call.play.toUpperCase()} IS MOCK DATA — BrickLink is not wired yet; not a real quote`),
    );
  }

  return lines;
}

function render(args: Args, result: ValuationResult, call: Verdict, provenance: Provenance): string {
  const { set, valuation } = result;
  const threshold = args.buyPrice * 0.25;
  const trend = `${formatPercent(valuation.trend)} (${trendDirection(valuation.trend)})`;
  const lines = [
    '',
    `  ${bold(`BasePlate — ${set.setNumber}  ${set.name}`)}`,
    `  ${dim(describeSet(set))}`,
    `  ${dim(
      `Condition: ${args.condition} · Buy: ${formatUSD(args.buyPrice)} · data: ${result.source}` +
        ` (${result.providers.values}, ${result.providers.partOut})`,
    )}`,
    '',
    `  ${dim('STRATEGY'.padEnd(12) + 'GROSS'.padStart(9) + 'FEES'.padStart(10) + 'NET'.padStart(10))}`,
    ...call.strategies.map((s) => strategyRow(s, s.eligible && s.strategy === call.play)),
    '',
    `  Play    : ${bold(call.play.toUpperCase())}`,
    `  Net     : ${formatUSD(call.net)}`,
    `  Margin  : ${formatUSD(call.margin)}`,
    `  Verdict : ${call.buy ? green(bold('BUY')) : red(bold('PASS'))}` +
      `        ${dim(`(needs margin > ${formatUSD(threshold)})`)}`,
    '',
    `  ${dim(`12m trend: ${trend}`)}`,
    ...warnings(result, call, provenance).map((line) => `  ${line}`),
    '',
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const result = await getValuation(args.setNumber, args.condition, buildDeps());
  const call = verdict(args.buyPrice, result.valuation, args.condition);
  const provenance = await getDataProvenance(args.setNumber);
  console.log(render(args, result, call, provenance));
}

try {
  await main();
} catch (error) {
  if (error instanceof UsageError) {
    if (error.message !== '') console.error(`\n  ${error.message}`);
    console.error(USAGE);
    process.exitCode = 1;
  } else if (error instanceof SetNotFoundError) {
    console.error(`\n  No catalog entry for set ${error.setNumber}.\n`);
    process.exitCode = 1;
  } else if (error instanceof BrickEconomyError) {
    // Auth, quota and reachability failures are the user's to act on, not stack traces.
    console.error(`\n  ${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closeDeps();
}
