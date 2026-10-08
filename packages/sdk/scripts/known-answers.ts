/**
 * Generates the SDK known-answer vectors: exact bytes and hashes other implementations (the Solana
 * programs, the EVM contracts, Stage 2 services) must reproduce. Written to
 * `packages/sdk/test/known-answers.json` and copied to `packages/vectors/known_answers.json`.
 *
 *   pnpm --filter @merces/sdk known-answers
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChainKind,
  DEFAULT_PARAMETERS,
  EVM_CHAIN_IDS,
  MAGIC,
  PARAMETER_BOUNDS,
  PARAMETER_NAMES,
  SOLANA_CLUSTER_TAGS,
  ZERO_INCOME_COMMITMENT,
  addressFromPrivateKey,
  amendmentMessage,
  base58Encode,
  bidCommitment,
  bidCommitmentPreimage,
  bytes32,
  bytesToHex,
  civilFromTimestamp,
  computeDomain,
  daysInPeriod,
  deriveSalt,
  deriveTestPrivateKey,
  extinguishMessage,
  fieldToBytes32,
  fxFallbackMessage,
  hexToBytes,
  incomeCommitment,
  keccak256,
  mulDiv,
  mulDivCeil,
  parametersToStrings,
  pauseApprovalMessage,
  periodEnd,
  periodId,
  periodLabel,
  periodOf,
  periodStart,
  poseidon2,
  poseidon5,
  publicKeyFromPrivate,
  quarterOf,
  reportAttestationMessage,
  routerIncomeCommitment,
  signDigest,
  snakeCase,
  termsCommitment,
  timestampFromCivil,
  toChecksumAddress,
  tradingDaysInPeriod,
  trueUpMessage,
  unpaused,
  pausedWithin,
  fxPairId,
  normalizePythPrice,
  invertRate,
  yearGrossAdd,
  yearGrossGet,
  newYearGross,
  settlementYear,
  ZERO_INCOME_COMMITMENT as ZERO_IC,
  utf8,
  walletFromEvmAddress,
  walletFromSolanaPubkey,
  yearOf,
  WAD,
  type SignedMessage,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_SDK = resolve(here, "../test/known-answers.json");
const OUT_VECTORS = resolve(here, "../../vectors/known_answers.json");

const hex = bytesToHex;
const dec = (v: bigint) => v.toString();

// ---- fixtures ---------------------------------------------------------------------------------
const EVM_REGISTRY = "0x1111111111111111111111111111111111111111";
// Deterministic 32-byte test pubkeys (keccak of a label), shown in base58 too.
const SOLANA_REGISTRY = keccak256(utf8("merces:test:solana-registry"));
const SOLANA_REGISTRY_B58 = base58Encode(SOLANA_REGISTRY);
const SOLANA_SERIES_PDA = keccak256(utf8("merces:test:series-pda"));
const SOLANA_BIDDER = keccak256(utf8("merces:test:bidder"));
const domains = [
  {
    name: "evm-monad-testnet",
    chainKind: ChainKind.Evm,
    chainId: EVM_CHAIN_IDS.monadTestnet,
    registry: walletFromEvmAddress(EVM_REGISTRY),
    registryNote: `EVM address ${EVM_REGISTRY} left-padded to 32 bytes`,
  },
  {
    name: "solana-devnet",
    chainKind: ChainKind.Solana,
    chainId: SOLANA_CLUSTER_TAGS.devnet,
    registry: SOLANA_REGISTRY,
    registryNote: `base58 ${SOLANA_REGISTRY_B58}`,
  },
].map((d) => ({ ...d, domain: computeDomain(d.chainKind, d.chainId, d.registry) }));

const evmSeriesKey = bytes32(1n); // EVM: bytes32(uint256(series_id)) with series_id = 1
const solSeriesKey = walletFromSolanaPubkey(base58Encode(SOLANA_SERIES_PDA));

const keys = ["attestor1", "attestor2", "verifier1", "issuer", "b1"].map((seed) => {
  const privateKey = deriveTestPrivateKey(seed);
  return { seed, privateKey, publicKey: publicKeyFromPrivate(privateKey), address: addressFromPrivateKey(privateKey) };
});

function msgEntry(domainName: string, seriesKeyNote: string, fields: Record<string, string | number>, m: SignedMessage, signer: (typeof keys)[number]) {
  const sig = signDigest(m.digest, signer.privateKey);
  return {
    kind: m.kind,
    magic: MAGIC[m.kind],
    domain: domainName,
    seriesKey: seriesKeyNote,
    fields,
    preimage: hex(m.preimage),
    preimageLength: m.preimage.length,
    digest: hex(m.digest),
    signer: signer.seed,
    signerAddress: hex(signer.address),
    signature: hex(sig.bytes),
    r: hex(bytes32(sig.r)),
    s: hex(bytes32(sig.s)),
    v: sig.v,
  };
}

// ---- hashes -----------------------------------------------------------------------------------
const keccakCases = [new Uint8Array(0), utf8("abc"), utf8("MERCES_REPORT_V1"), new Uint8Array(32), hexToBytes("0x" + "ff".repeat(64))].map((input) => ({
  input: hex(input),
  output: hex(keccak256(input)),
}));

// ---- poseidon ---------------------------------------------------------------------------------
const poseidon2Cases = [
  [0n, 0n],
  [1n, 2n],
  [123_456_789n, 987_654_321n],
  [(1n << 64n) - 1n, deriveSalt("ka", "salt-a")],
].map(([a, b]) => ({ inputs: [dec(a!), dec(b!)], output: dec(poseidon2(a!, b!)), outputHex: hex(fieldToBytes32(poseidon2(a!, b!))) }));
const poseidon5Cases = [
  [1n, 2n, 3n, 4n, 5n],
  [80_000_000_000n, 1_000_000_000_000_000n, 840n, 0n, deriveSalt("ka", "terms-a")],
].map((v) => {
  const t = v as [bigint, bigint, bigint, bigint, bigint];
  return { inputs: t.map(dec), output: dec(poseidon5(t)), outputHex: hex(fieldToBytes32(poseidon5(t))) };
});

const termsCases = [
  { theta: 80_000_000_000n, rWad: 1_000_000_000_000_000n, currencyCode: 840, indexingRule: 0, termsSalt: deriveSalt("ka", "terms-1") },
  { theta: 65_000_000_000n, rWad: 500_000_000_000_000n, currencyCode: 978, indexingRule: 1, termsSalt: deriveSalt("ka", "terms-2") },
].map((t) => {
  const c = termsCommitment(t);
  return {
    theta: dec(t.theta),
    rWad: dec(t.rWad),
    currencyCode: t.currencyCode,
    indexingRule: t.indexingRule,
    termsSalt: dec(t.termsSalt),
    commitment: dec(c),
    commitmentHex: hex(fieldToBytes32(c)),
  };
});
const incomeCases = [
  { incomeYtd: 0n, incomeSalt: 0n },
  { incomeYtd: 30_000_000_000n, incomeSalt: deriveSalt("ka", "income-1") },
  { incomeYtd: 160_000_000_000n, incomeSalt: deriveSalt("ka", "income-2") },
].map((i) => {
  const c = incomeCommitment(i.incomeYtd, i.incomeSalt);
  return { incomeYtd: dec(i.incomeYtd), incomeSalt: dec(i.incomeSalt), commitment: dec(c), commitmentHex: hex(fieldToBytes32(c)) };
});

// ---- bid commitments --------------------------------------------------------------------------
const bidCases = [
  { price: 1_000_000n, quantity: 100n, salt: bytes32(deriveSalt("ka", "bid-1")), wallet: walletFromEvmAddress("0x" + "a1".repeat(20)), walletNote: "EVM 0xa1…a1 padded" },
  { price: 2_500_000n, quantity: 7n, salt: bytes32(deriveSalt("ka", "bid-2")), wallet: walletFromSolanaPubkey(base58Encode(SOLANA_BIDDER)), walletNote: `Solana pubkey base58 ${base58Encode(SOLANA_BIDDER)}` },
].map((b) => ({
  price: dec(b.price),
  quantity: dec(b.quantity),
  salt: hex(b.salt),
  wallet: hex(b.wallet),
  walletNote: b.walletNote,
  preimage: hex(bidCommitmentPreimage(b.price, b.quantity, b.salt, b.wallet)),
  commitment: hex(bidCommitment(b.price, b.quantity, b.salt, b.wallet)),
}));

// ---- messages ---------------------------------------------------------------------------------
const incomeC = fieldToBytes32(incomeCommitment(110_000_000_000n, deriveSalt("ka", "income-msg")));
const priorC = fieldToBytes32(incomeCommitment(70_000_000_000n, deriveSalt("ka", "income-msg-prior")));
const newTerms = fieldToBytes32(termsCommitment({ theta: 82_400_000_000n, rWad: 1_000_000_000_000_000n, currencyCode: 840, indexingRule: 0, termsSalt: deriveSalt("ka", "terms-amend") }));
const messages: ReturnType<typeof msgEntry>[] = [];
for (const d of domains) {
  const sk = d.chainKind === ChainKind.Evm ? evmSeriesKey : solSeriesKey;
  const skNote = d.chainKind === ChainKind.Evm ? "bytes32(uint256(1))" : `series PDA base58 ${base58Encode(SOLANA_SERIES_PDA)}`;
  const common = { domain: d.domain, seriesKey: sk };
  messages.push(
    msgEntry(
      d.name,
      skNote,
      { period: 8106, priorIncomeCommitment: hex(priorC), incomeCommitment: hex(incomeC), tier: 2, liquidityEvent: false },
      reportAttestationMessage({ ...common, period: 8106, priorIncomeCommitment: priorC, incomeCommitment: incomeC, tier: 2, liquidityEvent: false }),
      keys[2]!,
    ),
    msgEntry(
      d.name,
      skNote,
      { period: 8106, priorIncomeCommitment: hex(priorC), incomeCommitment: hex(incomeC), tier: 3, liquidityEvent: true },
      reportAttestationMessage({ ...common, period: 8106, priorIncomeCommitment: priorC, incomeCommitment: incomeC, tier: 3, liquidityEvent: true }),
      keys[0]!,
    ),
    msgEntry(
      d.name,
      skNote,
      { period: 8104, priorIncomeCommitment: hex(fieldToBytes32(ZERO_IC)), incomeCommitment: hex(incomeC), tier: 2, liquidityEvent: false },
      reportAttestationMessage({ ...common, period: 8104, priorIncomeCommitment: ZERO_IC, incomeCommitment: incomeC, tier: 2, liquidityEvent: false }),
      keys[2]!,
    ),
    msgEntry(d.name, skNote, { period: 8106, fxRateWad: "1083456789012345678" }, fxFallbackMessage({ ...common, period: 8106, fxRateWad: 1_083_456_789_012_345_678n }), keys[0]!),
    msgEntry(d.name, skNote, { amendmentNonce: "0", newTermsCommitment: hex(newTerms), newCapMultipleWad: dec((25n * WAD) / 10n) }, amendmentMessage({ ...common, amendmentNonce: 0n, newTermsCommitment: newTerms, newCapMultipleWad: (25n * WAD) / 10n }), keys[0]!),
    msgEntry(d.name, skNote, { pauseNonce: "0", pauseEnd: "1783209600" }, pauseApprovalMessage({ ...common, pauseNonce: 0n, pauseEnd: 1_783_209_600n }), keys[0]!),
    msgEntry(d.name, skNote, { extinguishNonce: "0" }, extinguishMessage({ ...common, extinguishNonce: 0n }), keys[0]!),
    msgEntry(d.name, skNote, { extinguishNonce: "0" }, extinguishMessage({ ...common, extinguishNonce: 0n }), keys[1]!),
    msgEntry(d.name, skNote, { trueupNonce: "0", year: 2026, adjustment: "-2500000000", attestationTs: "1799000000" }, trueUpMessage({ ...common, trueupNonce: 0n, year: 2026, adjustment: -2_500_000_000n, attestationTs: 1_799_000_000n }), keys[0]!),
    msgEntry(d.name, skNote, { trueupNonce: "1", year: 2026, adjustment: "2500000000", attestationTs: "1799000000" }, trueUpMessage({ ...common, trueupNonce: 1n, year: 2026, adjustment: 2_500_000_000n, attestationTs: 1_799_000_000n }), keys[0]!),
  );
}

// ---- periods ----------------------------------------------------------------------------------
const periodTimestamps: [number, number, number, number, number, number][] = [
  [1970, 1, 1, 0, 0, 0],
  [2000, 2, 29, 12, 0, 0],
  [2024, 2, 29, 0, 0, 0],
  [2024, 3, 31, 23, 59, 59],
  [2024, 4, 1, 0, 0, 0],
  [2024, 12, 31, 23, 59, 59],
  [2025, 1, 1, 0, 0, 0],
  [2026, 1, 1, 0, 0, 0],
  [2026, 3, 31, 23, 59, 59],
  [2026, 4, 1, 0, 0, 0],
  [2026, 6, 30, 23, 59, 59],
  [2026, 7, 1, 0, 0, 0],
  [2026, 9, 30, 23, 59, 59],
  [2026, 10, 1, 0, 0, 0],
  [2026, 12, 31, 23, 59, 59],
  [2027, 2, 28, 23, 59, 59],
  [2027, 3, 1, 0, 0, 0],
  [2028, 2, 29, 23, 59, 59],
  [2028, 3, 1, 0, 0, 0],
  [2028, 12, 31, 23, 59, 59],
  [2029, 1, 1, 0, 0, 0],
  [2029, 9, 30, 23, 59, 59],
  [2029, 10, 1, 0, 0, 0],
  [2032, 2, 29, 6, 30, 0],
  [2038, 1, 19, 3, 14, 7],
  [2099, 12, 31, 23, 59, 59],
  [2100, 2, 28, 23, 59, 59],
  [2100, 3, 1, 0, 0, 0],
  [2400, 2, 29, 0, 0, 0],
];
const periods = periodTimestamps.map(([y, m, d, hh, mm, ss]) => {
  const ts = timestampFromCivil(y, m, d, hh, mm, ss);
  const pid = periodOf(ts);
  const c = civilFromTimestamp(ts);
  return {
    iso: `${String(c.year).padStart(4, "0")}-${String(c.month).padStart(2, "0")}-${String(c.day).padStart(2, "0")}T${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}:${String(c.second).padStart(2, "0")}Z`,
    timestamp: dec(ts),
    periodId: pid,
    label: periodLabel(pid),
    year: yearOf(pid),
    quarter: quarterOf(pid),
    periodStart: dec(periodStart(pid)),
    periodEnd: dec(periodEnd(pid)),
    daysInPeriod: Number(daysInPeriod(pid)),
    tradingDaysInPeriod: Number(tradingDaysInPeriod(pid)),
  };
});

// ---- pauses (SPEC §6.4 unpaused countdowns) ----------------------------------------------------
const pauseList = [
  { start: timestampFromCivil(2026, 4, 10), end: timestampFromCivil(2026, 6, 10) },
  { start: timestampFromCivil(2026, 9, 1), end: timestampFromCivil(2026, 9, 20) },
];
const pauseCases = [
  { a: timestampFromCivil(2026, 4, 1), b: timestampFromCivil(2026, 7, 10), now: timestampFromCivil(2026, 7, 10) },
  { a: timestampFromCivil(2026, 4, 1), b: timestampFromCivil(2026, 5, 1), now: timestampFromCivil(2026, 5, 1) },
  { a: timestampFromCivil(2026, 7, 1), b: timestampFromCivil(2026, 10, 1), now: timestampFromCivil(2026, 10, 1) },
  { a: timestampFromCivil(2026, 4, 1), b: timestampFromCivil(2026, 5, 15), now: timestampFromCivil(2026, 5, 15) },
].map((c) => ({
  a: dec(c.a),
  b: dec(c.b),
  now: dec(c.now),
  pausedWithin: dec(pausedWithin(pauseList, c.a, c.b, c.now)),
  unpaused: dec(unpaused(pauseList, c.a, c.b, c.now)),
}));

// ---- year_gross ring ---------------------------------------------------------------------------
let ring = newYearGross();
ring = yearGrossAdd(ring, 0, 10n * WAD);
ring = yearGrossAdd(ring, 1, 20n * WAD);
ring = yearGrossAdd(ring, 2, 30n * WAD);
ring = yearGrossAdd(ring, 3, 40n * WAD);
ring = yearGrossAdd(ring, 4, 50n * WAD); // evicts year 0
const yearGrossCase = {
  adds: [
    { year: 0, incWad: dec(10n * WAD) },
    { year: 1, incWad: dec(20n * WAD) },
    { year: 2, incWad: dec(30n * WAD) },
    { year: 3, incWad: dec(40n * WAD) },
    { year: 4, incWad: dec(50n * WAD) },
  ],
  slots: ring.map((s) => ({ year: s.year, grossWad: dec(s.grossWad) })),
  reads: [0, 1, 2, 3, 4, 5].map((y) => ({ year: y, grossWad: dec(yearGrossGet(ring, y)) })),
  settlementYearExamples: [
    { ts: dec(timestampFromCivil(2027, 1, 13)), settlementTs: dec(timestampFromCivil(2026, 1, 14, 1)), year: settlementYear(timestampFromCivil(2027, 1, 13), timestampFromCivil(2026, 1, 14, 1)) },
    { ts: dec(timestampFromCivil(2027, 1, 14, 1)), settlementTs: dec(timestampFromCivil(2026, 1, 14, 1)), year: settlementYear(timestampFromCivil(2027, 1, 14, 1), timestampFromCivil(2026, 1, 14, 1)) },
  ],
};

// ---- fx ----------------------------------------------------------------------------------------
const EURUSD_FEED = "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b";
const fxCases = {
  pairIds: [
    { feedId: EURUSD_FEED, inverted: false, pairId: hex(fxPairId(EURUSD_FEED, false)) },
    { feedId: EURUSD_FEED, inverted: true, pairId: hex(fxPairId(EURUSD_FEED, true)) },
  ],
  normalize: [
    { price: "108345678", expo: -8, rateWad: dec(normalizePythPrice(108_345_678n, -8)) },
    { price: "108345", expo: -5, rateWad: dec(normalizePythPrice(108_345n, -5)) },
    { price: "5", expo: 0, rateWad: dec(normalizePythPrice(5n, 0)) },
    { price: "7", expo: 2, rateWad: dec(normalizePythPrice(7n, 2)) },
    { price: "123456789012345678901", expo: -18, rateWad: dec(normalizePythPrice(123_456_789_012_345_678_901n, -18)) },
  ],
  invert: [
    { rateWad: dec(150n * WAD), inverted: dec(invertRate(150n * WAD)) },
    { rateWad: dec(2n * WAD), inverted: dec(invertRate(2n * WAD)) },
  ],
};
const routerBindings = [0n, 90_000_000_000n, 180_000_000_000n].map((ytd) => ({ ytdAtEnd: dec(ytd), commitment: dec(routerIncomeCommitment(ytd)), commitmentHex: hex(fieldToBytes32(routerIncomeCommitment(ytd))) }));

// ---- fixed point ------------------------------------------------------------------------------
const fixedPoint = [
  { op: "mulDiv", a: "1000000", b: "100", c: "10000", result: dec(mulDiv(1_000_000n, 100n, 10_000n)) },
  { op: "mulDiv", a: "999999", b: "500", c: "10000", result: dec(mulDiv(999_999n, 500n, 10_000n)) },
  { op: "mulDivCeil", a: "999999", b: "500", c: "10000", result: dec(mulDivCeil(999_999n, 500n, 10_000n)) },
  { op: "mulDiv", a: "2500000000000000000", b: "1000000", c: dec(WAD), result: dec(mulDiv((25n * WAD) / 10n, 1_000_000n, WAD)) },
  { op: "mulDiv", a: "7", b: dec(WAD), c: "3", result: dec(mulDiv(7n, WAD, 3n)) },
];

const out = {
  schema: 2,
  specVersion: "1.1",
  description:
    "Known answers for the Merces SDK encodings (SPEC v1.1 §1, §6.3, §6.4, §6.6). Generated by packages/sdk/scripts/known-answers.ts; all integers are decimal strings, all byte strings are 0x-hex. Test keys are derived from public seeds and must never hold value.",
  constants: {
    WAD: dec(WAD),
    DAY: "86400",
    YEAR: "31536000",
    MONTH_SECONDS: "2629800",
    EIGHTEEN_MONTHS_SECONDS: "47336400",
    BN254_FR: "21888242871839275222246405745257275088548364400416034343698204186575808495617",
    ZERO_INCOME_COMMITMENT: dec(ZERO_INCOME_COMMITMENT),
    ZERO_INCOME_COMMITMENT_HEX: hex(fieldToBytes32(ZERO_INCOME_COMMITMENT)),
    MAGIC,
    MAGIC_HEX: Object.fromEntries(Object.entries(MAGIC).map(([k, v]) => [k, hex(utf8(v))])),
  },
  parameters: {
    defaults: parametersToStrings(DEFAULT_PARAMETERS),
    bounds: Object.fromEntries(PARAMETER_NAMES.map((n) => [snakeCase(n), { min: dec(PARAMETER_BOUNDS[n].min), max: dec(PARAMETER_BOUNDS[n].max) }])),
  },
  keccak256: keccakCases,
  poseidon2: poseidon2Cases,
  poseidon5: poseidon5Cases,
  termsCommitments: termsCases,
  incomeCommitments: incomeCases,
  wallets: [
    { kind: "solana", input: "11111111111111111111111111111111", wallet: hex(walletFromSolanaPubkey("11111111111111111111111111111111")) },
    { kind: "solana", input: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", wallet: hex(walletFromSolanaPubkey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) },
    { kind: "evm", input: EVM_REGISTRY, wallet: hex(walletFromEvmAddress(EVM_REGISTRY)) },
    { kind: "evm", input: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf", wallet: hex(walletFromEvmAddress("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf")) },
  ],
  domains: domains.map((d) => ({ name: d.name, chainKind: d.chainKind, chainId: dec(d.chainId), registry: hex(d.registry), registryNote: d.registryNote, preimage: hex(new Uint8Array([d.chainKind, ...hexToBytes(bytesToHex(bytes32(d.chainId))).slice(24), ...d.registry])), domain: hex(d.domain) })),
  seriesKeys: { evm: { seriesId: "1", key: hex(evmSeriesKey) }, solana: { note: "the series PDA address, used as-is", base58: base58Encode(SOLANA_SERIES_PDA), key: hex(solSeriesKey) } },
  bidCommitments: bidCases,
  testKeys: keys.map((k) => ({ seed: k.seed, derivation: 'keccak256("MERCES_TEST_KEY" ‖ seed) mod (n−1) + 1', privateKey: hex(k.privateKey), publicKey: hex(k.publicKey), address: hex(k.address), addressChecksum: toChecksumAddress(k.address) })),
  messages,
  periods,
  pauses: { pauseList: pauseList.map((p) => ({ start: dec(p.start), end: dec(p.end) })), cases: pauseCases },
  yearGross: yearGrossCase,
  fx: fxCases,
  routerIncomeCommitments: routerBindings,
  fixedPoint,
  periodIdExamples: [
    { year: 2026, quarter: 1, periodId: periodId(2026, 1) },
    { year: 2026, quarter: 4, periodId: periodId(2026, 4) },
    { year: 2029, quarter: 3, periodId: periodId(2029, 3) },
  ],
};

const json = JSON.stringify(out, null, 2) + "\n";
for (const p of [OUT_SDK, OUT_VECTORS]) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, json);
  console.log(`wrote ${p}`);
}
