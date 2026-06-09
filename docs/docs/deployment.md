---
title: Deployment
description: Docker Compose, Kubernetes via Helm, troubleshooting, and security hardening for production.
---

# Deployment

<Callout type="tip" title="Three target environments">

Single-VPS Docker Compose for staging or low-volume production,
Kubernetes via the bundled Helm chart for HA / multi-region, and a
shared *Security hardening* checklist for both.

</Callout>

This guide covers four targets:

1. **Docker Compose**; recommended for staging or low-volume
   production.
2. **Kubernetes via Helm**; recommended for multi-region or HA
   production.
3. **Troubleshooting**; common gotchas around replicas, sticky
   sessions, and cache coherency.
4. **Security hardening**; what the package guarantees, what you
   own, and what to do at the host level.

All artifacts referenced live under `deploy/` in the repo.

---

## 1. Docker Compose

### What you get

`deploy/docker-compose.prod.yml` brings up:

| Service             | Image                    | Notes                                      |
|---------------------|--------------------------|--------------------------------------------|
| `postgres-primary`  | `postgres:16-alpine`     | `wal_level=replica`, replication user      |
| `postgres-replica`  | `postgres:16-alpine`     | Streaming replica, hot standby             |
| `redis`             | `redis:7-alpine`         | Password-protected, AOF persistence        |
| `app` (×3)          | Built from `deploy/Dockerfile` | Health checks against `/readyz`      |
| `nginx`             | `nginx:1.27-alpine`      | Reverse proxy, JSON access logs            |

### Prerequisites

- Docker 24+ (compose v2)
- ~3 GB RAM available

### First boot

```bash
# 1. Copy and fill env vars
cp deploy/docker-compose.prod.example.env .env
$EDITOR .env  # populate APP_KEY, DB credentials, REDIS_PASSWORD

# 2. Bring everything up
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d

# 3. Run package migrations the first time
docker compose -f deploy/docker-compose.prod.yml exec app node ace backoffice:setup

# 4. Verify
curl -i http://localhost/healthz
docker compose -f deploy/docker-compose.prod.yml exec app node ace tenant:doctor
```

### Subsequent deploys

```bash
docker compose -f deploy/docker-compose.prod.yml build app
docker compose -f deploy/docker-compose.prod.yml up -d --no-deps app
```

The compose file declares `replicas: 3` so a rolling update keeps at
least one app pod serving traffic.

---

## 2. Kubernetes (Helm)

### What you get

The chart at `deploy/charts/lasagna-app/` renders:

- `Deployment` with rolling updates (`maxUnavailable: 0`)
- `Service` (ClusterIP)
- Optional `Ingress` with wildcard support for the subdomain
  resolver
- Optional `HorizontalPodAutoscaler` (CPU + memory)
- `PodDisruptionBudget` (default: `minAvailable: 1`)
- `Secret` (if not using `app.existingSecret`)

The chart **does not** provision Postgres or Redis; wire those to
managed services (RDS, ElastiCache, Cloud SQL, Memorystore, etc.) via
values.

### Quick install

```bash
helm install acme deploy/charts/lasagna-app \
  --namespace lasagna --create-namespace \
  -f deploy/charts/lasagna-app/values.production.yaml \
  --set image.tag=v2.0.0 \
  --set app.secrets.APP_KEY="$(openssl rand -hex 32)" \
  --set app.secrets.DB_HOST=pg.acme.internal \
  --set app.secrets.DB_USER=lasagna \
  --set app.secrets.DB_PASSWORD="$DB_PASSWORD" \
  --set app.secrets.DB_DATABASE=lasagna_prod \
  --set app.secrets.REDIS_HOST=redis.acme.internal \
  --set app.secrets.REDIS_PASSWORD="$REDIS_PASSWORD"
```

### Wildcard subdomains

When the package's `resolverStrategy` is `subdomain`, you need:

1. **Wildcard DNS:** an `A`/`AAAA` record for `*.app.example.com`
   pointing at the ingress controller's public IP.
2. **Wildcard cert:** request via `cert-manager` with a DNS-01
   issuer. HTTP-01 cannot validate wildcards.
3. **Ingress hosts:** include both apex and wildcard:

   ```yaml
   ingress:
     hosts:
       - host: app.example.com
       - host: "*.app.example.com"
     tls:
       - hosts: [app.example.com, "*.app.example.com"]
         secretName: app-example-com-tls
   ```

### Existing secrets

In production, never inline secret values into Helm. Use
[external-secrets-operator](https://external-secrets.io/) or
[sealed-secrets](https://github.com/bitnami-labs/sealed-secrets) and
reference an existing `Secret`:

```yaml
app:
  existingSecret: lasagna-app-secrets
```

---

## 3. Troubleshooting

### "Cache invalidation drifts between pods"

The package's tenant resolution is cached via BentoCache. Caches
default to **per-process** memory unless you wire a Redis store.
With multiple pods, you must point BentoCache at Redis (or another
shared store); otherwise pod A invalidates a tenant and pod B keeps
serving stale data.

Check `config/multitenancy.ts`: the `cache.redis` block must point
at the same Redis instance every pod can reach.

### "Subdomain requests come in with the wrong tenant after deploy"

Likely sticky session mismatch. If you're using sub-domain routing
AND your app holds in-memory state per tenant (you shouldn't, but it
happens), the load balancer needs to send the same subdomain to the
same pod. Configure nginx with `hash $http_host consistent` or add
`nginx.ingress.kubernetes.io/upstream-hash-by` annotation.

The right fix is usually to remove the in-memory state; the package
is designed to be stateless across pods.

### "Doctor reports `replica_lag_high` after deploy"

Streaming replication takes a few seconds to catch up after WAL
writes. If the lag persists for more than 30 s under steady traffic:

1. Check `pg_stat_replication` on the primary; is `state =
   streaming`?
2. Network: replica → primary path may be saturated. The replica
   needs a low-latency, high-bandwidth connection.
3. The replica may not have enough RAM to apply WAL; check
   `oom_score` and `top`.

Adjust thresholds in `config/multitenancy.ts`:

```ts
doctor: {
  replicaLagWarnSeconds: 60,
  replicaLagErrorSeconds: 300,
}
```

### "Deploy succeeds but `/readyz` returns 503"

Inspect `node ace tenant:doctor --json`; it runs the same checks
`/readyz` aggregates. Common causes:

- DB credentials wrong (read replica check fails).
- Redis unreachable (queue check fails).
- Pending migrations (migration_state check fails).

### "Backups don't run / S3 uploads fail"

The runtime image installs `pg_dump` (`postgresql-client` package)
so the `tenant_backup` commands work. Verify with
`docker exec CONTAINER which pg_dump`. For S3:

- AWS region + bucket must match.
- The pod's IAM role (or `AWS_ACCESS_KEY_ID` env) needs
  `s3:PutObject` on the bucket.
- Network: pods need NAT to `s3.<region>.amazonaws.com`.

### "Helm template renders but `kubectl apply` fails"

Run `helm lint` first. If lint passes but the apiserver rejects the
manifests, your cluster may be on an older API version. The chart
targets:

- `apps/v1` Deployment
- `policy/v1` PodDisruptionBudget (Kubernetes 1.21+)
- `autoscaling/v2` HPA (Kubernetes 1.23+)
- `networking.k8s.io/v1` Ingress (Kubernetes 1.19+)

Cluster older than 1.23? Stay on chart `0.0.x` releases.

---

## 4. Security hardening

### What the package guarantees

The following invariants are enforced inside the package and covered
by tests. You can rely on them without extra wiring.

#### Tenant identifier validation

Every code path that consumes a tenant id (SQL DDL, Drive prefix,
cache namespace, session key, mail header, broadcast channel) routes
through `assertSafeIdentifier()` before the value reaches a
sensitive sink. The contract is:

- Length ≤ 63 (PostgreSQL `NAMEDATALEN - 1`).
- Character class: `[a-zA-Z0-9_-]` only.
- UUID v4 always passes; the canonical id format the package
  generates is RFC-4122 v4 from `node:crypto.randomUUID()`.

Anything else; `..`, `/`, `\`, `;`, `"`, whitespace, shell
metacharacters, percent-encoded sequences; is rejected with a
`Refusing to use unsafe …` exception. There is no escape hatch and
no per-tenant override.

`resolveTenantId()` additionally validates the canonical UUID v4
format before any cache or DB access keyed by the resolved id.

#### SQL injection

Tenant ids are interpolated only into quoted identifier slots
(`"tenant_<uuid>"`) and only after passing `assertSafeIdentifier`.
Tenant metadata, names, emails, and other free-form fields are
written via Lucid's parameterized queries. Search the codebase for
`rawQuery(`; every usage is either a constant string or
interpolates a value that has been hard-validated as a safe
identifier first.

#### HMAC-signed tokens

`ImpersonationService` and `WebhookService` both:

- Sign with HMAC-SHA256 over a fixed-size payload.
- Verify with `crypto.timingSafeEqual()` to defeat timing-based
  oracle attacks.
- Refuse to issue when the configured secret is shorter than 32
  chars.

The impersonation secret is also validated at provider boot; a
misconfigured deploy fails fast on startup, not on the first admin
request.

#### Webhook delivery

Outbound webhooks include `x-webhook-signature: sha256=<hex>`
computed over the raw body using the per-subscription secret. The
secret is encrypted at rest with `AES-256-GCM` keyed by `APP_KEY`.

#### SSO / OIDC

`SsoService.handleCallback()` performs full OIDC verification:

1. State is generated with `randomBytes(16)`, single-use, 600 s
   TTL.
2. Nonce is generated with `randomBytes(16)`, bound to the state,
   included as a parameter on the auth URL.
3. The token endpoint must return an `id_token`.
4. The `id_token` is verified against the IdP's JWKS (fetched via
   discovery + cached 1 h).
5. `iss`, `aud`, and `exp` are checked by `jose.jwtVerify` (60 s
   clock tolerance).
6. `nonce` in the `id_token` payload must match the value bound to
   state.

Any mismatch throws and aborts the callback before claims are
surfaced.

#### Tenant enumeration

`TenantNotFoundException` is the same exception path whether the
tenant literally does not exist or the request was unauthorized for
an existing tenant. There is no observable difference in the
response that lets an attacker enumerate ids, names, or domains.

#### Cache, Drive, session, mail prefixing

Every per-tenant key is namespaced with `tenants/<tenant.id>/`
(Drive, session) or a dedicated cache namespace (`branding`, `sso`,
`oidc:discovery`, …). Identifiers pass `assertSafeIdentifier` before
forming the key.

### What the host application owns

These surfaces are production-required and need to be configured at
the host level; the package neither does nor can.

#### Transport hardening

- **HSTS**: serve `Strict-Transport-Security: max-age=31536000;
  includeSubDomains` from the AdonisJS server. Subdomain-based
  tenant resolution amplifies the cost of any single TLS lapse.
- **TLS termination**: terminate at the load balancer / Ingress, not
  the Node process. The Helm chart in this repo configures
  `nginx.ingress.kubernetes.io/ssl-redirect: "true"` by default.

#### Response headers (recommended)

Add a small middleware in the host app that sets:

```ts
// app/middleware/security_headers_middleware.ts
export default class SecurityHeadersMiddleware {
  async handle(ctx, next) {
    ctx.response.header('x-content-type-options', 'nosniff')
    ctx.response.header('x-frame-options', 'DENY')
    ctx.response.header('referrer-policy', 'strict-origin-when-cross-origin')
    ctx.response.header(
      'permissions-policy',
      'geolocation=(), microphone=(), camera=()'
    )
    ctx.response.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'"
    )
    await next()
  }
}
```

Register it as global in `start/kernel.ts`. The package itself does
not enforce CSP because content sources vary per tenant.

#### Webhook receivers

The package signs outbound webhooks; receivers must:

- Verify the signature with their configured secret using a
  constant-time comparison.
- Apply rate-limiting at the receiver; the package times out at 10
  s but does not throttle per-endpoint outbound requests.
- Reject requests older than a small window (use the
  `x-webhook-delivery-id` plus a database log on the receiver to
  defeat replay).

#### Admin REST API

`/admin/multitenancy/*` routes are gated only by an `x-admin-token`
header checked against `config.adminToken`. The package does **not**
add IP allow-listing, mTLS, or auth integration. In production:

- Restrict the route group to a private network.
- Or, if exposed publicly, layer the host app's auth (Bouncer /
  Auth) in front of the admin route group via
  `Route.group(...).use([...])`.

#### Database credentials

Tenant DB credentials live in the host app's environment. They are
NEVER logged by the package; verified by spot-check on
`logger.info`, `console.log`, `JSON.stringify`. Avoid committing them
to the repo; use a secret manager (Vault, AWS Secrets Manager, GCP
Secret Manager, k8s sealed-secrets).

### Operational hardening

#### CI gates that ship with this repo

`.github/workflows/ci.yml` enforces on every PR:

- `npm run typecheck`
- `npm run knip`; surfaces unused exports / orphaned files.
- `npm run audit:prod`; fails on production-dep advisories of
  severity `high` or higher.
- Unit + integration tests against real PostgreSQL + Redis.
- Demo app E2E suite with all bootstrappers (mail, queue, drive)
  wired.

Mirror the equivalent gates in your downstream CI before publishing
container images.

#### Recommended runtime monitoring

- **Prometheus**: scrape `/metrics`. Alert on
  `multitenancy_circuit_state{state="OPEN"}`,
  `multitenancy_provisioning_failures_total`, and replica-lag
  exceeding threshold.
- **OpenTelemetry**: the package ships spans for every tenant-scoped
  DB query, queue dispatch, and bootstrapper enter/leave. Forward to
  your APM and alert on per-tenant latency outliers; they tend to
  predict cache stampedes and connection pool exhaustion.
- **Audit log**: enable the `audit` satellite (`node ace configure
  @adonisjs-lasagna/saas-tenancy --with=audit`) and ship the
  `tenant_audit_logs` table to a long-term store. The admin REST API
  exposes a `from`/`to` date-range query that uses an index on
  `(tenant_id, created_at)` instead of OFFSET.

#### Backup and recovery

`tenant:backup` writes a `.dump` file plus a JSON sidecar with
checksums. For production:

- Mirror to S3 with `config.backup.s3.enabled = true`. The bucket
  SHOULD have versioning enabled and a lifecycle policy that defers
  permanent delete behind your retention tier.
- Run `tenant:doctor --check=backups` weekly; it flags tenants
  whose last successful backup is older than the retention tier's
  `intervalHours`.
- Practice restore at least quarterly.
  `tenant:restore --tenant=ID --file=PATH` round-trips the schema;
  verify the row count matches the source.

### Reporting a vulnerability

Security issues should not be reported as public GitHub issues.
Email the maintainer at the address listed in `package.json`
`author`. Include:

- Affected version (`package.json` `version`).
- Reproduction steps and a proof-of-concept payload if possible.
- Impact assessment (confidentiality, integrity, availability).

Acknowledged reports get a CVE assignment and a coordinated release.

---

## Reference: env vars consumed

| Var | Source | Purpose |
|---|---|---|
| `APP_KEY` | secret | Adonis app secret (signing/encryption) |
| `DB_HOST` / `DB_PORT` | secret | Postgres primary |
| `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | secret | Connection credentials |
| `DB_REPLICA_HOST` | secret (optional) | Read replica for `tenantReadReplicas` |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | secret | Cache + queue + impersonation store |
| `TENANT_HEADER_KEY` | env | Header consulted by `header` resolver |
| `BASE_DOMAIN` | env | Apex used by `subdomain` resolver |
| `RESOLVER_STRATEGY` | env | One of `subdomain` / `header` / `path` / `domain-or-subdomain` / `request-data` |
| `LOG_LEVEL` | env | Adonis pino level |

The exact mapping into your `config/multitenancy.ts` is up to your
app; these are conventions used by the deploy artifacts here.

## Read next

- [Production checklist](/docs/production-checklist); the pre-flight list and runbook.
- [Security](/security); what the package guarantees and what you own.
- [Health & monitoring](/docs/health); the probes and metrics to wire up.
