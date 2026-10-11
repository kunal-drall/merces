import { ChainError, type Command } from '@merces/domain';

/** Only fresh Meteora account keys may accompany the funding wallet. Never accept an API-supplied signer list. */
export function creationSigners(commands: readonly Command[], wallet: string): string[] {
  const extra = commands.flatMap(command => {
    switch (command.kind) {
      case 'createCurveConfig': return [command.config];
      case 'createCurvePool': return [command.baseMint];
      case 'migrateCurve': return [command.firstPositionMint, command.secondPositionMint];
      default: return [];
    }
  });
  if (extra.length && (commands.length !== 1 || extra.includes(wallet) || new Set(extra).size !== extra.length)) {
    throw new ChainError('NotPermitted', 'Meteora account creation must be a separate transaction with distinct fresh accounts');
  }
  return extra;
}
