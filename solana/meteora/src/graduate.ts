/**
 * CLI: graduate a Merces curve-mode series end to end on devnet or a local validator.
 *
 *   pnpm --filter @merces/meteora graduate -- \
 *     --cluster devnet --payer ~/.config/solana/payer.json --issuer ./issuer.json \
 *     --config ./series-config.json [--merces ./merces.json] [--quote-mint <pubkey> | --create-quote-mint] \
 *     [--buyers 3] [--damm-config <pubkey>] [--state ./graduation-state.json] [--json]
 *
 * Flags
 *   --cluster devnet|localnet|testnet   RPC preset (mainnet is refused); or --rpc <url>
 *   --payer <keypair.json>              pays rent/fees and funds the test buyers; default Merces wallet
 *   --issuer <keypair.json>             the issuer (pool creator); receives the creator migration fee and the vesting escrow
 *   --merces <keypair.json>             Merces partner wallet (fee_claimer, leftover_receiver); default: payer
 *   --config <json>                     output of the config generator (`pnpm --filter @merces/meteora config`)
 *   --quote-mint <pubkey>               quote mint override (devnet USDC); default from the config file
 *   --create-quote-mint                 create a 6-decimal mock USDC (payer = mint authority) and mint test funds
 *   --buyers <n>                        number of test buyer wallets (default 3)
 *   --max-buy <quote>                   largest single buy in whole quote units (default: threshold / 3)
 *   --damm-config <pubkey>              DAMM v2 config to migrate into (default: from the config file)
 *   --state <path>                      state file for idempotent resume (default ./graduation-state.json)
 *   --name/--symbol/--uri               base token metadata
 *   --json                              print the report as JSON
 */
import { Connection } from "@solana/web3.js";
import { boolFlag, loadKeypair, logger, optionalFlag, parseArgs, pubkey, requireFlag, resolveRpcUrl } from "./cli.js";
import { mercesCurveConfigFromJson } from "./config.js";
import { formatReport, runGraduation } from "./graduation.js";
import { readFileSync } from "node:fs";
import { jsonify } from "./types.js";

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const log = logger();
  const rpc = resolveRpcUrl(optionalFlag(args, "cluster"), optionalFlag(args, "rpc"));
  const connection = new Connection(rpc, "confirmed");
  const payer = loadKeypair(requireFlag(args, "payer"));
  const issuer = loadKeypair(requireFlag(args, "issuer"));
  const mercesPath = optionalFlag(args, "merces");
  const merces = mercesPath ? loadKeypair(mercesPath) : payer;
  const config = mercesCurveConfigFromJson(readFileSync(requireFlag(args, "config"), "utf8"));
  const quoteMintFlag = optionalFlag(args, "quote-mint");
  const dammConfigFlag = optionalFlag(args, "damm-config");
  const buyersFlag = optionalFlag(args, "buyers");
  const maxBuyFlag = optionalFlag(args, "max-buy");
  const report = await runGraduation({
    connection,
    config,
    participants: { payer, issuer, merces },
    statePath: optionalFlag(args, "state") ?? "./graduation-state.json",
    ...(quoteMintFlag ? { quoteMint: pubkey(quoteMintFlag, "--quote-mint") } : {}),
    createQuoteMint: boolFlag(args, "create-quote-mint"),
    ...(buyersFlag ? { buyers: Number(buyersFlag) } : {}),
    ...(maxBuyFlag ? { maxBuy: BigInt(maxBuyFlag) * 10n ** BigInt(config.input.quoteDecimals) } : {}),
    ...(dammConfigFlag ? { dammConfig: pubkey(dammConfigFlag, "--damm-config") } : {}),
    tokenMetadata: {
      name: optionalFlag(args, "name") ?? `Merces HEU ${config.input.seriesLabel || "curve"}`.slice(0, 32),
      symbol: optionalFlag(args, "symbol") ?? "HEU",
      uri: optionalFlag(args, "uri") ?? "https://merces.example/heu-curve-devnet.json",
    },
    log,
  });
  if (boolFlag(args, "json")) process.stdout.write(`${JSON.stringify(jsonify(report), null, 2)}\n`);
  else process.stdout.write(`${formatReport(report, config.input.quoteDecimals, config.input.tokenDecimals)}\n`);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  logger()(e instanceof Error ? e.stack ?? e.message : String(e));
  process.exit(1);
});
