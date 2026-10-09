//! SPEC §11 parity-vector runner: replays `packages/vectors/*.json` against the compiled programs
//! on LiteSVM and matches every `expect` to the base unit.

use std::collections::HashMap;

use anchor_lang::prelude::Pubkey;
use merces_common::encoding::{
    amend_message, extinguish_message, fx_message, pause_message, report_message, trueup_message,
};
use merces_common::fx::{quarter_average, Checkpoint};
use merces_common::status::{derive_status, Pause, SeriesStatus, StatusInputs};
use merces_common::time::{period_end, period_of, period_start, DAY};
use merces_common::WAD as WAD_U128;
use merces_hook::HookError;
use merces_protocol::error::ProtocolError as P;
use merces_protocol::income::SubmitReportArgs;
use merces_protocol::state as pstate;
use merces_registry::error::RegistryError as R;
use merces_registry::state::{TrancheData, RAISE_SETTLED};
use merces_registry::CreateSeriesArgs;
use serde_json::Value;
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::harness::*;
use crate::sig::{keccak, EthSigner};
use crate::zkfix::{hex32, hex_bytes, vector_path};

/// Anchor framework error: the account is not initialised.
const ACCOUNT_NOT_INITIALIZED: u32 = 3012;

type StepResult = Result<(), String>;

fn dec_u64(v: &Value) -> u64 {
    v.as_str()
        .unwrap_or_else(|| panic!("decimal string expected, got {v}"))
        .parse()
        .expect("u64")
}
fn dec_u32(v: &Value) -> u32 {
    u32::try_from(dec_u64(v)).unwrap()
}
fn dec_i64(v: &Value) -> i64 {
    v.as_str().unwrap().parse().expect("i64")
}
fn num_u64(v: &Value) -> u64 {
    match v {
        Value::Number(n) => n.as_u64().unwrap(),
        Value::String(s) => s.parse().unwrap(),
        _ => panic!("number expected, got {v}"),
    }
}
fn hex20(s: &str) -> [u8; 20] {
    let b = hex_bytes(s);
    let mut out = [0u8; 20];
    out.copy_from_slice(&b);
    out
}
/// A decimal field element as 32 big-endian bytes.
fn dec_be32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for ch in s.bytes() {
        let digit = u32::from(ch - b'0');
        let mut carry = digit;
        for byte in out.iter_mut().rev() {
            let v = u32::from(*byte) * 10 + carry;
            *byte = (v & 0xff) as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "field element exceeds 32 bytes");
    }
    out
}
fn opt_u32(v: Option<u32>) -> String {
    v.map(|x| x.to_string())
        .unwrap_or_else(|| "null".to_string())
}
fn status_name(s: SeriesStatus) -> &'static str {
    match s {
        SeriesStatus::OnTime => "OnTime",
        SeriesStatus::InGrace => "InGrace",
        SeriesStatus::Late => "Late",
        SeriesStatus::Paused => "Paused",
        SeriesStatus::Retired => "Retired",
        SeriesStatus::Redeemed => "Redeemed",
        SeriesStatus::Extinguished => "Extinguished",
    }
}
fn expected_str(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        other => other.to_string(),
    }
}

/// A call carrying a decimal argument that does not fit the instruction's integer type
/// (`u64`, or `i64` for `adjustment`) can not be encoded on Solana (SPEC §1.1).
fn out_of_range(call: &Value) -> bool {
    fn scan(v: &Value, key: &str) -> bool {
        match v {
            Value::String(s)
                if !s.is_empty()
                    && s.trim_start_matches('-')
                        .bytes()
                        .all(|b| b.is_ascii_digit()) =>
            {
                if key == "adjustment" {
                    s.parse::<i64>().is_err()
                } else if key == "salt"
                    || key.ends_with("Commitment")
                    || key.ends_with("Id")
                    || key.ends_with("Hash")
                {
                    false
                } else {
                    s.parse::<u64>().is_err()
                }
            }
            Value::Object(m) => m
                .iter()
                .filter(|(k, _)| {
                    !matches!(
                        k.as_str(),
                        "proof" | "publicSignals" | "proofEvm" | "proofSolana" | "witness"
                    )
                })
                .any(|(k, x)| scan(x, k)),
            Value::Array(a) => a.iter().any(|x| scan(x, key)),
            _ => false,
        }
    }
    scan(call, "")
}

/// Acceptable custom error codes for a canonical vector error name; empty = any failure.
pub fn codes_for(name: &str) -> Vec<u32> {
    let p = |e: P| u32::from(e);
    let r = |e: R| u32::from(e);
    match name {
        "AlreadyDelivered" => vec![p(P::BidAlreadyDelivered)],
        "AlreadyPaused" => vec![p(P::AlreadyPaused)],
        "AlreadyProcessed" => vec![p(P::BidAlreadyProcessed)],
        "AlreadyRevealed" => vec![p(P::AlreadyRevealed)],
        "AmendmentAfterTerminal" => vec![r(R::SeriesTerminal)],
        "BidNotFound" => vec![ACCOUNT_NOT_INITIALIZED],
        "BidsExist" => vec![p(P::RaiseHasBids)],
        "CommitPhaseClosed" => vec![p(P::CommitPhaseOver)],
        "CommitmentMismatch" => vec![p(P::CommitmentMismatch)],
        "ConfidenceTooWide" => vec![p(P::ConfidenceTooWide)],
        "DirectTransferForbidden" => vec![u32::from(HookError::DirectTransferForbidden)],
        "UnarmedEscrowDeposit" => vec![u32::from(HookError::UnarmedEscrowDeposit)],
        "FxFallbackNotAllowed" => vec![p(P::FxFallbackNotNeeded)],
        "FxFallbackRequired" => vec![p(P::FxNeedsFallback)],
        "FxMismatch" => vec![p(P::FxAverageMismatch), p(P::FxMustBeOne)],
        "FxPairExists" => vec![r(R::FxPairImmutable)],
        "HolderNotRegistered" => vec![p(P::HolderNotRegistered), ACCOUNT_NOT_INITIALIZED],
        "InsufficientUnits" => vec![p(P::AskExceedsBalance)],
        "InvalidAttestorSignature" => vec![
            p(P::SignerMismatch),
            p(P::AttestorInactive),
            p(P::MalformedSignature),
            p(P::SignatureRecoveryFailed),
            p(P::KeyAccountMismatch),
            r(R::AttestorMismatch),
            r(R::AttestorInactive),
            r(R::MalformedSignature),
            r(R::SignatureRecoveryFailed),
            ACCOUNT_NOT_INITIALIZED,
        ],
        "InvalidVerifierSignature" => vec![
            p(P::SignerMismatch),
            p(P::VerifierKeyInactive),
            p(P::MalformedSignature),
            p(P::SignatureRecoveryFailed),
            p(P::KeyAccountMismatch),
            ACCOUNT_NOT_INITIALIZED,
        ],
        "InvalidPauseEnd" => vec![p(P::PauseEndInPast)],
        "InvalidProof" => vec![
            p(P::InvalidProof),
            p(P::PriorCommitmentMismatch),
            p(P::MalformedProof),
            p(P::PublicInputNotCanonical),
        ],
        "IssuanceStopped" => vec![r(R::IssuanceStopped)],
        "LockupActive" => vec![p(P::LockupActive)],
        "MintNotFinalized" => vec![p(P::MintNotFinalized)],
        "NoTailDue" => vec![p(P::NoTailDue)],
        "NotAllowlisted" => vec![
            p(P::NotAllowlisted),
            r(R::NotAllowlisted),
            ACCOUNT_NOT_INITIALIZED,
        ],
        "NotIssuer" => vec![p(P::NotIssuer), r(R::Unauthorized)],
        "NotPaused" => vec![p(P::NotPaused)],
        "NotSettling" => vec![p(P::NotSettling)],
        "NothingDue" => vec![p(P::NothingDue), p(P::NoTrueUpDue), p(P::NotCapped)],
        "NothingVested" => vec![p(P::NothingVested)],
        "PauseNotRequested" => vec![p(P::PauseNotRequested)],
        "PauseTooLong" => vec![p(P::PauseTooLong), p(P::PauseCumulativeExceeded)],
        "TooManyPauses" => vec![p(P::TooManyPauses)],
        "PaymentOutstanding" => vec![p(P::DueOutstanding)],
        "RaiseNotDraft" => vec![p(P::NotDraft), r(R::NotDraft), p(P::RaiseNotOpen)],
        "RaiseNotOpen" => vec![p(P::RaiseNotOpen), ACCOUNT_NOT_INITIALIZED],
        "RaiseNotSettled" => vec![p(P::NotSettledOrFailed), p(P::MintNotFinalized)],
        "ReportTooEarly" => vec![p(P::PeriodNotEnded)],
        "RevealNotStarted" | "RevealPhaseClosed" => vec![p(P::NotRevealPhase)],
        "RouterPeriodNotClosed" => vec![p(P::RouterPeriodNotClosed)],
        "SameAttestor" => vec![p(P::AttestorsNotDistinct)],
        "SeriesLate" => vec![p(P::SeriesLate)],
        "SettlementNotReady" => vec![p(P::RevealPhaseNotOver), p(P::WindowRevealNotOver)],
        "SnapshotAlreadyTaken" => vec![p(P::SnapshotAlreadyTaken)],
        "StalePrice" => vec![p(P::PriceStale), p(P::FeedIdMismatch)],
        "TailEnded" => vec![p(P::TailEnded)],
        "TallyInProgress" => vec![p(P::TallyInProgress)],
        "TallyIncomplete" => vec![p(P::TallyIncomplete)],
        "TerminalStatus" => vec![
            p(P::TerminalStatus),
            p(P::RedemptionStatusNotAllowed),
            p(P::WindowStatusNotAllowed),
            p(P::SeriesExtinguished),
        ],
        "TierNotEnabled" => vec![
            p(P::TierNotEnabled),
            p(P::Tier1NotExclusive),
            p(P::Tier4Disabled),
        ],
        "UnfavourableAmendment" => vec![r(R::CapMultipleIncrease), r(R::BoundCapMultiple)],
        "UnreportedPeriods" => vec![p(P::UnreportedPeriods)],
        "WindowNotEligible" => vec![
            p(P::WindowStatusNotAllowed),
            p(P::LockupActive),
            p(P::ReportNotPaid),
            p(P::WindowWrongPeriod),
            p(P::MintNotFinalized),
        ],
        "WindowNotOpen" => vec![
            p(P::WindowNotSettled),
            p(P::WindowNotCommit),
            p(P::WindowNotReveal),
            p(P::WindowNotSettling),
            ACCOUNT_NOT_INITIALIZED,
        ],
        "WindowOpen" => vec![p(P::WindowAlreadyOpen)],
        "WindowsDisabled" => vec![p(P::WindowsDisabled)],
        "WrongPeriod" => vec![p(P::WrongPeriod)],
        "OutOfOrder" => vec![p(P::OutOfOrder)],
        "ZeroEscrow" => vec![p(P::ZeroEscrow)],
        "TrueUpOutstanding" => vec![p(P::TrueUpOutstanding), p(P::DueOutstanding)],
        "TrueUpYearInvalid" => vec![
            p(P::TrueUpYearNotEnded),
            p(P::TrueUpYearUsed),
            p(P::TrueUpYearIncomplete),
        ],
        "TrueUpAdjustmentTooLarge" => vec![p(P::TrueUpExceedsYear)],
        "NoRedeemedUnits" => vec![p(P::NoRedeemedUnits)],
        "NotRedeemed" => vec![p(P::NotRedeemed)],
        "NoUnitsOutstanding" => vec![p(P::NoUnitsOutstanding)],
        "ContractHashMissing" => vec![p(P::ContractHashNotSet), r(R::ContractHashNotSet)],
        "NewRaisesPaused" => vec![p(P::NewRaisesPaused), r(R::NewRaisesPaused)],
        // account-creation collisions and malformed inputs surface as non-custom runtime errors
        "BidExists" | "OrderExists" | "InvalidTerms" | "UnknownFxPair" | "RouterNotEnabled"
        | "AmountOutOfRange" => vec![],
        other => panic!("unknown canonical error name {other}"),
    }
}

/// Records the compute units a Merces program consumed in a successful transaction.
fn record_cu(cu: &mut HashMap<String, u64>, op: &str, meta: &litesvm::types::TransactionMetadata) {
    let ids = [
        merces_protocol::ID.to_string(),
        merces_registry::ID.to_string(),
        merces_hook::ID.to_string(),
    ];
    let mut max = 0u64;
    for line in &meta.logs {
        for id in &ids {
            if let Some(rest) = line.strip_prefix(&format!("Program {id} consumed ")) {
                if let Some(n) = rest.split(' ').next().and_then(|n| n.parse::<u64>().ok()) {
                    max = max.max(n);
                }
            }
        }
    }
    if max > 0 {
        let e = cu.entry(op.to_string()).or_insert(0);
        *e = (*e).max(max);
    }
}

fn ok(cu: &mut HashMap<String, u64>, op: &str, res: TxResult) -> StepResult {
    match res {
        Ok(meta) => {
            record_cu(cu, op, &meta);
            Ok(())
        }
        Err(e) => Err(format!("{:?}\n{}", e.err, e.meta.logs.join("\n"))),
    }
}

pub struct Runner {
    pub env: Env,
    actors: HashMap<String, Keypair>,
    series: HashMap<String, Pubkey>,
    keys: HashMap<String, EthSigner>,
    bids: HashMap<String, Vec<Pubkey>>,
    orders: HashMap<(String, u32), Vec<Pubkey>>,
    last_window: HashMap<String, u32>,
    vector: Value,
    pub name: String,
    /// Maximum compute units consumed by a Merces program per vector op (top-level invocations).
    pub cu: HashMap<String, u64>,
}

impl Runner {
    pub fn new(vector: Value) -> Self {
        let name = vector["name"].as_str().unwrap_or("vector").to_string();
        let mut keys = HashMap::new();
        if let Some(map) = vector["keys"].as_object() {
            for (k, v) in map {
                let sk = hex32(v["privateKey"].as_str().unwrap());
                let signer = EthSigner::from_private_key(&sk);
                assert_eq!(
                    signer.addr,
                    hex20(v["address"].as_str().unwrap()),
                    "key {k} address mismatch"
                );
                keys.insert(k.clone(), signer);
            }
        }
        Runner {
            env: Env::new(),
            actors: HashMap::new(),
            series: HashMap::new(),
            keys,
            bids: HashMap::new(),
            orders: HashMap::new(),
            last_window: HashMap::new(),
            vector,
            name,
            cu: HashMap::new(),
        }
    }

    fn actor(&mut self, name: &str) -> Keypair {
        if !self.actors.contains_key(name) {
            let k = self.env.new_wallet();
            self.actors.insert(name.to_string(), k);
        }
        self.actors[name].insecure_clone()
    }
    fn wallet(&mut self, name: &str) -> Pubkey {
        self.actor(name).pubkey()
    }
    fn series_key(&self, name: &str) -> Pubkey {
        *self
            .series
            .get(name)
            .unwrap_or_else(|| panic!("unknown series {name}"))
    }
    fn signer(&self, name: &str) -> EthSigner {
        self.keys
            .get(name)
            .unwrap_or_else(|| panic!("unknown key {name}"))
            .clone()
    }
    fn domain(&self) -> [u8; 32] {
        self.env.config().domain
    }
    fn window_period(&self, series_name: &str, c: &Value) -> u32 {
        if let Some(p) = c.get("period").filter(|p| !p.is_null()) {
            return dec_u32(p);
        }
        let key = self.series_key(series_name);
        if let Some(p) = self.env.ledger(&key).and_then(|l| l.active_window()) {
            return p;
        }
        if let Some(p) = self.last_window.get(series_name) {
            return *p;
        }
        period_of(self.env.now).unwrap() - 1
    }

    /// Replays the whole vector and returns the runner (state, compute-unit table).
    pub fn run(path: &str) -> Runner {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let vector: Value = serde_json::from_str(&text).expect("vector json");
        assert_eq!(
            vector["schema"].as_u64(),
            Some(2),
            "vector schema 2 expected"
        );
        let mut r = Runner::new(vector);
        let steps = r.vector["steps"].as_array().unwrap().clone();
        for (i, step) in steps.iter().enumerate() {
            if let Some(t) = step.get("t") {
                let t = dec_u64(t);
                if t > r.env.now {
                    r.env.warp(t);
                }
            }
            let op = step["op"].as_str().unwrap();
            let context = format!(
                "{} step {i} ({op}) t={}{}",
                r.name,
                r.env.now,
                step.get("note")
                    .and_then(|n| n.as_str())
                    .map(|n| format!(" — {n}"))
                    .unwrap_or_default()
            );
            match op {
                "expect" => r.check_expect(step, &context),
                "expect_revert" => {
                    let call = &step["call"];
                    let error = step["error"].as_str().unwrap();
                    if out_of_range(call) {
                        // Solana's u64/i64 instruction arguments cannot encode the value: the
                        // transaction cannot even be built (SPEC §1.1 entry-point range rule).
                        assert_eq!(
                            error, "AmountOutOfRange",
                            "{context}: value out of u64 range but {error} expected"
                        );
                        continue;
                    }
                    match r.exec(call) {
                        Ok(()) => panic!(
                            "{context}: expected revert {error}, call {} succeeded",
                            call["op"]
                        ),
                        Err(msg) => {
                            let codes = codes_for(error);
                            if !codes.is_empty()
                                && !codes.iter().any(|c| msg.contains(&format!("Custom({c})")))
                            {
                                panic!("{context}: expected {error} (codes {codes:?}) from {}, got:\n{msg}", call["op"]);
                            }
                        }
                    }
                }
                _ => {
                    if let Err(msg) = r.exec(step) {
                        panic!("{context}: failed:\n{msg}");
                    }
                }
            }
        }
        r
    }

    /// The wallet of a vector actor (None when the vector never used it).
    pub fn actor_pubkey(&self, name: &str) -> Option<Pubkey> {
        self.actors.get(name).map(|k| k.pubkey())
    }

    /// The keypair of a vector actor (panics when the vector never used it).
    pub fn actor_keypair(&self, name: &str) -> Keypair {
        self.actors
            .get(name)
            .unwrap_or_else(|| panic!("unknown actor {name}"))
            .insecure_clone()
    }

    /// The series key of a vector series name.
    pub fn series_pubkey(&self, name: &str) -> Option<Pubkey> {
        self.series.get(name).copied()
    }

    /// Actor names the vector introduced.
    pub fn actor_names(&self) -> Vec<String> {
        self.actors.keys().cloned().collect()
    }

    /// The parsed vector.
    pub fn vector(&self) -> &Value {
        &self.vector
    }

    fn exec(&mut self, c: &Value) -> StepResult {
        let op = c["op"].as_str().unwrap();
        let usdc = self.env.usdc;
        match op {
            "fund" => {
                let w = self.wallet(c["actor"].as_str().unwrap());
                self.env.fund(&w, &usdc, dec_u64(&c["amount"]));
                Ok(())
            }
            "allowlist" => {
                let allowed = c.get("allowed").and_then(|a| a.as_bool()).unwrap_or(true);
                let names: Vec<String> = c["wallets"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|w| w.as_str().unwrap().to_string())
                    .collect();
                for n in names {
                    let w = self.wallet(&n);
                    ok(&mut self.cu, op, self.env.allow(&w, allowed))?;
                }
                Ok(())
            }
            "register_issuer" => {
                let w = self.wallet(c["wallet"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.register_issuer(&w))
            }
            "deactivate_issuer" => {
                let w = self.wallet(c["wallet"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.deactivate_issuer(&w))
            }
            "register_attestor" => {
                let addr = self.signer(c["key"].as_str().unwrap()).addr;
                ok(&mut self.cu, op, self.env.register_attestor(addr))
            }
            "revoke_attestor" => {
                let addr = self.signer(c["key"].as_str().unwrap()).addr;
                ok(&mut self.cu, op, self.env.revoke_attestor(addr))
            }
            "register_verifier_key" => {
                let addr = self.signer(c["key"].as_str().unwrap()).addr;
                ok(&mut self.cu, op, self.env.register_verifier(addr))
            }
            "revoke_verifier_key" => {
                let addr = self.signer(c["key"].as_str().unwrap()).addr;
                ok(&mut self.cu, op, self.env.revoke_verifier(addr))
            }
            "set_flags" => {
                let cfg = self.env.config();
                let f = |k: &str, cur: bool| c.get(k).and_then(|v| v.as_bool()).unwrap_or(cur);
                ok(
                    &mut self.cu,
                    op,
                    self.env.set_flags(
                        f("newRaisesPaused", cfg.new_raises_paused),
                        f("windowsEnabled", cfg.windows_enabled),
                        f("tier4Enabled", cfg.tier4_enabled),
                    ),
                )
            }
            "set_fx_pair" => {
                let feed = hex32(c["feedId"].as_str().unwrap());
                let inverted = c["inverted"].as_bool().unwrap_or(false);
                let pair = fx_pair_id(&feed, inverted);
                ok(
                    &mut self.cu,
                    op,
                    self.env.set_fx_pair(pair, feed, inverted, true),
                )?;
                if self.env.fx_pair(&pair).is_none() {
                    ok(&mut self.cu, op, self.env.init_fx_pair(pair))?;
                }
                Ok(())
            }
            "create_series" => self.create_series(c),
            "set_contract_hash" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(
                    &mut self.cu,
                    op,
                    self.env.set_contract_hash(
                        &issuer,
                        &series,
                        hex32(c["contractHash"].as_str().unwrap()),
                    ),
                )
            }
            "stop_issuance" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.stop_issuance(&issuer))
            }
            "resume_issuance" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.resume_issuance(&issuer))
            }
            "open_raise" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.open_raise(&issuer, &series))
            }
            "cancel_raise" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.cancel_raise(&issuer, &series))
            }
            "commit_bid" => {
                let sname = c["series"].as_str().unwrap().to_string();
                let bidder = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(&sname);
                let commit = commitment(
                    dec_u64(&c["price"]),
                    dec_u64(&c["quantity"]),
                    &hex32(c["salt"].as_str().unwrap()),
                    &bidder.pubkey(),
                );
                ok(
                    &mut self.cu,
                    op,
                    self.env
                        .commit_bid(&series, &bidder, commit, dec_u64(&c["escrow"])),
                )?;
                let list = self.bids.entry(sname).or_default();
                if !list.contains(&bidder.pubkey()) {
                    list.push(bidder.pubkey());
                }
                Ok(())
            }
            "reveal_bid" => {
                let bidder = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(
                    &mut self.cu,
                    op,
                    self.env.reveal_bid(
                        &series,
                        &bidder,
                        dec_u64(&c["price"]),
                        dec_u64(&c["quantity"]),
                        hex32(c["salt"].as_str().unwrap()),
                    ),
                )
            }
            "begin_settlement" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(
                    &mut self.cu,
                    op,
                    self.env.begin_settlement(
                        &series,
                        dec_u64(&c["clearingPrice"]),
                        dec_u64(&c["qAboveClaim"]),
                        dec_u64(&c["qAtClaim"]),
                    ),
                )
            }
            "finalize_settlement" => {
                let sname = c["series"].as_str().unwrap();
                let series = self.series_key(sname);
                let bidders = self.bids.get(sname).cloned().unwrap_or_default();
                ok(
                    &mut self.cu,
                    op,
                    self.env.tally_and_finalize(&series, &bidders),
                )
            }
            "process_bid" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                let bidder = self.wallet(c["bidder"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.process_bid(&series, &bidder))
            }
            "deliver_bid" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                let bidder = self.wallet(c["bidder"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.deliver_bid(&series, &bidder))
            }
            "claim_release" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.claim_release(&issuer, &series))
            }
            "set_release_pause" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(
                    &mut self.cu,
                    op,
                    self.env.set_release_pause(
                        &issuer,
                        &series,
                        c["paused"].as_bool().unwrap_or(true),
                    ),
                )
            }
            "submit_report" => self.submit_report(c),
            "pay" => {
                let payer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.pay(&payer, &series))
            }
            "pay_trueup" => {
                let payer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.pay_trueup(&payer, &series))
            }
            "submit_trueup" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                let year = u16::try_from(num_u64(&c["year"])).unwrap();
                let adjustment = dec_i64(&c["adjustment"]);
                let ts = dec_u64(&c["attestationTs"]);
                let signer = self.signer(c["attestor"].as_str().unwrap());
                let nonce = match c.get("nonce").filter(|n| !n.is_null()) {
                    Some(n) => dec_u64(n),
                    None => self
                        .env
                        .ledger(&series)
                        .map(|l| l.trueup_nonce)
                        .unwrap_or(0),
                };
                let msg = keccak(&[trueup_message(
                    &self.domain(),
                    &series.to_bytes(),
                    nonce,
                    year,
                    adjustment,
                    ts,
                )
                .as_bytes()]);
                let sig = signer.sign(&msg);
                ok(
                    &mut self.cu,
                    op,
                    self.env.submit_trueup(
                        &issuer,
                        &series,
                        year,
                        adjustment,
                        ts,
                        signer.addr,
                        sig,
                    ),
                )
            }
            "claim" | "register_holder" | "burn_retired" | "claim_redemption" | "claim_tail"
            | "claim_final" => {
                let who = c
                    .get("holder")
                    .or_else(|| c.get("actor"))
                    .and_then(|v| v.as_str())
                    .unwrap();
                let holder = self.wallet(who);
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(
                    &mut self.cu,
                    op,
                    match op {
                        "claim" => self.env.claim(&series, &holder),
                        "register_holder" => self.env.register_holder(&series, &holder),
                        "burn_retired" => self.env.burn_retired(&series, &holder),
                        "claim_redemption" => self.env.claim_redemption(&series, &holder),
                        "claim_tail" => self.env.claim_tail(&series, &holder),
                        _ => self.env.claim_final(&series, &holder),
                    },
                )
            }
            "retire_if_capped" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.retire_if_capped(&series))
            }
            "crank_status" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.crank_status(&series))
            }
            "request_pause" | "withdraw_pause_request" | "end_pause" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(
                    &mut self.cu,
                    op,
                    match op {
                        "request_pause" => self.env.request_pause(&issuer, &series),
                        "withdraw_pause_request" => {
                            self.env.withdraw_pause_request(&issuer, &series)
                        }
                        _ => self.env.end_pause(&issuer, &series),
                    },
                )
            }
            "approve_pause" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                let pause_end = dec_u64(&c["pauseEnd"]);
                let signer = self.signer(c["attestor"].as_str().unwrap());
                let nonce = self.env.ledger(&series).map(|l| l.pause_nonce).unwrap_or(0);
                let msg =
                    keccak(&[
                        pause_message(&self.domain(), &series.to_bytes(), nonce, pause_end)
                            .as_bytes(),
                    ]);
                let sig = signer.sign(&msg);
                ok(
                    &mut self.cu,
                    op,
                    self.env.approve_pause(&series, pause_end, signer.addr, sig),
                )
            }
            "route_income" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                let payer = self.actor(c["payer"].as_str().unwrap());
                let amount = dec_u64(&c["amount"]);
                let p = pdas(series);
                let ix =
                    self.env
                        .transfer_stable_ix(&payer.pubkey(), &usdc, &p.router_token, amount);
                ok(&mut self.cu, op, self.env.send(&[ix], &[&payer]))?;
                // before mint finalisation the receipt is held in the router account
                match self.env.route(&series) {
                    Ok(_) => Ok(()),
                    Err(e)
                        if format!("{:?}", e.err)
                            .contains(&format!("Custom({})", u32::from(P::MintNotFinalized))) =>
                    {
                        Ok(())
                    }
                    Err(e) => ok(&mut self.cu, op, Err(e)),
                }
            }
            "close_router_period" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(
                    &mut self.cu,
                    op,
                    self.env.close_router_period(&series, dec_u32(&c["period"])),
                )
            }
            "fx_snapshot" => {
                let pair = hex32(c["pairId"].as_str().unwrap());
                let feed = self
                    .env
                    .fx_config(&pair)
                    .map(|f| f.feed_id)
                    .unwrap_or([0u8; 32]);
                let expo = i32::try_from(c["expo"].as_i64().unwrap()).unwrap();
                ok(
                    &mut self.cu,
                    op,
                    self.env.snapshot_fx(
                        pair,
                        feed,
                        dec_i64(&c["price"]),
                        dec_u64(&c["conf"]),
                        expo,
                        dec_i64(&c["publishTime"]),
                    ),
                )
            }
            "redeem" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                ok(&mut self.cu, op, self.env.redeem(&issuer, &series))
            }
            "extinguish" => {
                let series = self.series_key(c["series"].as_str().unwrap());
                let names: Vec<String> = c["attestors"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|a| a.as_str().unwrap().to_string())
                    .collect();
                let a = self.signer(&names[0]);
                let b = self.signer(&names[1]);
                let nonce = self
                    .env
                    .ledger(&series)
                    .map(|l| l.extinguish_nonce)
                    .unwrap_or(0);
                let msg = keccak(&[
                    extinguish_message(&self.domain(), &series.to_bytes(), nonce).as_bytes(),
                ]);
                ok(
                    &mut self.cu,
                    op,
                    self.env
                        .extinguish(&series, (a.addr, a.sign(&msg)), (b.addr, b.sign(&msg))),
                )
            }
            "amend_terms" => {
                let issuer = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                let new_tc = hex32(c["newTermsCommitment"].as_str().unwrap());
                let new_cap = dec_u64(&c["newCapMultipleWad"]);
                let signer = self.signer(c["attestor"].as_str().unwrap());
                let nonce = self.env.series(&series).amendment_nonce;
                let msg = keccak(&[amend_message(
                    &self.domain(),
                    &series.to_bytes(),
                    nonce,
                    &new_tc,
                    new_cap,
                )
                .as_bytes()]);
                let sig = signer.sign(&msg);
                ok(
                    &mut self.cu,
                    op,
                    self.env
                        .amend_terms(&issuer, &series, new_tc, new_cap, signer.addr, sig),
                )
            }
            "open_window" => {
                let sname = c["series"].as_str().unwrap().to_string();
                let series = self.series_key(&sname);
                let period = c
                    .get("period")
                    .map(dec_u32)
                    .unwrap_or_else(|| period_of(self.env.now).unwrap() - 1);
                ok(&mut self.cu, op, self.env.open_window(&series, period))?;
                self.last_window.insert(sname, period);
                Ok(())
            }
            "commit_ask" | "window_commit_bid" => {
                let sname = c["series"].as_str().unwrap().to_string();
                let owner = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(&sname);
                let period = self.window_period(&sname, c);
                let commit = commitment(
                    dec_u64(&c["price"]),
                    dec_u64(&c["quantity"]),
                    &hex32(c["salt"].as_str().unwrap()),
                    &owner.pubkey(),
                );
                let res = if op == "commit_ask" {
                    self.env
                        .commit_ask(&series, period, &owner, commit, dec_u64(&c["units"]))
                } else {
                    self.env.window_commit_bid(
                        &series,
                        period,
                        &owner,
                        commit,
                        dec_u64(&c["escrow"]),
                    )
                };
                ok(&mut self.cu, op, res)?;
                let list = self.orders.entry((sname, period)).or_default();
                if !list.contains(&owner.pubkey()) {
                    list.push(owner.pubkey());
                }
                Ok(())
            }
            "reveal_order" => {
                let sname = c["series"].as_str().unwrap().to_string();
                let owner = self.actor(c["actor"].as_str().unwrap());
                let series = self.series_key(&sname);
                let period = self.window_period(&sname, c);
                ok(
                    &mut self.cu,
                    op,
                    self.env.reveal_order(
                        &series,
                        period,
                        &owner,
                        dec_u64(&c["price"]),
                        dec_u64(&c["quantity"]),
                        hex32(c["salt"].as_str().unwrap()),
                    ),
                )
            }
            "begin_window_settlement" => {
                let sname = c["series"].as_str().unwrap().to_string();
                let series = self.series_key(&sname);
                let period = self.window_period(&sname, c);
                let (price, no_match) = match c["clearingPrice"].as_str() {
                    Some("NO_MATCH") => (0, true),
                    Some(s) => (s.parse().unwrap(), false),
                    None => (0, true),
                };
                ok(
                    &mut self.cu,
                    op,
                    self.env
                        .begin_window_settlement(&series, period, price, no_match),
                )
            }
            "finalize_window" => {
                let sname = c["series"].as_str().unwrap().to_string();
                let series = self.series_key(&sname);
                let period = self.window_period(&sname, c);
                let owners = self
                    .orders
                    .get(&(sname, period))
                    .cloned()
                    .unwrap_or_default();
                for page in owners.chunks(pstate::TALLY_PAGE) {
                    ok(
                        &mut self.cu,
                        op,
                        self.env.tally_orders(&series, period, page),
                    )?;
                }
                ok(&mut self.cu, op, self.env.finalize_window(&series, period))
            }
            "process_orders" => {
                let sname = c["series"].as_str().unwrap().to_string();
                let series = self.series_key(&sname);
                let period = self.window_period(&sname, c);
                let owners = self
                    .orders
                    .get(&(sname, period))
                    .cloned()
                    .unwrap_or_default();
                if owners.is_empty() {
                    // nothing to process: the window must at least exist and be settled
                    return Err(format!(
                        "no orders for window {period}; Custom({})",
                        u32::from(P::WindowNotSettled)
                    ));
                }
                // revealed bids by reveal index, unrevealed bids, then asks likewise
                let mut entries: Vec<(u8, bool, u32, Pubkey)> = owners
                    .iter()
                    .map(|o| {
                        let ord = self.env.order(&series, period, o).expect("order");
                        (ord.side, !ord.revealed, ord.reveal_index, *o)
                    })
                    .collect();
                entries.sort_by_key(|e| (e.0, e.1, e.2));
                for (_, _, _, owner) in entries {
                    ok(
                        &mut self.cu,
                        op,
                        self.env.process_order(&series, period, &owner),
                    )?;
                }
                Ok(())
            }
            "transfer_units" => {
                let from = self.actor(c["actor"].as_str().unwrap());
                let to = self.wallet(c["to"].as_str().unwrap());
                let series = self.series_key(c["series"].as_str().unwrap());
                let p = pdas(series);
                let create = self.env.create_ata_ix(&to, &p.unit_mint);
                let ix = self.env.direct_unit_transfer_ix(
                    &series,
                    &from.pubkey(),
                    &to,
                    dec_u64(&c["units"]),
                );
                ok(&mut self.cu, op, self.env.send(&[create, ix], &[&from]))
            }
            other => panic!("unsupported op {other}"),
        }
    }

    fn create_series(&mut self, c: &Value) -> StepResult {
        let op = "create_series";
        let sname = c["series"].as_str().unwrap().to_string();
        let issuer = self.actor(c["actor"].as_str().unwrap());
        let t = &c["terms"];
        let cfg = self.env.config();
        let d = cfg.defaults;
        for (k, v) in [
            ("auctionFeeBps", u64::from(d.auction_fee_bps)),
            ("payoutFeeBps", u64::from(d.payout_fee_bps)),
            ("windowFeeBps", u64::from(d.window_fee_bps)),
            ("nonRevealChargeBps", u64::from(d.non_reveal_charge_bps)),
        ] {
            if let Some(x) = t.get(k) {
                assert_eq!(
                    dec_u64(x),
                    v,
                    "{}: series fees must equal the protocol defaults ({k})",
                    self.name
                );
            }
        }
        let schedule: Vec<TrancheData> = c["releaseSchedule"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tr| TrancheData {
                at_offset_seconds: dec_u64(&tr["atOffsetSeconds"]),
                bps: u16::try_from(dec_u64(&tr["bps"])).unwrap(),
            })
            .collect();
        let tier_flags = u8::try_from(num_u64(&c["tierFlags"])).unwrap();
        let fx_pair_id = c
            .get("fxPairId")
            .and_then(|v| v.as_str())
            .map(hex32)
            .unwrap_or([0u8; 32]);
        let tier1_terms = c.get("router").filter(|r| !r.is_null()).map(|r| {
            // the plaintext behind the commitment; a series the vector only uses in a revert may
            // have none (the call fails before the terms are checked)
            let plain = &self.vector["seriesPrivate"][&sname]["termsPlain"];
            let num = |k: &str, default: u64| {
                plain
                    .get(k)
                    .filter(|v| !v.is_null())
                    .map(num_u64)
                    .unwrap_or(default)
            };
            let salt = plain
                .get("termsSalt")
                .and_then(|v| v.as_str())
                .map(dec_be32)
                .unwrap_or([0u8; 32]);
            Env::tier1_terms(
                dec_u64(&r["theta"]),
                dec_u64(&r["rWad"]),
                u32::try_from(num("currencyCode", 840)).unwrap(),
                u32::try_from(num("indexingRule", 0)).unwrap(),
                salt,
            )
        });
        let args = CreateSeriesArgs {
            units_offered: dec_u64(&t["unitsOffered"]),
            reserve_price: dec_u64(&t["reservePrice"]),
            min_raise: dec_u64(&t["minRaise"]),
            cap_multiple_wad: dec_u64(&t["capMultipleWad"]),
            hurdle_rate_wad: dec_u64(&t["hurdleRateWad"]),
            payout_multiple_k: u16::try_from(dec_u64(&t["payoutMultipleK"])).unwrap(),
            lockup_seconds: dec_u64(&t["lockupSeconds"]),
            wallet_cap_bps: u16::try_from(dec_u64(&t["walletCapBps"])).unwrap(),
            commit_duration: dec_u64(&t["commitDuration"]),
            reveal_duration: dec_u64(&t["revealDuration"]),
            window_commit_duration: dec_u64(&t["windowCommitDuration"]),
            window_reveal_duration: dec_u64(&t["windowRevealDuration"]),
            release_schedule: schedule,
            terms_commitment: hex32(c["termsCommitment"].as_str().unwrap()),
            tier_flags,
            fx_pair_id,
            mode: 0,
            issuer_accepts_public_price: false,
            metadata_uri: format!("https://merces.example/{}/{sname}.json", self.name),
            tier1_terms,
        };
        let fx_pair = (fx_pair_id != [0u8; 32]).then(|| fx_config_pda(&fx_pair_id));
        let usdc = self.env.usdc;
        let (res, key) = self.env.create_series_tx(&issuer, &usdc, fx_pair, args);
        ok(&mut self.cu, op, res)?;
        self.series.insert(sname, key);
        if let Some(hash) = c.get("contractHash").and_then(|h| h.as_str()) {
            ok(
                &mut self.cu,
                op,
                self.env.set_contract_hash(&issuer, &key, hex32(hash)),
            )?;
        }
        Ok(())
    }

    fn submit_report(&mut self, c: &Value) -> StepResult {
        let op = "submit_report";
        let issuer = self.actor(c["actor"].as_str().unwrap());
        let series = self.series_key(c["series"].as_str().unwrap());
        let period = dec_u32(&c["period"]);
        let tier = u8::try_from(num_u64(&c["tier"])).unwrap();
        let liquidity_event = c["liquidityEvent"].as_bool().unwrap_or(false);
        let prior = hex32(c["priorIncomeCommitment"].as_str().unwrap());
        let income = hex32(c["incomeCommitment"].as_str().unwrap());
        let fx_avg_wad = dec_u64(&c["fxAvgWad"]);
        let domain = self.domain();
        let series_bytes = series.to_bytes();
        // FX fallback
        let (fx_sig, fx_addr, fx_key) = match c.get("fxFallback").filter(|f| !f.is_null()) {
            Some(f) => {
                let signer = self.signer(f["attestor"].as_str().unwrap());
                let msg =
                    keccak(&[fx_message(&domain, &series_bytes, period, fx_avg_wad).as_bytes()]);
                (
                    Some(signer.sign(&msg)),
                    signer.addr,
                    attestor_pda(&signer.addr),
                )
            }
            None => (None, [0u8; 20], config_pda()),
        };
        // source binding
        let (att_sig, att_addr, att_key) = match c.get("attestation").and_then(|a| a.as_str()) {
            Some(name) => {
                let signer = self.signer(name);
                let msg = keccak(&[report_message(
                    &domain,
                    &series_bytes,
                    period,
                    &prior,
                    &income,
                    tier,
                    liquidity_event,
                )
                .as_bytes()]);
                let key = if tier == pstate::TIER_ZKTLS {
                    verifier_pda(&signer.addr)
                } else {
                    attestor_pda(&signer.addr)
                };
                (Some(signer.sign(&msg)), signer.addr, key)
            }
            None => (None, [0u8; 20], config_pda()),
        };
        let proof = hex_bytes(c["proofSolana"]["proof"].as_str().unwrap());
        let args = SubmitReportArgs {
            period,
            payment_usd: dec_u64(&c["paymentUsd"]),
            fx_avg_wad,
            fx_fallback_sig: fx_sig,
            fx_attestor_addr: fx_addr,
            prior_income_commitment: prior,
            income_commitment: income,
            tier,
            liquidity_event,
            proof,
            attestation_sig: att_sig,
            attestation_addr: att_addr,
        };
        ok(
            &mut self.cu,
            op,
            self.env
                .submit_report(&issuer, &series, args, att_key, fx_key),
        )
    }

    // ---------------------------------------------------------------------------- expect

    fn check_expect(&mut self, step: &Value, context: &str) {
        let mut errors: Vec<String> = Vec::new();
        let mut check = |path: String, expected: &Value, actual: String| {
            let exp = expected_str(expected);
            if exp != actual {
                errors.push(format!("{path}: expected {exp}, got {actual}"));
            }
        };
        let now = self.env.now;
        let usdc = self.env.usdc;
        let series_name = step
            .get("series")
            .and_then(|s| s.as_str())
            .map(|s| s.to_string());
        let series = series_name
            .as_ref()
            .and_then(|n| self.series.get(n).copied());
        let p = series.map(pdas);

        if let Some(balances) = step.get("balances").and_then(|b| b.as_object()) {
            for (actor, b) in balances {
                let w = self.wallet(actor);
                if let Some(stable) = b.get("stable") {
                    check(
                        format!("balances.{actor}.stable"),
                        stable,
                        self.env.balance_of(&w, &usdc).to_string(),
                    );
                }
                if let (Some(units), Some(p)) = (b.get("units"), &p) {
                    let bal = self.env.token_balance(&ata(&w, &p.unit_mint, &TOKEN_2022));
                    check(format!("balances.{actor}.units"), units, bal.to_string());
                }
            }
        }
        if let Some(v) = step.get("feeCollector") {
            let fc = self.env.fee_collector.pubkey();
            check(
                "feeCollector".into(),
                v,
                self.env.balance_of(&fc, &usdc).to_string(),
            );
        }
        if let Some(p) = &p {
            for (k, acc) in [
                ("treasury", p.treasury_token),
                ("vault", p.vault_token),
                ("auctionEscrow", p.escrow_token),
                ("routerBalance", p.router_token),
                ("windowEscrowStable", p.window_stable),
                ("windowEscrowUnits", p.window_escrow_ata),
            ] {
                if let Some(v) = step.get(k) {
                    check(k.into(), v, self.env.token_balance(&acc).to_string());
                }
            }
        }
        if let (Some(exp), Some(series), Some(p)) = (step.get("ledger"), series, &p) {
            self.check_ledger(exp, series, p, now, &mut check);
        }
        if let (Some(exp), Some(series), Some(p)) = (step.get("auction"), series, &p) {
            let a = self.env.auction(&series);
            let escrow_units = self.env.token_balance(&p.auction_escrow_ata);
            let escrow_stable = self.env.token_balance(&p.escrow_token);
            let a = a.unwrap_or_else(|| pstate::Auction {
                series,
                state: 0,
                opened_at: 0,
                commit_end: 0,
                reveal_end: 0,
                escrow_total: 0,
                bid_count: 0,
                revealed_count: 0,
                valid_count: 0,
                tally_round: 0,
                round_rejected: false,
                rejection_reason: 0,
                clearing_price: 0,
                q_above_claim: 0,
                q_at_claim: 0,
                r_claim: 0,
                q_above: 0,
                q_at: 0,
                alloc_sum: 0,
                min_valid_price: 0,
                tallied_count: 0,
                units_sold: 0,
                proceeds: 0,
                settlement_ts: 0,
                bids_processed: 0,
                units_minted: 0,
                mint_finalized: false,
                mint_authority_revoked: false,
                bump: 0,
            });
            let done = matches!(a.state, pstate::RAISE_SETTLED | pstate::RAISE_FAILED);
            let shown = |v: u64| if a.round_rejected || !done { 0 } else { v };
            let reason = match (a.round_rejected, a.rejection_reason) {
                (true, 1) => "ClaimMismatch".to_string(),
                (true, 2) => "InvalidClearingPrice".to_string(),
                _ => "null".to_string(),
            };
            let fields: Vec<(&str, String)> = vec![
                ("bidCount", a.bid_count.to_string()),
                ("revealedCount", a.revealed_count.to_string()),
                ("validCount", a.valid_count.to_string()),
                ("escrowTotal", escrow_stable.to_string()),
                ("auctionEscrowUnits", escrow_units.to_string()),
                ("tallyRound", a.tally_round.to_string()),
                ("roundRejected", a.round_rejected.to_string()),
                ("rejectionReason", reason),
                ("clearingPrice", shown(a.clearing_price).to_string()),
                ("qAbove", shown(a.q_above).to_string()),
                ("qAt", shown(a.q_at).to_string()),
                ("R", shown(a.r_claim).to_string()),
                ("unitsSold", a.units_sold.to_string()),
                ("proceeds", a.proceeds.to_string()),
                ("unitsMinted", a.units_minted.to_string()),
                ("bidsProcessed", a.bids_processed.to_string()),
                ("mintFinalized", a.mint_finalized.to_string()),
            ];
            for (k, actual) in fields {
                if let Some(v) = exp.get(k) {
                    check(format!("auction.{k}"), v, actual);
                }
            }
        }
        if let (Some(exp), Some(series), Some(p)) = (step.get("window"), series, &p) {
            let period = dec_u32(&exp["period"]);
            match self.env.window(&series, period) {
                None => check(
                    format!("window.{period}"),
                    &Value::String("present".into()),
                    "missing".into(),
                ),
                Some(w) => {
                    let all_done = w.processed_count == w.order_count && w.order_count > 0;
                    let state = match w.state {
                        pstate::WINDOW_COMMIT => {
                            if now < w.commit_end {
                                "Commit"
                            } else {
                                "Reveal"
                            }
                        }
                        pstate::WINDOW_SETTLING => "Settling",
                        pstate::WINDOW_SETTLED if all_done => "Done",
                        pstate::WINDOW_SETTLED => "Settled",
                        pstate::WINDOW_NO_MATCH if all_done => "Done",
                        pstate::WINDOW_NO_MATCH => "NoMatch",
                        _ => "Closed",
                    };
                    let settled = w.state == pstate::WINDOW_SETTLED;
                    let branch = if settled {
                        if w.branch == 1 {
                            "DemandLimited"
                        } else {
                            "SupplyLimited"
                        }
                    } else {
                        "null"
                    };
                    let fields: Vec<(&str, String)> = vec![
                        ("period", w.period.to_string()),
                        ("state", state.to_string()),
                        ("tallyRound", w.tally_round.to_string()),
                        ("roundRejected", w.round_rejected.to_string()),
                        (
                            "clearingPrice",
                            if settled {
                                w.clearing_price.to_string()
                            } else {
                                "null".to_string()
                            },
                        ),
                        ("branch", branch.to_string()),
                        (
                            "matchedUnits",
                            if settled { w.matched_units } else { 0 }.to_string(),
                        ),
                        (
                            "escrowStable",
                            self.env.token_balance(&p.window_stable).to_string(),
                        ),
                        (
                            "escrowUnits",
                            self.env.token_balance(&p.window_escrow_ata).to_string(),
                        ),
                    ];
                    for (k, actual) in fields {
                        if let Some(v) = exp.get(k) {
                            check(format!("window.{k}"), v, actual);
                        }
                    }
                }
            }
        }
        if let (Some(holders), Some(series)) =
            (step.get("holders").and_then(|h| h.as_object()), series)
        {
            for (actor, h) in holders {
                let w = self.wallet(actor);
                let holder = self.env.holder(&series, &w);
                let bid = self.env.bid(&series, &w);
                let (pending, redeemed) = holder
                    .map(|h| (h.pending, h.redeemed_units))
                    .unwrap_or((0, 0));
                let (pu, pr, delivered) = bid
                    .map(|b| (b.pending_units, b.pending_refund, b.delivered))
                    .unwrap_or((0, 0, true));
                let fields: Vec<(&str, String)> = vec![
                    ("pending", pending.to_string()),
                    ("redeemedUnits", redeemed.to_string()),
                    ("pendingUnits", pu.to_string()),
                    ("pendingRefund", pr.to_string()),
                    ("delivered", delivered.to_string()),
                ];
                for (k, actual) in fields {
                    if let Some(v) = h.get(k) {
                        check(format!("holders.{actor}.{k}"), v, actual);
                    }
                }
            }
        }
        if let Some(fx) = step.get("fx").and_then(|f| f.as_object()) {
            let min_cov = self.env.config().defaults.fx_min_coverage_bps;
            for (pair_hex, exp) in fx {
                let pair = hex32(pair_hex);
                let acc = self.env.fx_pair(&pair);
                let (sum, count, last_day) = acc
                    .map(|a| (a.sum_wad, a.count, a.last_day))
                    .unwrap_or((0, 0, 0));
                if let Some(v) = exp.get("sumWad") {
                    check(format!("fx.{pair_hex}.sumWad"), v, sum.to_string());
                }
                if let Some(v) = exp.get("count") {
                    check(format!("fx.{pair_hex}.count"), v, count.to_string());
                }
                if let Some(quarters) = exp.get("quarters").and_then(|q| q.as_object()) {
                    for (period_s, q) in quarters {
                        let period: u32 = period_s.parse().unwrap();
                        let start = self.env.fx_checkpoint(&pair, period).map(|c| Checkpoint {
                            sum_wad: c.sum_wad,
                            count: c.count,
                            flagged: c.flagged,
                        });
                        let end = match self.env.fx_checkpoint(&pair, period + 1) {
                            Some(c) => Some(Checkpoint {
                                sum_wad: c.sum_wad,
                                count: c.count,
                                flagged: c.flagged,
                            }),
                            None if now >= period_end(period).unwrap()
                                && u64::from(last_day) * DAY
                                    < period_start(period + 1).unwrap() =>
                            {
                                Some(Checkpoint {
                                    sum_wad: sum,
                                    count,
                                    flagged: false,
                                })
                            }
                            None => None,
                        };
                        let (ok, avg, n, flagged) = match (start, end) {
                            (Some(s), Some(e)) => {
                                let (ok, avg) = quarter_average(period, &s, &e, min_cov).unwrap();
                                (ok, avg, e.count - s.count, s.flagged)
                            }
                            (Some(s), None) => (false, 0, 0, s.flagged),
                            _ => (false, 0, 0, false),
                        };
                        let fields: Vec<(&str, String)> = vec![
                            ("ok", ok.to_string()),
                            ("avgWad", avg.to_string()),
                            ("n", n.to_string()),
                            ("flagged", flagged.to_string()),
                        ];
                        for (k, actual) in fields {
                            if let Some(v) = q.get(k) {
                                check(format!("fx.{pair_hex}.quarters.{period}.{k}"), v, actual);
                            }
                        }
                    }
                }
            }
        }
        drop(check);
        if !errors.is_empty() {
            panic!(
                "{context}: {} mismatch(es):\n  {}",
                errors.len(),
                errors.join("\n  ")
            );
        }
    }

    fn check_ledger(
        &self,
        exp: &Value,
        series: Pubkey,
        p: &Pdas,
        now: u64,
        check: &mut dyn FnMut(String, &Value, String),
    ) {
        let s = self.env.series(&series);
        let a = self.env.auction(&series);
        let t = self.env.treasury(&series);
        let l = self.env.ledger(&series);
        let _ = p;
        let status = match &l {
            // an unsettled series has no countdowns: the reference reads OnTime
            Some(l) if l.settlement_ts == 0 => l.stored_status(),
            Some(l) => {
                let pauses: Vec<Pause> = (0..usize::from(l.pause_count))
                    .map(|i| Pause {
                        start: l.pause_start[i],
                        end: l.pause_end[i],
                    })
                    .collect();
                let inputs = StatusInputs {
                    stored: l.stored_status(),
                    pauses: &pauses,
                    earliest_unpaid_period: l.earliest_unpaid().unwrap(),
                    trueup_due: l.trueup_due,
                    trueup_attested_at: l.trueup_attested_at,
                };
                derive_status(&inputs, now).unwrap()
            }
            None => SeriesStatus::OnTime,
        };
        let raise_state = match &a {
            None => "Draft",
            Some(a) => match a.state {
                pstate::RAISE_DRAFT => "Draft",
                pstate::RAISE_OPEN if now >= a.commit_end => "Reveal",
                pstate::RAISE_OPEN => "Open",
                pstate::RAISE_SETTLING => "Settling",
                pstate::RAISE_SETTLED => "Settled",
                pstate::RAISE_FAILED => "Failed",
                _ => "Cancelled",
            },
        };
        let settled = s.raise_state == RAISE_SETTLED;
        let final_price = a
            .as_ref()
            .filter(|a| matches!(a.state, pstate::RAISE_SETTLED | pstate::RAISE_FAILED))
            .map(|a| a.clearing_price)
            .unwrap_or(0);
        let cap_per_unit = if settled {
            (u128::from(s.cap_multiple_wad) * u128::from(s.clearing_price) / WAD_U128).to_string()
        } else {
            "0".to_string()
        };
        let lz = l.as_ref();
        let g =
            |f: &dyn Fn(&pstate::Ledger) -> String| lz.map(f).unwrap_or_else(|| "0".to_string());
        let fields: Vec<(&str, String)> = vec![
            ("status", status_name(status).to_string()),
            ("raiseState", raise_state.to_string()),
            ("mintFinalized", s.mint_finalized.to_string()),
            ("unitsOutstanding", g(&|l| l.units_outstanding.to_string())),
            (
                "unitsSold",
                a.as_ref().map(|a| a.units_sold).unwrap_or(0).to_string(),
            ),
            ("clearingPrice", final_price.to_string()),
            (
                "proceeds",
                a.as_ref().map(|a| a.proceeds).unwrap_or(0).to_string(),
            ),
            (
                "releasedTotal",
                t.as_ref()
                    .map(|t| t.released_total)
                    .unwrap_or(0)
                    .to_string(),
            ),
            ("capPerUnit", cap_per_unit),
            ("capMultipleWad", s.cap_multiple_wad.to_string()),
            (
                "termsCommitment",
                format!("0x{}", hex::encode(s.terms_commitment)),
            ),
            ("amendmentNonce", s.amendment_nonce.to_string()),
            ("paidPerUnitWad", g(&|l| l.paid_per_unit_wad.to_string())),
            ("netAccWad", g(&|l| l.net_acc_wad.to_string())),
            ("carryWad", g(&|l| l.carry_wad.to_string())),
            (
                "carry",
                g(&|l| (u128::from(l.carry_wad) / WAD_U128).to_string()),
            ),
            ("grossReceived", g(&|l| l.gross_received.to_string())),
            ("feeCollected", g(&|l| l.fee_collected.to_string())),
            ("refundedToIssuer", g(&|l| l.refunded_to_issuer.to_string())),
            (
                "lastAcceptedPeriod",
                lz.map(|l| opt_u32(l.last_accepted_period()))
                    .unwrap_or_else(|| "null".into()),
            ),
            (
                "lastPaidPeriod",
                lz.map(|l| opt_u32(l.last_paid_period()))
                    .unwrap_or_else(|| "null".into()),
            ),
            (
                "openDuePeriod",
                lz.map(|l| {
                    opt_u32(if l.open_due_amount > 0 {
                        l.open_due_period()
                    } else {
                        None
                    })
                })
                .unwrap_or_else(|| "null".into()),
            ),
            ("openDueAmount", g(&|l| l.open_due_amount.to_string())),
            ("routerCredit", g(&|l| l.router_credit.to_string())),
            ("trueupNonce", g(&|l| l.trueup_nonce.to_string())),
            ("trueupDue", g(&|l| l.trueup_due.to_string())),
            ("trueupAttestedAt", g(&|l| l.trueup_attested_at.to_string())),
            (
                "lastTrueupYear",
                lz.map(|l| opt_u32(l.last_trueup_year()))
                    .unwrap_or_else(|| "null".into()),
            ),
            ("pauseNonce", g(&|l| l.pause_nonce.to_string())),
            ("pauseCount", g(&|l| l.pause_count.to_string())),
            ("pausedTotal", g(&|l| l.paused_total.to_string())),
            (
                "formalNoticeEmittedFor",
                lz.map(|l| opt_u32(l.formal_notice_emitted_for()))
                    .unwrap_or_else(|| "null".into()),
            ),
            ("redemptionPrice", g(&|l| l.redemption_price.to_string())),
            (
                "unitsAtRedemption",
                g(&|l| l.units_at_redemption.to_string()),
            ),
            ("tailCapPerUnit", g(&|l| l.tail_cap_per_unit.to_string())),
            ("tailAccWad", g(&|l| l.tail_acc_wad.to_string())),
            (
                "tailExhausted",
                lz.map(|l| l.is_tail_exhausted().to_string())
                    .unwrap_or_else(|| "false".into()),
            ),
            ("extinguishedAt", g(&|l| l.extinguished_at.to_string())),
            ("finalAccWad", g(&|l| l.final_acc_wad.to_string())),
            ("finalUnits", g(&|l| l.final_units.to_string())),
            ("extinguishNonce", g(&|l| l.extinguish_nonce.to_string())),
        ];
        for (k, actual) in fields {
            if let Some(v) = exp.get(k) {
                check(format!("ledger.{k}"), v, actual);
            }
        }
    }
}

/// Runs `packages/vectors/<name>` and returns the runner.
pub fn run_vector(name: &str) -> Runner {
    Runner::run(&vector_path(name))
}
