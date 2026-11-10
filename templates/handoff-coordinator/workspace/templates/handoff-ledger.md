# Handoff ledger — `<handoffId>`

- **Target:** `<targetId>` (`<transport>`)
- **Mode / Publisher:** `<mode>` / `<publisherOwner>`
- **Lifecycle / Directive:** `<lifecycleStatus>` -> `<orchestratorDirective.action>`
- **Turn:** `<turnNumber>` / `<maxAutonomousTurns>`

## Goal & acceptance criteria

- `<goal>`

## Remote reported claim (`reported`)

- **Disposition:** `<reported.disposition>`
- **Candidate ref / commit:** `<reported.candidateRef>` @ `<reported.candidateCommitSha>`
- **Summary delta:** `<reported.summaryDelta>`
- **Blockers:** `<reported.blockers or none>`

## Bridge observed verification (`observed`)

- **Reachable ref verified:** `<observed.reachableRefVerified>`
- **Observed HEAD / tree:** `<observed.observedHeadSha>` / `<observed.observedTreeSha>`
- **Base ancestry & locked paths:** `baseIsAncestor=<bool>`, `lockedPathsClean=<bool>` (`violatedPaths=<list or none>`)
- **Pull request state:** `<observed.reconciledPrState>` (`<observed.reconciledPrUrl or none>`)

## Evidence exchanged

- `<turn>` — `<claim>` (`<sourceRef>`)

## Next owner action

- `<concise operator decision or autonomous next step>`
