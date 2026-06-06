# Committed raw benchmark snapshots

`benchmarks/results/` is gitignored (noisy per-run output). This folder is
**tracked**: it holds the curated raw result JSONs behind a published number, so
the figures in `benchmarks/results/PERFORMANCE_ASSESSMENT.md` and the generated
`docs/docs/performance.md` are reproducible and auditable from the repo.

## Convention

One subfolder per representative capture, named `<commit>-<host>-<date>/`, e.g.
`2c3a6c7-ubuntu-epyc-2026-06-05/`. Copy the suite JSONs that back the report
into it:

```
benchmarks/results/{micro,db,http,iso,mem,soak,resilience}-*-<ts>.json
  → benchmarks/baselines/raw/<commit>-<host>-<date>/
```

Each JSON already carries its own `env` block (cpu, node, pg, commit, timestamp),
so a number is never separated from the machine that produced it.

## How a capture is made

1. Run the full sweep (locally on the Linux reference VM, or via the
   `benchmark.yml` `full_size=true` dispatch and download the artifact).
2. Copy the chosen run's JSONs here under a new subfolder.
3. For a quotable headline, aggregate several runs:
   `npm run bench:report -- --runs=5 --write-baseline=1.0.0` (median + IQR).
4. Link the subfolder from `PERFORMANCE_ASSESSMENT.md`.

Until a capture is committed, `baselines/1.0.0.json` stays a scaffold and the
docs page prints its provisional caveat.
