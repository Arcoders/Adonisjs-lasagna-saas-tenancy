# Informe de preparación para el release 1.0.0

**Paquete:** `@adonisjs-lasagna/saas-tenancy` + satélites (`admin`, `sso`, `billing`, `backup`)
**Fecha:** 2026-06-12
**Rama:** `LASAGNA-020626/isolation-hardening-and-benchmarks` (PR #10)
**Commits de remediación:** `98e3c44` · `2caed76` · `8170fe7` · `f885e99` (todos pusheados)
**Documentos hermanos:** [matrix.md](matrix.md), [findings.md](findings.md), [PRODUCTION_READINESS.md](../../benchmarks/PRODUCTION_READINESS.md)

---

## Veredicto

> ### El veredicto del audit pasa de **FIX AND RESUBMIT** a **SHIP**.
>
> Publicar como **core `1.0.0`** (etiquetado release-candidate, con la promesa semver
> acotada que documenta la página de estabilidad) y **satélites `0.1.0`** (experimental).
> Condición única pendiente: el run de CI sobre `f885e99` en verde.

El problema central que bloqueaba el 1.0 nunca fueron las primitivas (la criptografía
AES-256-GCM, el guard SSRF, el flujo OIDC y el pipeline de Stripe ya eran sólidos en el
audit original). Era que el paquete **conocía su postura segura y la dejaba opt-in**, y
que la versión, las etiquetas de estabilidad y los documentos de rendimiento no contaban
la misma historia. Las dos cosas están resueltas y, donde fue posible, **verificadas por
máquina, no por promesa**.

---

## Antes / después: cada default inseguro, cerrado

| Superficie | Antes (lo que encontró el audit) | Ahora (lo que se publica) |
|---|---|---|
| Custom domain | `strict: false` por defecto: un header `x-tenant-id` podía pisar un dominio verificado (vector de salto de tenant) | **`strict: true` por defecto**; header en conflicto → 400. `strict: false` es el opt-out documentado |
| `/metrics` | Público por defecto; filtraba enumeración de tenants y KPIs mientras el admin era fail-closed (inconsistencia interna) | **Fail-closed**: `multitenancyRoutes` lanza al boot sin `metricsMiddleware`; el bypass por array vacío también rechazado; opt-out solo con `false` explícito |
| Prueba RLS (rowscope-pg) | Se auto-saltaba en silencio si el rol bypasseaba RLS; la garantía central podía enviarse sin verificar | **Falla duro** cuando `RLS_DB_USER` está configurado y la prueba no puede ejecutarse |
| Binding de impersonation | Saltado bajo resolución por dominio (hueco con forma de estrategia) | Resuelve el id canónico vía `findByDomain` y aplica el check; **falla cerrado** ante error de lookup |
| `request.tenant()` | Servía tenants suspendidos/borrados en rutas sin guard (enforcement por convención) | **Fail-closed en ciclo de vida**: 403 antes de abrir conexión, incluso sin guard; `{ allowInactive: true }` es el opt-in explícito para flujos admin |
| Importador SQL | Continuaba tras fallos por defecto (import parcial silencioso); reescritura podía mutar literales sin avisar | **`strict` por defecto** (todo-o-nada con rollback); `--continue-on-error` es el opt-out; reescrituras dentro de literales se reportan como warnings |
| Versionado | Todo a `1.0.0` mientras los docs decían "experimental" / "RC" | **Satélites a `0.1.0`** (nunca se publicaron, cambio limpio); guard de CI que parsea stability.md e impide que etiqueta y versión vuelvan a divergir |
| Pipeline de release | `changeset publish` sin gate real sobre CI verde | **`workflow_run` + `conclusion == success`** sobre el commit exacto validado: publicar implica mecánicamente que la suite pasó |
| Documento de rendimiento | Se contradecía a sí mismo (aviso de corrección vs. TL;DR con ✅ confiados) | **Un documento coherente**: las tres afirmaciones desacreditadas son ⚠️ provisionales en todas partes hasta el run full-size de los tiers corregidos |
| Rotación de `APP_KEY` | Rotar la clave convertía cada secreto almacenado en un fallo permanente, sin herramienta | **`tenant:secrets:reencrypt`** (clave vieja por env, idempotente, `--dry-run`) + `decryptWithAppKey`/`decryptStrict`; runbook en la guía de seguridad |

---

## La infraestructura de honestidad (el diferencial real)

Lo más valioso del estado actual no es ninguna feature: es que el paquete **codifica su
propia honestidad como gates mecánicos**, algo raro en cualquier ecosistema.

- **Etiquetas ↔ versiones verificadas en CI.** `scripts/check-stability-versions.mjs`
  parsea la página de estabilidad: re-etiquetar sin re-versionar (o al revés) rompe el build.
- **El bench de aislamiento no puede certificar en vacío.** Self-test negativo cuyo
  contrato de salida es estricto (exit 1 solo si detectó las fugas plantadas en *todos*
  los escenarios) y un techo de tasa de errores (`errorRateCheck`) para que un run
  degradado a base de 503s no produzca un `PASS` vacío.
- **Postura fail-closed uniforme.** Admin, métricas, dominio custom, ciclo de vida del
  tenant, rate-limit ante caída de Redis, importador, prueba RLS, pipeline de publicación.
  Ya no existe la inconsistencia interna que un equipo de seguridad habría encontrado en
  cinco minutos.
- **Documentación que dice lo que NO está probado.** El assessment de rendimiento separa
  lo medido (overhead por request, ruta HTTP, cliff de conexión fría) de lo provisional
  (aislamiento bajo churn, cap bajo burst, planitud de catálogo) en lugar de mezclar ambos.

---

## Evidencia de que los gates funcionan

No es teórica: durante la propia remediación introduje una regresión real (el warning RLS
de rowscope dereferenciaba el servicio de logger eager durante el boot del provider, que
aún no existe en esa fase). **La cazó el bench de aislamiento por driver en CI** antes de
llegar a nadie, y el fix (`f885e99`) se verificó booteando el fixture bajo los tres
drivers. Un sistema de verificación que atrapa los errores de su propio proceso de
endurecimiento está haciendo exactamente su trabajo.

---

## Estado final de los hallazgos del audit

| ID | Hallazgo | Estado |
|---|---|---|
| P0-1 | Custom-domain `strict: false` por defecto | ✅ Cerrado (`98e3c44`) |
| P0-2 | `/metrics` público por defecto | ✅ Cerrado (`98e3c44`, bypass de array vacío incluido) |
| P0-3 | Prueba RLS se salta en silencio | ✅ Cerrado (`98e3c44`, falla duro con `RLS_DB_USER`) |
| P1-1 | Promesa de invalidación de cache no entregada (core-only) | ✅ Cerrado (doc corregida + contrato fijado por test) |
| P1-2 | Binding de impersonation saltado bajo dominio | ✅ Cerrado (`98e3c44`, 5 tests) |
| P1-3 | Versión 1.0.0 vs. etiqueta "experimental" | ✅ Cerrado (`8170fe7`, satélites 0.1.0 + guard CI) |
| P1-4 | Assessment de rendimiento auto-contradictorio | ✅ Cerrado (documento reconciliado; el doc commiteado, PRODUCTION_READINESS.md, ya era coherente) |
| P1-5 | rowscope-pg sin RLS = convención sin aviso | ✅ Cerrado (warning al boot + flag `rowScopeRls`; crash del logger corregido en `f885e99`) |
| P1-6 | Peers de core arrastrando deps de satélites | ✅ Verificado limpio (stripe ya era peer opcional; queue es import real) |
| P2-1 | Publish sin gate de CI verde | ✅ Cerrado (`8170fe7`, workflow_run) |
| P2-2 | Instancia de tenant cacheada mutable compartida | ✅ Contrato fijado por test + documentado (incluida la plantilla del generador, que había driftado) |
| P2-3 | `request.tenant()` no fail-closed en ciclo de vida | ✅ Cerrado (403 + opt-in explícito + tests de integración) |
| P2-4 | Cap blando puede agotar `max_connections` | ✅ Guía liderando scaling-limits + warning en el JSDoc del config |
| P2-5 | Gate agregado de cobertura decorativo | ✅ CI ya exportaba floors medidos (80/78/77); defaults del script alineados |
| P2-6 | Bench de aislamiento sin techo de errores; self-test vacuo | ✅ Cerrado (`errorRateCheck` + contrato estricto del self-test) |
| P2-7 | Importador SQL: default no-estricto + reescritura de literales | ✅ Cerrado (strict por defecto + warnings de literales) |
| P3-1 | Claim de shims sobrevendido en stability.md | ✅ Corregido (subpaths → shim; símbolos de barrel → eliminación) |
| P3-2 | Atribución de rate-limit colapsa a `global` | ✅ Cerrado (prefiere `tenancy.currentId()`; caveat de trustProxy documentado) |
| P3-3 | Sin tooling de rotación de claves | ✅ Cerrado (`tenant:secrets:reencrypt` + crypto utils) |
| P3-4 | Cuerpo de respuesta de webhook sin límite | ✅ Cerrado (truncado a 4 KB) |

---

## Riesgos residuales (vigilar, no bloquear)

1. **El singleton de config sobre `globalThis`.** Resuelve un problema real (dual-module
   build vs. src) y está bien comentado, pero algún día será un misterio de depuración de
   varias horas para quien no conozca la historia.
2. **Los dos caminos de resolución conviviendo.** El switch legacy síncrono más la chain
   async (`legacyAdapterFallback` incluido) es deuda que costará borrar; ya fue la raíz de
   la ambigüedad de atribución del rate-limit.
3. **El contrato de instancia compartida del cache.** Documentado y fijado por test, pero
   sigue siendo un footgun latente para quien active el cache sin leer.
4. **Factor de un solo mantenedor.** La página de estabilidad lo reconoce con honestidad;
   ninguna cantidad de tests lo sustituye.

## Lo que separa el core de `stable` (no es ingeniería)

1. **Revisión de seguridad externa independiente** del núcleo de aislamiento (lo hecho
   hasta ahora es auto-revisión interna profunda, y así está etiquetado).
2. **Kilometraje en producción real**: semanas de tráfico sin incidente de aislamiento.
3. **Run full-size de los tiers corregidos del bench** (`bench:isolation`,
   `connection_budget_burst`, catálogo vía `search_path`) con snapshot commiteado, para
   convertir las tres afirmaciones ⚠️ provisionales en medidas.

Los tres son gates de tiempo y de terceros, no huecos de diseño. El plan documentado
(promoción a `stable` dentro de la línea 1.x, sin major bump) es el correcto.

---

## Conclusión

Hace una semana esto era un buen motor con los seguros sin poner: primitivas sólidas,
defaults inseguros, y un relato (versión, etiquetas, benchmarks) que no cuadraba consigo
mismo. Hoy la postura por defecto, el versionado, la documentación y el pipeline dicen la
misma verdad, y buena parte de esa coherencia está vigilada por CI en lugar de depender de
disciplina. Para el ecosistema AdonisJS es, con toda probabilidad, el paquete de
multitenancy más rigurosamente verificado disponible. **Recomendación: publicar.**
