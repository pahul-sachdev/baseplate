import type { BatchPlan } from './minifigBatch.ts';
import type { MinifigPreview } from './minifigPreview.ts';
import type { MinifigRoster } from './minifigRoster.ts';
import type { MinifigRichFlag, MinifigShare } from './minifigShare.ts';

/**
 * Everything the "Minifigures in this set" panel renders, assembled entirely from rows already on
 * disk.
 *
 * Its own module so the three things it aggregates — the state union, the share and the batch
 * plan — stay independent of each other. Nothing here computes; src/db/minifigReads.ts fills it in
 * and cannot reach the network.
 */
export interface SetMinifigPanel {
  setNumber: string;
  roster: MinifigRoster;
  /** In roster order, one entry per named id. Never fewer, never re-ordered. */
  figs: readonly MinifigPreview[];
  share: MinifigShare;
  flag: MinifigRichFlag;
  /** What one "value the rest" click would cost, computed server-side from this cache. */
  plan: BatchPlan;
  /** The day the set payload the roster came from was fetched. Null when the set is unvalued. */
  rosterFetchedOn: string | null;
  /** Ids that do not look like figure numbers, offered as an advisory before spending. */
  shapeNote: { unusual: readonly string[] } | null;
  /** The minifig-rich bar in force, so the UI never hard-codes 50%. */
  threshold: number;
  today: string;
}

/** One figure's own page, which is the panel's row with the set context dropped. */
export interface MinifigDetail {
  preview: MinifigPreview;
  today: string;
}
