# La evidencia del benchmark no es reproducible desde el repo

**Labels:** `area/benchmarks`, `kind/reproducibility`, `priority/blocker-1.0`

## Resumen

Los números centrales del informe (catalog a 5000, budget a 2000, churn caps a 100, los req/s por
driver) provienen de una corrida de CI (`run 27013931113`, commit `2c3a6c7`) cuyos datos **no están
en el repo**: `benchmarks/results/` está en `.gitignore`. El único baseline commiteado,
`ci-ubuntu.json`, es **otra** corrida: otro commit (`a668a65`), tamaños de CI (caps 25/50, N=100/500,
K=100/1000), otra CPU (Xeon, no EPYC) y **números distintos** (p.ej. rowscope guarded 935 vs 859 del
informe; cold schema 6,4 ms vs ~9 ms). Y `1.0.0.json`, que el README dice que contiene "los números
absolutos usados en los docs", es un **placeholder vacío**. La máquina de referencia canónica sigue
siendo una plantilla con `<e.g.>`.

Un revisor que clone el repo no puede reproducir ni verificar el informe.

## Evidencia (archivo:línea)

- `results/` gitignored (no trackeado): `git check-ignore benchmarks/results/` devuelve la ruta;
  `git ls-files benchmarks/results/` está vacío.
- Baseline commiteado ≠ corrida del informe: `benchmarks/baselines/ci-ubuntu.json` (commit `a668a65`,
  CPU Xeon 8370C, sizes de CI).
- `1.0.0.json` vacío: `benchmarks/baselines/1.0.0.json` (`"capturedEnv": null`, `"index": {}`,
  nota "PLACEHOLDER").
- Máquina de referencia sin rellenar: `benchmarks/README.md:87-94` (bloque `<e.g. ...>`).

## Por qué bloquea 1.0

Un sign-off de rendimiento para adopción empresarial no puede apoyarse en un artefacto efímero de CI
(retención ~90 días) que nadie puede regenerar de forma trazable. Sin reproducibilidad, los números
del headline no son auditables.

## Criterios de aceptación

- [ ] El snapshot crudo representativo (los JSON de la corrida citada) está **commiteado** en una ruta
      trackeada (p.ej. `benchmarks/baselines/raw/<run-id>/`), enlazado desde `PERFORMANCE_ASSESSMENT.md`.
- [ ] `npm run bench:report -- --runs=N` agrega N corridas (mediana + IQR) para un número estable y citable.
- [ ] `1.0.0.json` contiene una captura real **o** el README deja de afirmar que la contiene.
- [ ] La máquina de referencia canónica está documentada (provider/instance, vCPU/RAM, OS/kernel, PG,
      Node, fecha, commit) en `benchmarks/README.md`.
- [ ] CI, además de subir el artefacto, commitea el snapshot del run representativo (o lo adjunta a un release).

## Benchmark(s) que lo cierran

B-6 (multi-run + agregación mediana/IQR + snapshot tracked + 1.0.0/README).

## Opciones de solución (con trade-offs)

1. **Commitear snapshots crudos curados** bajo `baselines/raw/` (recomendado): trazable y diffable;
   crece el repo modestamente (JSON pequeños).
2. **Adjuntar a releases / artifact storage de largo plazo**: no infla el repo; depende de
   infraestructura externa y enlaces que pueden caducar.
3. **Solo multi-run sin commitear crudos**: mejora la estabilidad del número pero no la trazabilidad;
   insuficiente por sí solo.
