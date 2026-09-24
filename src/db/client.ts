import { PrismaClient } from '@prisma/client';

/**
 * One client per process. Kept on globalThis so a future Next.js dev server's hot reload
 * doesn't open a new connection pool on every edit.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? new PrismaClient();

if (process.env['NODE_ENV'] !== 'production') globalForPrisma.prisma = prisma;
