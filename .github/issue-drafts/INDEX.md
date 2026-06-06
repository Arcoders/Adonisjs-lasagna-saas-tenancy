# Issue drafts — blockers de 1.0 (de la auditoría adversarial del benchmark)

Borradores listos para crear como issues de GitHub (este entorno no tiene `gh` CLI).
Salen de la revisión adversarial de `benchmarks/results/PERFORMANCE_ASSESSMENT.md`, que
encontró que las tres conclusiones estrella del informe se miden apagando o evitando el
mecanismo que dicen medir, y que la evidencia no es reproducible desde el repo.

Cada borrador trae: resumen, evidencia con `archivo:línea`, por qué bloquea 1.0, criterios
de aceptación verificables, el/los benchmark(s) que lo cierran, y opciones de solución.

| # | Archivo | Blocker | Benchmark que lo cierra |
|---|---|---|---|
| 01 | [01-connection-cap-not-a-cap.md](01-connection-cap-not-a-cap.md) | El "cap" de conexiones no acota bajo la grace de producción | B-2 (budget con grace real + modo fallo) |
| 02 | [02-no-concurrent-isolation-test.md](02-no-concurrent-isolation-test.md) | No hay prueba de aislamiento en el camino real bajo concurrencia | B-1 (aislamiento HTTP) + B-7 (write path) |
| 03 | [03-benchmark-evidence-not-reproducible.md](03-benchmark-evidence-not-reproducible.md) | La evidencia del benchmark no es reproducible desde el repo | B-6 (multi-run + snapshot tracked + 1.0.0 real) |
| 04 | [04-no-failure-recovery-soak.md](04-no-failure-recovery-soak.md) | Cero pruebas de soak / fallo / recuperación | B-4 (soak) + B-5 (resiliencia) |
| 05 | [05-database-pg-memory-parity.md](05-database-pg-memory-parity.md) | database-pg sin cobertura de memoria/budget/catalog | B-3 (Tier 4 multi-driver + catalog realista) |

> Crear los issues reales: con `gh` → `gh issue create --title "<título>" --body-file <archivo> --label "<labels>"`;
> o vía REST API. Recordatorio de seguridad: el remote `origin` lleva un PAT en texto plano;
> rotarlo antes de cualquier operación de red.
