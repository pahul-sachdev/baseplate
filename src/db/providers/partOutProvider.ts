import type { PartOutProvider } from '../../lib/ports.ts';
import type { PartOutQuote } from '../../lib/types.ts';
import { findFixture } from './fixtures.ts';
import { seededSet } from './seeded.ts';

/**
 * Part-out value: what the set is worth broken into individual lots.
 */
export const mockPartOutProvider: PartOutProvider = {
  name: 'bricklink-mock',

  async getPartOut(setNumber: string): Promise<PartOutQuote> {
    // TODO: real API call — BrickLink Price Guide
    //   GET https://api.bricklink.com/api/store/v1/items/SET/{setNumber}-1/price
    //     ?guide_type=sold&new_or_used=N
    //   Auth: OAuth 1.0a signed request. All four values are required together:
    //     BRICKLINK_CONSUMER_KEY, BRICKLINK_CONSUMER_SECRET,
    //     BRICKLINK_TOKEN_VALUE, BRICKLINK_TOKEN_SECRET
    //   Part-out is the sum over the set's inventory, so this is really two calls:
    //     /items/SET/{setNumber}-1/subsets  -> the parts list
    //     /items/PART/{partNo}/price        -> per-part value (batch these)
    //   lotCount is the number of distinct part/colour lots in that inventory.
    const fixture = findFixture(setNumber);
    return fixture === null ? seededSet(setNumber).partOut : fixture.partOut;
  },
};
