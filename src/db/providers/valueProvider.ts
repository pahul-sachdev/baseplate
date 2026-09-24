import { getSetData } from '../brickeconomy/source.ts';
import type { ValueProvider } from '../../lib/ports.ts';
import type { ValueQuote } from '../../lib/types.ts';

/**
 * Sealed and used resale values, live from BrickEconomy.
 *
 * Shares one API call per set per day with the catalog provider — see brickeconomy/source.ts.
 */
export const brickEconomyValueProvider: ValueProvider = {
  name: 'brickeconomy',

  async getValues(setNumber: string): Promise<ValueQuote> {
    const { values } = await getSetData(setNumber);
    return values;
  },
};
