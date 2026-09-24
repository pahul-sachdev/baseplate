import { getSetData } from '../brickeconomy/source.ts';
import { BrickEconomyUnknownSetError } from '../brickeconomy/types.ts';
import type { SetCatalogProvider } from '../../lib/ports.ts';
import type { SetMeta } from '../../lib/types.ts';

/**
 * Set metadata, live from BrickEconomy — the same call that supplies the values, so this
 * costs nothing extra.
 */
export const brickEconomyCatalogProvider: SetCatalogProvider = {
  name: 'brickeconomy',

  async getSet(setNumber: string): Promise<SetMeta | null> {
    try {
      const { meta } = await getSetData(setNumber);
      return meta;
    } catch (error) {
      // A set BrickEconomy has never heard of is a null, not a crash — the engine turns
      // that into SetNotFoundError. Auth and quota failures must still propagate.
      if (error instanceof BrickEconomyUnknownSetError) return null;
      throw error;
    }
  },
};
