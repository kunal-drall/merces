import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';

/** Service routes added in later milestones register here so buildApp, dev:mock and the contract check see the same set. */
export const serviceRouteRegistrars: ((app: FastifyInstance, ctx: AppContext) => void)[] = [];

export function registerAllRoutes(app: FastifyInstance, ctx: AppContext): void {
  for (const r of serviceRouteRegistrars) r(app, ctx);
}
