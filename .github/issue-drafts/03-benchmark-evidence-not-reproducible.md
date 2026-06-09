# The benchmark evidence is not reproducible from the repo

**Labels:** `area/benchmarks`, `kind/reproducibility`, `priority/blocker-1.0`

## Summary

The report's central numbers (catalog at 5000, budget at 2000, churn caps at 100, the per-driver
req/s) come from a CI run (`run 27013931113`, commit `2c3a6c7`) whose data is **not in the repo**:
`benchmarks/results/` is in `.gitignore`. The only committed baseline, `ci-ubuntu.json`, is a
**different** run: a different commit (`a668a65`), CI sizes (caps 25/50, N=100/500, K=100/1000), a
different CPU (Xeon, not EPYC), and **different numbers** (e.g. rowscope guarded 935 vs the report's
859; cold schema 6.4 ms vs ~9 ms). And `1.0.0.json`, which the README says contains "the absolute
numbers used in the docs", is an **empty placeholder**. The canonical reference machine is still a
template with `<e.g.>`.

A reviewer who clones the repo cannot reproduce or verify the report.

## Evidence (file:line)

- `results/` gitignored (untracked): `git check-ignore benchmarks/results/` returns the path;
  `git ls-files benchmarks/results/` is empty.
- Committed baseline ≠ the report's run: `benchmarks/baselines/ci-ubuntu.json` (commit `a668a65`,
  CPU Xeon 8370C, CI sizes).
- `1.0.0.json` empty: `benchmarks/baselines/1.0.0.json` (`"capturedEnv": null`, `"index": {}`,
  note "PLACEHOLDER").
- Reference machine left unfilled: `benchmarks/README.md:87-94` (the `<e.g. ...>` block).

## Why it blocks 1.0

A performance sign-off for enterprise adoption cannot rest on an ephemeral CI artifact (~90-day
retention) that nobody can regenerate traceably. Without reproducibility, the headline numbers are
not auditable.

## Acceptance criteria

- [ ] The representative raw snapshot (the JSON files of the cited run) is **committed** at a tracked
      path (e.g. `benchmarks/baselines/raw/<run-id>/`), linked from `PERFORMANCE_ASSESSMENT.md`.
- [ ] `npm run bench:report -- --runs=N` aggregates N runs (median + IQR) for a stable, citable number.
- [ ] `1.0.0.json` contains a real capture **or** the README stops claiming that it does.
- [ ] The canonical reference machine is documented (provider/instance, vCPU/RAM, OS/kernel, PG,
      Node, date, commit) in `benchmarks/README.md`.
- [ ] CI, in addition to uploading the artifact, commits the representative run's snapshot (or attaches it to a release).

## Closing benchmark(s)

B-6 (multi-run + median/IQR aggregation + tracked snapshot + 1.0.0/README).

## Fix options (with trade-offs)

1. **Commit curated raw snapshots** under `baselines/raw/` (recommended): traceable and diffable;
   grows the repo modestly (small JSON).
2. **Attach to releases / long-term artifact storage**: does not inflate the repo; depends on
   external infrastructure and links that can expire.
3. **Multi-run only, without committing raw data**: improves the number's stability but not its
   traceability; insufficient on its own.
