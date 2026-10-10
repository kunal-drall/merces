/**
 * `@merces/math/testing`: Stage 1's deterministic TEST key derivation, kept off the main gateway.
 *
 * `deriveTestPrivateKey(seed)` is `keccak256("MERCES_TEST_KEY" ‖ seed) mod (n − 1) + 1` (Stage 1 SDK signatures.ts):
 * anyone who knows the seed knows the key, so a key derived here must never hold value or sign for a live chain. Only
 * tests, the simulator harness, the Stage 1 vector runner and `stage1:sync`, the local KMS and the dev seeds import this
 * subpath; `packages/math/test/math.test.ts` greps every package's `src` and fails on any other importer (S4 D1).
 */
export { deriveTestPrivateKey } from '@merces/sdk';
