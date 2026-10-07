declare module "circomlibjs" {
  export interface PoseidonFn {
    (inputs: (bigint | number | string)[], initState?: bigint, nOut?: number): Uint8Array;
    F: { toObject(v: Uint8Array): bigint; e(v: bigint | number | string): Uint8Array };
  }
  export function buildPoseidon(): Promise<PoseidonFn>;
}
