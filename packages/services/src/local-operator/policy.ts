import { z } from 'zod';
import { serviceCommandSchema, type ServiceCommand, type ServiceRole } from '@merces/domain';

export const operatorPolicySchema = z.object({
  wallets: z.array(z.object({ chain: z.enum(['solana','monad']), address: z.string().min(20) }).strict()).min(1).max(20),
  series: z.array(z.string().max(160)).min(1).max(20),
}).strict();
export type OperatorPolicy = z.infer<typeof operatorPolicySchema>;
export const sameWallet=(chain:string,a:string,b:string)=>chain==='solana'?a===b:a.toLowerCase()===b.toLowerCase();
const keepers = new Set(['crankStatus','crankPause','retireIfCapped','burnRetired','beginSettlement','tallyBids','finalizeSettlement','processBid','deliverBid','completeCurve','collectCurveProceeds','syncCurveUnits','sweepRouter','closeRouterPeriod','openWindow','beginWindowSettlement','tallyWindow','finalizeWindow','processOrder','deliverOrder']);
export function operatorCommand(policy: OperatorPolicy, chain: string, role: ServiceRole, input: unknown): ServiceCommand {
  if (!['solana','monad'].includes(chain)) throw Error('operator-network-refused');
  const command = serviceCommandSchema.parse(input) as ServiceCommand;
  // Refuse unrecognised fields rather than silently stripping a caller's intent.
  if (Object.keys(input as object).some(k => !(k in command))) throw Error('operator-command-refused');
  if (command.kind === 'setAllowlist') {
    if (role !== 'allowlistManager' || !policy.wallets.some(w => w.chain === chain && sameWallet(chain,w.address,command.wallet))) throw Error('operator-wallet-refused');
  } else if (role !== 'keeper' || !keepers.has(command.kind) || !('seriesId' in command) || !policy.series.includes(command.seriesId) || !command.seriesId.startsWith(chain+':')) throw Error('operator-command-refused');
  return command;
}

export const envelopeSchema = z.object({v:z.literal(1),wrappedKey:z.string().regex(/^[A-Za-z0-9+/=]+$/).max(1024),iv:z.string().regex(/^[A-Za-z0-9+/=]+$/).max(32),ciphertext:z.string().regex(/^[A-Za-z0-9+/=]+$/).max(720000)}).strict();
