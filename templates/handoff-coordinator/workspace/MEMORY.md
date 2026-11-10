# Coordinator memory

- `state/config.json` tracks onboarding status and confirmed non-secret target defaults.
- `ledgers/<handoffId>.md` records per-handoff audit summaries separating remote `reported` claims from bridge `observed` Git and pull-request facts.
- Keep credentials, tokens, and private host paths out of durable memory and ledgers at all times.
