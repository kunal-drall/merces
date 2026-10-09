import type { Pool } from '@merces/db';
import { AppError, type Logger } from '@merces/core';
import type { ChainPort } from '@merces/domain';
import type { ChainRegistry } from '@merces/chains';

export interface AppContext {
  pool: Pool;
  chains: ChainRegistry;
  log: Logger;
  sessionSecret: string;
  /** mock mode exposes /dev time-travel and faucet routes */
  devMode: boolean;
  /** Resolves the chain from a `<chain>:<address>` series id; a missing or unconfigured prefix is a 404 for that series. */
  chainFor(seriesId: string): ChainPort;
}

export function makeContext(base: Omit<AppContext, 'chainFor'>): AppContext {
  return {
    ...base,
    chainFor(seriesId: string) {
      const i = seriesId.indexOf(':');
      const key = i > 0 ? seriesId.slice(0, i) : '';
      // an unknown prefix cannot name an existing series: answer 404 rather than let the registry throw a 500
      if (!base.chains.chains.has(key)) throw AppError.notFound('series');
      return base.chains.get(key);
    },
  };
}
