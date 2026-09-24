import type { ValuationStore } from '../lib/ports.ts';
import { isCondition, type SetMeta, type Valuation } from '../lib/types.ts';
import { prisma } from './client.ts';

/** Shape of the rows Prisma hands back, mapped onto domain types below. */
interface SetRow {
  setNumber: string;
  name: string;
  theme: string;
  pieces: number;
  msrp: number;
  releaseYear: number;
  retireDate: Date | null;
  retired: boolean;
}

interface ValuationRow {
  setNumber: string;
  condition: string;
  fetchedOn: string;
  sealed: number;
  /** Nullable: no used-market data. Distinct from 0. */
  usedWithBox: number | null;
  usedNoBox: number | null;
  partOut: number;
  trend: number;
  fetchedAt: Date;
}

function toSetMeta(row: SetRow): SetMeta {
  return { ...row };
}

/**
 * `condition` is a plain string in SQLite (no native enum, no CHECK constraint), so it is
 * narrowed here on the way out. A row that fails this was written by something other than
 * this app.
 */
function toValuation(row: ValuationRow): Valuation {
  if (!isCondition(row.condition)) {
    throw new Error(
      `Valuation row for ${row.setNumber} has an unrecognised condition "${row.condition}"`,
    );
  }
  return {
    setNumber: row.setNumber,
    condition: row.condition,
    sealed: row.sealed,
    usedWithBox: row.usedWithBox,
    usedNoBox: row.usedNoBox,
    partOut: row.partOut,
    trend: row.trend,
    fetchedAt: row.fetchedAt,
    fetchedOn: row.fetchedOn,
  };
}

export const prismaValuationStore: ValuationStore = {
  async readSet(setNumber) {
    const row = await prisma.set.findUnique({ where: { setNumber } });
    return row === null ? null : toSetMeta(row);
  },

  async upsertSet(meta) {
    await prisma.set.upsert({
      where: { setNumber: meta.setNumber },
      create: meta,
      update: meta,
    });
  },

  async readValuation({ setNumber, condition, fetchedOn }) {
    const row = await prisma.valuation.findUnique({
      where: { setNumber_condition_fetchedOn: { setNumber, condition, fetchedOn } },
    });
    return row === null ? null : toValuation(row);
  },

  async writeValuation(valuation) {
    const { setNumber, condition, fetchedOn, ...values } = valuation;
    // Upsert rather than create: two concurrent runs on the same day must not race into
    // a unique-constraint violation.
    const row = await prisma.valuation.upsert({
      where: { setNumber_condition_fetchedOn: { setNumber, condition, fetchedOn } },
      create: valuation,
      update: values,
    });
    return toValuation(row);
  },
};
