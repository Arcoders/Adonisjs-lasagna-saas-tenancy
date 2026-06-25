# Committed raw benchmark snapshots

`benchmarks/results/` is gitignored (noisy per-run output). This folder is
**tracked**: it holds the curated raw result JSONs behind a published number, so
the figures in `benchmarks/results/PERFORMANCE_ASSESSMENT.md` and the generated
`docs/guides/performance.md` are reproducible and auditable from the repo.

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

The turnkey path is the **Capture 1.0.0 baseline** workflow
(`.github/workflows/capture-baseline.yml`): it runs the full-size sweep `runs`
times on a Linux runner, aggregates the throughput tiers, writes `1.0.0.json`,
snapshots the raw JSONs into a new subfolder here, and opens a PR. Start it from
the default branch via *Run workflow*, or from a feature branch without merging by
pushing a tag matching `capture-baseline*` (e.g. `capture-baseline-3`, where the
trailing number is the run count). To do it by hand on a dedicated VM instead:

1. Run the full sweep on the Linux reference VM (`runs` times for a quotable
   headline).
2. Copy the run's JSONs here under a new subfolder.
3. Aggregate: `npm run bench:report -- --runs=5 --write-baseline=1.0.0`
   (median + IQR). `bench:report` reads each file's own `env` block, so this is
   correct even when run on a non-Linux box against Linux-captured files.
4. Link the subfolder from `PERFORMANCE_ASSESSMENT.md`.

Until a capture is committed, `baselines/1.0.0.json` stays a scaffold and the
docs page prints its provisional caveat.
