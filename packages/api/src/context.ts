import type { Pool } from '@merces/db';
import type { Logger } from '@merces/core';
import type { ChainPort } from '@merces/domain';
import type { ChainRegistry } from '@merces/chains';

export interface AppContext {
  pool: Pool;
  chains: ChainRegistry;
  log: Logger;
  sessionSecret: string;
  /** mock mode exposes /dev time-travel and faucet routes */
  devMode: boolean;
  chainFor(seriesId: string): ChainPort;
}

export function makeContext(base: Omit<AppContext, 'chainFor'>): AppContext {
  return {
    ...base,
    chainFor(seriesId: string) {
      const chain = seriesId.slice(0, seriesId.indexOf(':'));
      return base.chains.get(chain);
    },
  };
}
