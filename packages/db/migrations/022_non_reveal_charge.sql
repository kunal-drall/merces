-- NRC (S3 follow-up): the non-reveal charge, modelled as Stage 1 does (SPEC §5.2). When a sealed raise settles, Stage 1's
-- process_bid keeps floor(escrow × non_reveal_charge_bps / 10000) of a bid committed and never revealed for the fee
-- collector (NonRevealCharged; FeeTaken{kind: nonReveal} in fees_ledger) and owes the bidder the rest. The charge is a
-- public onchain amount on the bidder's own deposit, not an income figure. 0 for every other bid, and for every bid
-- indexed before this migration (series created under the S2 hold record 0 bps and were never charged).
alter table bids add column if not exists non_reveal_charge numeric(38,0) not null default 0;
