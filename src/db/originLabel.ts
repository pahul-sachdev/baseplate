import { readSetPreviews } from './previews.ts';
import type { FigOrigin } from '../lib/figOrigin.ts';
import type { Origin } from '../lib/origin.ts';

/**
 * The words and the href for a "← Back to …" link.
 *
 * Split from src/lib/origin.ts because naming a SET origin needs the database, and src/lib is
 * pure. The split is also the security boundary doing its job: origin.ts and figOrigin.ts decide
 * whether a destination is LEGAL and build the href; this file only decides what to CALL it, and
 * it looks the name up by the already-validated set number rather than reading anything out of the
 * URL.
 *
 * A cache read, like every other read model here — naming a breadcrumb must never spend a request,
 * and readSetPreviews cannot reach the network (its own suite pins that with fetch stubbed to
 * throw). mergePreviewMeta always produces a name, falling back to `Set ${setNumber}`, so a figure
 * opened from a set this database has never seen still gets honest words — and the SAME words the
 * set page itself will show when the user arrives there.
 */

export interface BackLink {
  href: string;
  label: string;
}

/**
 * Resolves a figure origin to a link.
 *
 * The set's name comes from the database or it does not render: in the worst case — a crafted
 * ?inSet= naming a set nobody has cached — the label is the `Set 10236-1` fallback, built from a
 * number that already passed isAddressableSetNumber and escaped by React. The URL can supply a
 * number; it can never supply a word.
 */
export async function resolveBackLink(origin: FigOrigin): Promise<BackLink> {
  if (origin.kind === 'board') return { href: origin.href, label: origin.label };

  try {
    const [preview] = await readSetPreviews([origin.setNumber]);
    return {
      href: origin.href,
      label: preview?.meta.name ?? origin.fallbackLabel,
    };
  } catch {
    // A breadcrumb is never worth failing a page over.
    return { href: origin.href, label: origin.fallbackLabel };
  }
}

/** The board case, for pages that never have a set origin. Kept here so callers import one thing. */
export function boardBackLink(origin: Origin): BackLink {
  return { href: origin.href, label: origin.label };
}
