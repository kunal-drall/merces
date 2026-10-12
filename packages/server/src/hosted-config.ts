/** A hosted process must never infer a simulator from a missing manifest or failed RPC. */
export function assertHostedConfig(env: NodeJS.ProcessEnv): void {
  for (const key of ['MERCES_CHAIN_SOLANA_MODE', 'MERCES_CHAIN_EVM_MODE']) {
    if (env[key] !== 'live') throw Error(`${key} must explicitly be live for hosted startup`);
  }
  if (!env.STAGE1_PATH || !env.DATABASE_URL) throw Error('Hosted startup requires a deployment manifest and database');
  if (env.MERCES_DEV_ROUTES !== 'false' || env.MERCES_SEED !== 'false') throw Error('Hosted startup refuses development routes and seeding');
  for (const key of ['SOLANA_KEEPER_SEED_HEX','SOLANA_ALLOWLIST_SEED_HEX','EVM_KEEPER_PRIVATE_KEY','EVM_ALLOWLIST_PRIVATE_KEY']) {
    if(env[key]) throw Error('Hosted startup refuses onchain private signing keys');
  }
  if (env.MERCES_PROOF_SYSTEM !== 'groth16') throw Error('Hosted startup requires Groth16 proofs');
}
