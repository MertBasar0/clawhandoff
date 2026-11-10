# Single-Publisher & Git Verification Contract

## 1. Publisher ownership (`publisherOwner`)

Every handoff selects exactly one publication owner before Turn 1:

- `remote_gated` (two-stage gate):
  - **Stage 1 (`allowManagedPublishStage: false`):** The remote worker investigates or implements on a candidate branch/worktree and returns its candidate ref + commit SHA without opening a pull request. The bridge independently checks base ancestry, `expectedTreeSha`, and `lockedPaths`.
  - **Stage 2 (`intent: "authorize_publish"`):** Only after Stage 1 passes and the human owner approves publication does the bridge unlock the exact verified commit SHA for pull-request creation. If the branch moves before Stage 2 dispatches, authorization fails closed (`PUBLISH_GATE_BLOCKED`).
- `local`: Remote worker has zero publication authority; after Git verification passes (`PUBLISH_LOCALLY`), the local coordinator/operator publishes within existing authority.
- `none`: Investigation or verification only; no pull request is created.

## 2. Reported claims vs observed facts

- `reported`: Parsed from the remote agent's fenced `handoff-result` JSON block (`disposition`, `candidateRef`, `candidateCommitSha`, `claimedChecks`, `blockers`). Treated strictly as an unverified claim.
- `observed`: Independently verified by the bridge (`reachableRefVerified`, `observedHeadSha`, `observedTreeSha`, `baseIsAncestor`, `lockedPathsClean`, `violatedPaths`, `reconciledPrState`, `reconciledPrUrl`).
- Any history commit touching a `lockedPaths` entry between `pinnedSourceCommitSha` and `observedHeadSha` fails verification, even if reverted in a subsequent commit.

## 3. Stagnation & budget discipline

- Each `CONTINUE_AUTONOMOUSLY` turn must supply concrete new commit-bound evidence (`evidenceRefs` with `claim` + `sourceRef`) or updated source coordinates (`updatedSourceCommitSha`).
- Repeating the same blocker twice without new commit or evidence progress escalates cleanly (`ESCALATE_TO_HUMAN`) instead of looping forever.
