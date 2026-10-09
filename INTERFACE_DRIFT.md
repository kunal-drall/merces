# INTERFACE_DRIFT.md

Stage 1 is not present yet: `pnpm stage1:sync` reports "Stage 1 not present" and every chain runs on the simulator.

`pnpm stage1:sync` regenerates this file from Stage 1's handoff (its events schema, or its IDLs and ABIs). It lists
every canonical event and command with its Stage 1 counterpart and field mapping, every canonical item without a
counterpart, every extra Stage 1 item, every field mismatch and every match it could not verify. The diff step is
`ok` only when nothing is left to resolve (A-SYNC-1); see STAGE1_INTEGRATION.md.
