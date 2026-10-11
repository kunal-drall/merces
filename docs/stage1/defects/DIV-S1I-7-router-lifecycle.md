# DIV-S1I-7: router lifecycle and checkpoints

Pinned Stage 1: bafe1fb (the chain programs are unchanged from 1bfc66b).

The TS reference's `route_income` refuses terminal series. Both programs deliberately pass all subsequent income to
the issuer: EVM `MercesRouter.sol::_route` uses zero holder units for terminal states; Solana `router.rs::route` does
likewise. The backend follows the programs. A receipt after a cap-triggered retirement therefore succeeds, increases
the recorded receipt total, and pays nothing further to holders.

Checkpoint behavior also depends on the program. The reference and Solana retain eight checkpoints; EVM's mapping
retains every closed quarter, including all quarters traversed in one long gap. Solana refuses duplicate close with
`RouterPeriodAlreadyClosed`; EVM treats it as an idempotent no-op. EVM close requires a settled raise. Neither close
implementation requires mint finalization.

`packages/simulator/test/split.test.ts` covers these cases on both personalities, along with pure tier-1 checkpoint
binding and cap refunds. Official vectors 12 and 18 pass in full on both; this record creates no vector waiver. Extend
the reference with the program-specific lifecycle/checkpoint rules before removing the record.
