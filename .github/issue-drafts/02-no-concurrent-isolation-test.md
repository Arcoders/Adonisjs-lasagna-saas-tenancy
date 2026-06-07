# No existe prueba de aislamiento cross-tenant en el camino real bajo concurrencia

**Labels:** `area/isolation`, `area/benchmarks`, `kind/correctness`, `priority/blocker-1.0`, `security`

> **✅ RESUELTO (2026-06-07).** El tier de aislamiento HTTP concurrente con correlación por
> contenido (`benchmarks/http/isolation.bench.ts`) corre como **gate por PR** en los 3 drivers
> (`.github/workflows/benchmark-correctness.yml`), con self-test negativo (`BENCH_ISO_SELFTEST=1`)
> y aserción del camino de escritura (`bench:db` write-isolation). El límite de `rowscope-pg`
> (query raw/unscoped) está documentado y respaldado por el backstop RLS
> (`packages/core/tests/integration/services/rowscope_rls.spec.ts`). Cumple todos los criterios.
> El análisis de abajo es el original que motivó el trabajo.

## Resumen

El informe llama a "cero fugas cross-tenant" la propiedad de correctitud más importante. Pero el
único test que la respalda es **secuencial**, corre **después** del churn, obtiene la conexión con
un `ref` **explícito** y **nunca pasa por el camino real** de resolución (HttpContext +
AsyncLocalStorage) que usa producción. Para `rowscope-pg` el test **se inyecta a sí mismo** el
predicado `where tenant_id`, así que sólo demuestra que `WHERE` filtra, no que el driver/mixin aísle.
El tier HTTP, que sí ejerce el camino real bajo concurrencia, **no tiene ninguna aserción de
aislamiento**: sólo mide non-2xx y throughput.

Es decir: el vector de fuga peligroso (cruce de contexto ALS bajo concurrencia, reuso de conexión
durante un evict en vuelo, bypass del mixin con raw/relación/agregado) está **sin testear**.

## Evidencia (archivo:línea)

- `countLeaks` es secuencial, post-churn, con ref explícito: `benchmarks/src/db/connection_churn.bench.ts:44-54`.
- La conexión se obtiene con ref explícito vía `clientFor` → `driver.connect(ref)`:
  `benchmarks/src/db/queries.ts:13-20`.
- El predicado de rowscope lo añade la propia query de verificación: `benchmarks/src/db/queries.ts:47-51`.
- El camino real de resolución (ALS + `HttpContext.get()`) que el test no toca:
  `packages/core/src/models/adapters/tenant_adapter.ts:54-66`.
- El tier HTTP sólo comprueba non-2xx, no contenido por tenant: `benchmarks/http/load.bench.ts:85-93`.

## Por qué bloquea 1.0

Es un paquete *multi-tenant*: la garantía nº1 que un adoptante necesita es "el tenant A nunca ve
datos del tenant B". Hoy no hay evidencia de esa propiedad en el camino y bajo la concurrencia de
producción. "Cero fugas" como está medido es casi una tautología.

## Criterios de aceptación

- [ ] Un benchmark dispara requests concurrentes alternando `x-tenant-id` sobre N tenants y
      **correlaciona request↔respuesta por contenido** (no sólo el `tenantId` ecoado): cada nota
      devuelta debe pertenecer al tenant pedido.
- [ ] La aserción corre para los tres drivers y `isolationCheck` es un **gate duro** (proceso sale
      ≠0 y el job de CI falla en `FAIL`).
- [ ] Hay un "self-test" negativo: forzar una correlación incorrecta debe producir `FAIL` (prueba de
      que el bench realmente detecta fugas).
- [ ] Se mide y documenta el **límite de rowscope-pg**: una query raw/unscoped dentro del contexto de
      un tenant devuelve filas de otros (frontera de diseño conocida), registrada explícitamente.
- [ ] Existe aserción de aislamiento también en el **camino de escritura** bajo churn/concurrencia.

## Benchmark(s) que lo cierran

B-1 (aislamiento HTTP concurrente con correlación por contenido + self-test) y B-7 (write path
bajo churn con `writeIsolationCheck`). Requiere sembrar títulos identificables por tenant
(`seedIdentifiableNotes`, porque `/tenant/notes` ordena `id desc limit 20` y el `marker:` antiguo
no entra en la ventana: `benchmarks/fixture/start/routes.ts:17-24`).

## Opciones de solución (con trada-offs)

1. **Aserción por contenido en HTTP** (recomendada): ejerce ALS + adapter + pool reales bajo
   concurrencia. Es la prueba más cercana a producción.
2. **Stress de contexto ALS**: inyectar `await`/emitters/`setImmediate` en el handler para intentar
   romper la propagación del contexto. Complementa (1); más difícil de hacer determinista.
3. **Aserción a nivel DB con `tenancy.run()` concurrente**: más barato pero no ejerce HttpContext.
   Útil como capa extra, no como sustituto.
