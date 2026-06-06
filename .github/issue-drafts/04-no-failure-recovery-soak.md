# Cero pruebas de soak / fallo / recuperación

**Labels:** `area/benchmarks`, `area/resilience`, `kind/gap`, `priority/blocker-1.0`

## Resumen

El benchmark sólo mide estado estable y feliz, en corridas cortísimas (HTTP = 10 s por escenario).
No hay pruebas de larga duración (soak), ni de inyección de fallos (Redis caído, Postgres al límite
de conexiones), ni de recuperación. El informe reconoce ruido y `fsync=off`, pero no la ausencia de
soak/fallo, y aun así concluye "production-ready".

## Evidencia (archivo:línea)

- Duración HTTP por escenario = 10 s (5 s en CI): `benchmarks/src/harness/config.ts:50`.
- No existe ningún tier de soak ni de resiliencia en `benchmarks/` (sólo micro/db/http/mem).
- Política de fallo del core que conviene asertar (hoy sin test de benchmark):
  - rate-limit fail-closed por defecto → 503 si Redis cae: `packages/core/src/middleware/rate_limit_middleware.ts:83-92`.
  - `ResilienceService` fail-closed → 503: `packages/core/src/services/resilience_service.ts:42-56`.

## Por qué bloquea 1.0

"Production-ready" sin evidencia de comportamiento a las horas/días ni bajo fallo de dependencias es
una afirmación sin respaldo. Los problemas reales de un sistema multi-tenant (leaks de memoria/fd,
crecimiento de backends, degradación, comportamiento ante Redis/PG caídos) aparecen justo en lo que
no se mide.

## Criterios de aceptación

- [ ] Existe un modo soak (`bench:soak`) que corre el workload churn+HTTP durante `BENCH_SOAK_HOURS`
      y registra una serie temporal de RSS/heap/external/pgBackends/fds.
- [ ] El soak emite `soakStableCheck`: FAIL si la pendiente de RSS supera un umbral sostenido o si
      `pgBackends` crece sin techo.
- [ ] Existe un modo resiliencia (`bench:resilience`) que tira Redis y Postgres (vía `docker stop/start`)
      y asevera la política de fallo real por dependencia + `recoveredWithinMs`.
- [ ] Redis caído en la ruta rate-limited produce **503** (no 200 silencioso fail-open, no cuelgue),
      y se recupera al volver Redis.
- [ ] El comportamiento de PG caído en la ruta de tenant queda documentado (hoy: 500 Lucid, no 503).

## ✅ Hallazgo del bench de resiliencia — fail-open en rate-limit (CORREGIDO)

> **Estado: corregido.** Fix en `packages/core/src/middleware/rate_limit_middleware.ts`
> (detecta resultados nulos / errores por-comando / zcard no numérico tras `exec()` y
> aplica la política de fallo). Tests añadidos en
> `packages/core/tests/unit/middleware/rate_limit_middleware.spec.ts`
> (resolved-with-errors → fail-closed por defecto; fail-open solo con `failOpen:true`).
> El bench de resiliencia ahora reporta `503 / PASS` en el escenario Redis-down.

Al implementar B-5 y correrlo con Redis caído, el rate-limit **falló ABIERTO**: con Redis
inalcanzable (ECONNREFUSED confirmado), `GET /ratelimited/notes` devolvió **200**, no el
**503** documentado (`failOpen=false` por defecto).

Causa raíz (`packages/core/src/middleware/rate_limit_middleware.ts:81-82`):

```js
const results = await pipeline.exec()
count = (results?.[2]?.[1] as number) ?? 0
```

`ioredis.pipeline().exec()` **resuelve** con tuplas `[error, result]` por comando en vez de
**rechazar** cuando el backend falla. Así que el `try/catch` (línea 83) no se dispara, `count`
cae a `0`, queda por debajo del límite y la request **se permite**. El `failOpen=false` nunca
entra en juego en una caída de Redis: la política documentada de fail-closed no se cumple.

Reproducción (antes del fix): `BENCH_RESILIENCE=1 npm run bench:resilience` → `observedStatus: 200`,
`policyObserved: FAIL-OPEN`, `failPolicyCheck: FAIL`.

**Fix aplicado (core):** tras `pipeline.exec()`, si el resultado es nulo, trae algún error
por-comando (`results.find(([err]) => err)`), o el `zcard` no es numérico, se lanza el error
→ el `catch` aplica la política (`failOpen` → `next()`; por defecto → `503`). Así el
fail-closed documentado se cumple de verdad ante una caída de Redis.

## Benchmark(s) que lo cierran

B-4 (soak con serie temporal + `soakStableCheck`) y B-5 (inyección de fallos + recuperación,
que descubrió el fail-open de arriba).

## Opciones de solución (con trade-offs)

1. **Soak corto en CI por schedule + soak largo on-demand** (recomendado): cobertura continua barata
   + capacidad de correr 24 h/7 d cuando haga falta.
2. **Resiliencia con contenedores manuales en CI**: necesario porque los *service containers* de
   GitHub no se controlan (`stop/start`) fácilmente; añade complejidad al workflow.
3. **Inyección de fallos a nivel app (stubs)** en vez de matar contenedores: más determinista pero
   menos realista; útil como complemento unitario, no sustituye al e2e con contenedores.
