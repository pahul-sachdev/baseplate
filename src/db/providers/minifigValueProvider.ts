import { getMinifigLookup } from '../brickeconomy/minifig/source.ts';
import type { MinifigLookup, MinifigValueProvider } from '../../lib/minifigValuePort.ts';

/**
 * Minifigure values, from BrickEconomy.
 *
 * Not part of EngineDeps: the valuation engine has no concept of a minifigure, so this implements
 * its own UI-facing port — the same split catalogImagePort and setSearchPort already established.
 */
export const brickEconomyMinifigValueProvider: MinifigValueProvider = {
  name: 'brickeconomy',
  get(minifigNumber: string): Promise<MinifigLookup> {
    return getMinifigLookup(minifigNumber);
  },
};
