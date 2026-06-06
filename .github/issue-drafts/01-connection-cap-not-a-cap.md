# El "cap" de conexiones de tenant no acota bajo la grace de producción

**Labels:** `area/isolation`, `area/benchmarks`, `kind/correctness`, `priority/blocker-1.0`

> **Estado: remedio implementado (opt-in).** Se añadió `isolation.enforceConnectionCap`
> (default `false`). Con `true`, el LRU deja de exceder el cap y `connect()` rechaza una
> conexión nueva con `TenantConnectionLimitException` (503) cuando todo está en la grace window
> (cap duro / admission control). El default preserva el comportamiento seguro de no severar ni
> rechazar. Implementación: `connection_lru.ts` (`atHardLimit()`), `schema_pg_driver.ts` /
> `database_pg_driver.ts` (chequeo en `connect()`), `types/config.ts`,
> `exceptions/tenant_connection_limit_exception.ts`; tests en `connection_lru.spec.ts`; el bench
> `connection_budget_burst` añade el escenario `hardCapCheck`. Queda abierto: dimensionar
> `max_connections`/PgBouncer a escala y la corrección del relato en docs/report (hecho en
> `report.ts` y el reporte de readiness).

## Resumen

El informe de rendimiento afirma que "el cap de conexiones aguanta hasta 2000 tenants" y que
"la memoria está acotada por el cap, no por N". Esa conclusión se obtiene midiendo el budget
con la *grace window* de evicción bajada artificialmente a **50 ms**. Con la grace por defecto
de producción (**30 s**), y en los datos de churn de la misma corrida, las conexiones abiertas
son **2×cap** (50/100/200), no el cap. El LRU está **diseñado** para exceder el cap cuando todas
las conexiones están dentro de la grace window, por lo que bajo una ráfaga de N tenants activos
las conexiones tienden a N, sin más techo que `max_connections` de Postgres.

La afirmación que se vende ("acotado por el cap") es la contraria a lo que hace el sistema bajo
carga real.

## Evidencia (archivo:línea)

- El budget bench fuerza la grace a 50 ms para que el cap "ate":
  `benchmarks/src/memory/connection_budget.bench.ts:24` (`BUDGET_GRACE_MS = 50`), con el comentario
  en `:15-23` admitiendo que con la grace por defecto "the pool grows to N".
- El default real es 30 s: `packages/core/src/services/isolation/connection_lru.ts:12`
  (`DEFAULT_EVICTION_GRACE_MS = 30_000`).
- El LRU excede el cap por diseño cuando todo está en la grace window:
  `packages/core/src/services/isolation/connection_lru.ts:89-93` (no evicta; sólo avisa).
- Contraprueba en la **misma corrida** (grace por defecto): los datos de churn registran
  `tenantConnectionsOpen: 50 / 100 / 200` = 2×cap (caps 25/50/100). Ver el meta de
  `connection_churn` en los resultados de la corrida `2c3a6c7`.
- El informe presenta "open = 50 a N=2000" sin revelar la grace de 50 ms:
  `benchmarks/results/PERFORMANCE_ASSESSMENT.md` (TL;DR y §4).
- El report generado hornea el claim: `benchmarks/src/harness/report.ts:104` ("the connection cap
  holds as the tenant count grows") y `:219` ("open tenant connections stay bounded by the cap").

## Por qué bloquea 1.0

Induce a una configuración peligrosa: un operador que crea el "cap" creerá que sus conexiones
están acotadas a 50 y dimensionará `max_connections` en consecuencia. Bajo una ráfaga real de
tenants activos, las conexiones crecen hacia N, agotan `max_connections` y **tumban a todos los
tenants** (no sólo al que provocó la ráfaga). Es un fallo de disponibilidad a escala disfrazado
de garantía.

## Criterios de aceptación

- [ ] Existe un benchmark que mide el número de conexiones abiertas **con la grace por defecto
      (30 s)** bajo ráfaga concurrente y publica `openDuringBurst` (se espera ≈ N, no el cap).
- [ ] Existe un escenario de saturación (`N×poolMax > max_connections`) que documenta el modo de
      fallo y la recuperación tras drenar (`failClosedCheck`, `recoveredWithinMs`).
- [ ] El report generado y `PERFORMANCE_ASSESSMENT.md` dejan de afirmar "acotado por el cap" y
      explican el modelo real: "acotado por `max_connections`; usar PgBouncer / admission control".
- [ ] La doc de scaling-limits recomienda explícitamente PgBouncer (transaction pooling) por encima
      de cierto número de tenants concurrentes.

## Benchmark(s) que lo cierran

B-2 (budget con grace de producción + ráfaga concurrente + modo fallo `max_connections`).

## Opciones de solución (con trade-offs)

1. **Solo documentar + medir honesto** (este issue mínimo): no se toca el core; se corrige el
   relato y se recomienda PgBouncer. Barato; deja la responsabilidad de acotar al operador.
2. **Hard-cap opcional / admission control en el LRU**: cuando se alcanza el cap y todo está en la
   grace window, *rechazar* (fail-closed con 503/Retry-After) o *encolar* nuevas conexiones de tenant
   en vez de exceder el cap. Acota de verdad la memoria/backends a costa de rechazar tráfico de
   tenants nuevos bajo ráfaga. Requiere cambio en el core (fuera de este issue; abrir follow-up).
3. **Modo "evict-LRU agresivo"**: reducir la grace o evictar el menos-reciente aunque esté en la
   ventana. Riesgo: vuelve el bug de "severar request en vuelo" que el LRU in-use-aware arregló.
