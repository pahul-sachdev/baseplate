import type { CatalogImage, CatalogImageProvider } from '../../lib/catalogImagePort.ts';
import { prisma } from '../client.ts';
import { fetchSetImage } from './client.ts';

/**
 * Images, cached permanently in SetImage.
 *
 * Set artwork does not change, so a URL is fetched once and read forever. The cache stores
 * misses too — a row with imageUrl null means "asked, none available", which stops a set with
 * no artwork from being re-requested against a rate-limited API on every refresh.
 */
export const rebrickableImageProvider: CatalogImageProvider = {
  name: 'rebrickable',

  async getImage(setNumber: string): Promise<CatalogImage> {
    const cached = await prisma.setImage.findUnique({ where: { setNumber } });
    if (cached !== null) {
      return {
        setNumber,
        imageUrl: cached.imageUrl,
        name: cached.name,
        year: cached.year,
        theme: cached.theme,
      };
    }

    const fetched = await fetchSetImage(setNumber);
    const record = {
      imageUrl: fetched.imageUrl,
      name: fetched.name,
      year: fetched.year,
      theme: fetched.theme,
    };
    await prisma.setImage.upsert({
      where: { setNumber },
      create: { setNumber, ...record },
      update: record,
    });
    return fetched;
  },
};
