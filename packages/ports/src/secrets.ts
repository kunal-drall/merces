/**
 * Secrets come from the environment (a KMS in production); none is committed (Part I). A named development default
 * is accepted only while every chain runs on the simulator: once any chain is live, a missing, short or
 * dev-default value refuses to start instead of silently signing sessions or encrypting the vault with a constant
 * that is published in this repository.
 */
export function resolveSecret(env: NodeJS.ProcessEnv, name: string, opts: { simulatorOnly: boolean; devDefault: string; minLength?: number }): string {
  const v = env[name];
  const min = opts.minLength ?? 32;
  if (v && v.length >= min && v !== opts.devDefault) return v;
  if (opts.simulatorOnly) return v && v.length > 0 ? v : opts.devDefault;
  throw new Error(`${name} must be set to a secret of at least ${min} characters when any chain is live; development defaults are accepted only when every chain runs on the simulator`);
}

/** True when every registered chain is the simulator (no live adapter). */
export function simulatorOnly(chains: { chains: Map<string, { mode: string }> }): boolean {
  return [...chains.chains.values()].every((c) => c.mode === 'mock');
}
