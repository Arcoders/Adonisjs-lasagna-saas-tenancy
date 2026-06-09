# Issue drafts — 1.0 blockers (from the adversarial benchmark audit)

Drafts ready to file as GitHub issues (this environment has no `gh` CLI).
They come out of the adversarial review of `benchmarks/results/PERFORMANCE_ASSESSMENT.md`, which
found that the report's three headline conclusions are each measured by turning off or sidestepping
the very mechanism they claim to measure, and that the evidence is not reproducible from the repo.

Each draft carries: summary, evidence with `file:line`, why it blocks 1.0, verifiable acceptance
criteria, the benchmark(s) that close it, and fix options.

| # | File | Blocker | Closing benchmark |
|---|---|---|---|
| 01 | [01-connection-cap-not-a-cap.md](01-connection-cap-not-a-cap.md) | The connection "cap" does not bound under the production grace window | B-2 (budget with real grace + failure mode) |
| 02 | [02-no-concurrent-isolation-test.md](02-no-concurrent-isolation-test.md) | No isolation test on the real path under concurrency | B-1 (HTTP isolation) + B-7 (write path) |
| 03 | [03-benchmark-evidence-not-reproducible.md](03-benchmark-evidence-not-reproducible.md) | The benchmark evidence is not reproducible from the repo | B-6 (multi-run + tracked snapshot + real 1.0.0) |
| 04 | [04-no-failure-recovery-soak.md](04-no-failure-recovery-soak.md) | Zero soak / failure / recovery tests | B-4 (soak) + B-5 (resilience) |
| 05 | [05-database-pg-memory-parity.md](05-database-pg-memory-parity.md) | database-pg has no memory/budget/catalog coverage | B-3 (Tier 4 multi-driver + realistic catalog) |

> Create the real issues: with `gh` → `gh issue create --title "<title>" --body-file <file> --label "<labels>"`;
> or via the REST API. Security reminder: the `origin` remote carries a PAT in plaintext;
> rotate it before any network operation.
