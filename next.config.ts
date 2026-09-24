import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    // Rebrickable serves set artwork from its CDN. Image URLs are cached permanently in
    // SetImage; this only allows Next's optimiser to load them.
    remotePatterns: [
      { protocol: 'https', hostname: 'cdn.rebrickable.com' },
      // Brickset serves catalogue artwork alongside the set data, so the retiring board needs no
      // second image lookup — the URL arrives with the sync.
      { protocol: 'https', hostname: 'images.brickset.com' },
    ],
  },
  // Prisma's engine cannot be bundled — it must stay a real Node module at runtime.
  serverExternalPackages: ['@prisma/client', '.prisma/client'],
};

export default nextConfig;
