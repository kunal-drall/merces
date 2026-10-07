# Licensing

- `evm/` depends on Tokeny's T-REX suite (`@tokenysolutions/t-rex` 4.1.6), licensed GPL-3.0. Any distribution of the
  compiled EVM contracts or their verified source is therefore a GPL-3.0 combined work. Tokeny's *shipped* compliance
  modules additionally carry a CC-BY-NC-4.0 non-commercial rider; Merces does **not** use or derive from those modules
  and implements its own `MercesComplianceModule` against the GPL-only `IModule`/`AbstractModule` interfaces.
- Everything else in this repository (Solana programs, reference implementation, circuits, documentation) is
  Copyright (c) 2026 Merces. Licence to be decided by Kunal (see `ASSUMPTIONS.md`, question H5). Until then: all rights reserved.
