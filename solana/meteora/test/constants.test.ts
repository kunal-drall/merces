import { describe, expect, it } from "vitest";
import * as sdk from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as cpAmm from "@meteora-ag/cp-amm-sdk";
import { PublicKey } from "@solana/web3.js";
import * as c from "../src/constants.js";

describe("program constants agree with the pinned SDKs", () => {
  it("program ids and PDAs", () => {
    expect(sdk.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()).toBe(c.DBC_PROGRAM_ID);
    expect(sdk.DAMM_V2_PROGRAM_ID.toBase58()).toBe(c.DAMM_V2_PROGRAM_ID);
    expect(sdk.LOCKER_PROGRAM_ID.toBase58()).toBe(c.LOCKER_PROGRAM_ID);
    expect(sdk.deriveDbcPoolAuthority().toBase58()).toBe(c.DBC_POOL_AUTHORITY);
    expect(sdk.deriveDammV2PoolAuthority().toBase58()).toBe(c.DAMM_V2_POOL_AUTHORITY);
    expect(cpAmm.CP_AMM_PROGRAM_ID.toBase58()).toBe(c.DAMM_V2_PROGRAM_ID);
    expect(cpAmm.derivePoolAuthority().toBase58()).toBe(c.DAMM_V2_POOL_AUTHORITY);
    // the pool authority is a PDA of the program id alone, hence identical on every cluster
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from("pool_authority")], new PublicKey(c.DBC_PROGRAM_ID));
    expect(pda.toBase58()).toBe(c.DBC_POOL_AUTHORITY);
  });

  it("DAMM v2 migration fee config keys", () => {
    expect(sdk.DAMM_V2_MIGRATION_FEE_ADDRESS.map((k) => k.toBase58())).toEqual([...c.DAMM_V2_MIGRATION_FEE_ADDRESS]);
    expect(c.DAMM_V2_MIGRATION_FEE_ADDRESS).toHaveLength(7);
  });

  it("numeric bounds", () => {
    expect(sdk.MIN_SQRT_PRICE.toString()).toBe(c.MIN_SQRT_PRICE.toString());
    expect(sdk.MAX_SQRT_PRICE.toString()).toBe(c.MAX_SQRT_PRICE.toString());
    expect(BigInt(sdk.FEE_DENOMINATOR)).toBe(c.FEE_DENOMINATOR);
    expect(BigInt(sdk.MAX_FEE_NUMERATOR)).toBe(c.MAX_FEE_NUMERATOR);
    expect(BigInt(sdk.MIN_FEE_NUMERATOR)).toBe(c.MIN_FEE_NUMERATOR);
    expect(sdk.MAX_FEE_BPS).toBe(c.MAX_FEE_BPS);
    expect(sdk.MIN_FEE_BPS).toBe(c.MIN_FEE_BPS);
    expect(sdk.MAX_CURVE_POINT).toBe(c.MAX_CURVE_POINT);
    expect(BigInt(sdk.SWAP_BUFFER_PERCENTAGE)).toBe(c.SWAP_BUFFER_PERCENTAGE);
    expect(sdk.MAX_MIGRATION_FEE_PERCENTAGE).toBe(c.MAX_MIGRATION_FEE_PERCENTAGE);
    expect(sdk.MIN_LOCKED_LIQUIDITY_BPS).toBe(c.MIN_LOCKED_LIQUIDITY_BPS);
    expect(sdk.SECONDS_PER_DAY).toBe(c.SECONDS_PER_DAY);
    expect(sdk.MAX_LOCK_DURATION_IN_SECONDS).toBe(c.MAX_LOCK_DURATION_IN_SECONDS);
    expect(BigInt(sdk.MIN_POOL_CREATION_FEE)).toBe(c.MIN_POOL_CREATION_FEE);
    expect(BigInt(sdk.MAX_POOL_CREATION_FEE)).toBe(c.MAX_POOL_CREATION_FEE);
    expect(sdk.MIN_MIGRATED_POOL_FEE_BPS).toBe(c.MIN_MIGRATED_POOL_FEE_BPS);
    expect(sdk.MAX_MIGRATED_POOL_FEE_BPS).toBe(c.MAX_MIGRATED_POOL_FEE_BPS);
    expect(BigInt(sdk.PROTOCOL_FEE_PERCENT)).toBe(c.PROTOCOL_FEE_PERCENT);
    expect(BigInt(sdk.HOST_FEE_PERCENT)).toBe(c.HOST_FEE_PERCENT);
    expect(BigInt(sdk.PROTOCOL_POOL_CREATION_FEE_PERCENT)).toBe(c.PROTOCOL_POOL_CREATION_FEE_PERCENT);
    expect(sdk.BIN_STEP_BPS_U128_DEFAULT.toString()).toBe(c.BIN_STEP_BPS_U128_DEFAULT.toString());
    expect(sdk.U24_MAX).toBe(c.U24_MAX);
    expect(sdk.U16_MAX).toBe(c.U16_MAX);
  });

  it("DAMM v2 fee constants used by the migrated-pool validator", () => {
    expect(BigInt(cpAmm.FEE_DENOMINATOR)).toBe(c.DAMM_V2_FEE_DENOMINATOR);
    expect(BigInt(cpAmm.MIN_FEE_NUMERATOR)).toBe(c.DAMM_V2_MIN_FEE_NUMERATOR);
    expect(BigInt(cpAmm.MAX_FEE_NUMERATOR_V1)).toBe(c.DAMM_V2_MAX_FEE_NUMERATOR_V1);
    expect(cpAmm.CURRENT_POOL_VERSION).toBe(1);
  });

  it("enum discriminants match the SDK", () => {
    expect(c.ActivationType.Timestamp).toBe(sdk.ActivationType.Timestamp);
    expect(c.TokenType.Token2022).toBe(sdk.TokenType.Token2022);
    expect(c.CollectFeeMode.QuoteToken).toBe(sdk.CollectFeeMode.QuoteToken);
    expect(c.MigrationOption.DammV2).toBe(sdk.MigrationOption.MET_DAMM_V2);
    expect(c.BaseFeeMode.FeeSchedulerLinear).toBe(sdk.BaseFeeMode.FeeSchedulerLinear);
    expect(c.MigrationFeeOption.Customizable).toBe(sdk.MigrationFeeOption.Customizable);
    expect(c.TokenAuthorityOption.Immutable).toBe(sdk.TokenAuthorityOption.Immutable);
    expect(c.MigratedCollectFeeMode.Compounding).toBe(sdk.MigratedCollectFeeMode.Compounding);
    expect(c.DammV2BaseFeeMode.FeeMarketCapSchedulerExponential).toBe(sdk.DammV2BaseFeeMode.FeeMarketCapSchedulerExponential);
    expect(c.SwapMode.PartialFill).toBe(sdk.SwapMode.PartialFill);
  });
});
