<script setup lang="ts">
import { ref } from 'vue'

interface Layer {
  id: string
  title: string
  subtitle: string
  href: string
  body: string
}

const layers: Layer[] = [
  {
    id: 'central',
    title: 'Central',
    subtitle: 'public schema',
    href: '/docs/concepts#_1-central',
    body:
      "Your application's own data: countries, plans, anything cross-tenant or product-wide. Models extend CentralBaseModel.",
  },
  {
    id: 'backoffice',
    title: 'Backoffice',
    subtitle: 'backoffice schema',
    href: '/docs/concepts#_2-backoffice',
    body:
      "Where operators live. Tenant registry, audit logs, webhook subscriptions, feature flags, branding, SSO configs, metrics. Models extend BackofficeBaseModel.",
  },
  {
    id: 'tenant',
    title: 'Tenant',
    subtitle: 'tenant_<uuid> schema',
    href: '/docs/concepts#_3-tenant',
    body:
      'Per-customer data. Each tenant gets its own PostgreSQL schema. Models extend TenantBaseModel — queries route automatically based on the active tenant context.',
  },
  {
    id: 'bootstrappers',
    title: 'Bootstrappers',
    subtitle: 'service-level scoping',
    href: '/docs/bootstrappers/',
    body:
      'Per-service hooks that enter when tenant context activates. Database, cache, drive, mail, session, broadcasting — each operates on the active tenant namespace, no tenantId threading.',
  },
  {
    id: 'satellites',
    title: 'Satellites',
    subtitle: 'opt-in features',
    href: '/docs/satellites/',
    body:
      'Audit, feature flags, webhooks, branding, SSO, metrics, quotas, impersonation. None required — opt in via the configure command.',
  },
]

const active = ref<string>('tenant')

function select(id: string, event: Event) {
  active.value = id
  // Allow clicks via keyboard Enter to navigate too
  if (event instanceof KeyboardEvent && event.key === 'Enter') {
    const layer = layers.find((l) => l.id === id)
    if (layer) window.location.href = layer.href
  }
}
</script>

<template>
  <div class="lg-layerstack" role="region" aria-label="Lasagna layered architecture">
    <div class="lg-layerstack__stack">
      <a
        v-for="layer in layers"
        :key="layer.id"
        :href="layer.href"
        class="lg-layerstack__layer"
        :class="{ 'lg-layerstack__layer--active': active === layer.id }"
        :aria-current="active === layer.id ? 'true' : undefined"
        @mouseenter="active = layer.id"
        @focus="active = layer.id"
        @click="select(layer.id, $event)"
        @keydown.enter="select(layer.id, $event)"
      >
        <span class="lg-layerstack__layer-title">{{ layer.title }}</span>
        <span class="lg-layerstack__layer-subtitle">{{ layer.subtitle }}</span>
      </a>
    </div>

    <div class="lg-layerstack__detail" aria-live="polite">
      <h3 class="lg-layerstack__detail-title">
        {{ layers.find((l) => l.id === active)?.title }}
      </h3>
      <p class="lg-layerstack__detail-subtitle">
        {{ layers.find((l) => l.id === active)?.subtitle }}
      </p>
      <p class="lg-layerstack__detail-body">
        {{ layers.find((l) => l.id === active)?.body }}
      </p>
      <a
        :href="layers.find((l) => l.id === active)?.href"
        class="lg-layerstack__detail-link"
      >
        Read more →
      </a>
    </div>
  </div>
</template>

<style scoped>
.lg-layerstack {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1.5rem;
  margin: 1.5rem 0;
  padding: 1.5rem;
  border: 1px solid var(--lg-line);
  border-radius: 12px;
  background: var(--lg-surface);
}

@media (min-width: 720px) {
  .lg-layerstack {
    grid-template-columns: 0.85fr 1.15fr;
    align-items: stretch;
  }
}

.lg-layerstack__stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.lg-layerstack__layer {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 0.85rem 1rem;
  border: 1px solid var(--lg-line);
  border-left: 3px solid var(--lg-line-strong);
  border-radius: 8px;
  background: var(--lg-bg);
  color: var(--lg-text);
  text-decoration: none;
  transition:
    transform 200ms ease,
    border-left-color 200ms ease,
    background 200ms ease,
    opacity 200ms ease;
  opacity: 0.55;
}

.lg-layerstack__layer:hover,
.lg-layerstack__layer:focus-visible {
  outline: none;
  opacity: 1;
}

.lg-layerstack__layer--active {
  opacity: 1;
  border-left-color: var(--lg-accent);
  background: color-mix(in oklab, var(--lg-accent) 5%, var(--lg-bg));
  transform: translateX(2px);
}

.lg-layerstack__layer-title {
  font-family: var(--lg-font-serif);
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--lg-text);
}

.lg-layerstack__layer-subtitle {
  margin-top: 0.15rem;
  font-size: 0.8rem;
  color: var(--lg-text-muted);
  font-family: 'JetBrains Mono', monospace;
}

.lg-layerstack__detail {
  display: flex;
  flex-direction: column;
  padding: 1.25rem;
  border: 1px solid var(--lg-line);
  border-radius: 8px;
  background: var(--lg-bg);
}

.lg-layerstack__detail-title {
  margin: 0 0 0.15rem;
  font-family: var(--lg-font-serif);
  font-size: 1.4rem;
  font-weight: 600;
  color: var(--lg-accent);
}

.lg-layerstack__detail-subtitle {
  margin: 0 0 0.75rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.8rem;
  color: var(--lg-text-muted);
}

.lg-layerstack__detail-body {
  margin: 0 0 1rem;
  line-height: 1.6;
  color: var(--lg-text);
}

.lg-layerstack__detail-link {
  align-self: flex-start;
  color: var(--lg-accent);
  font-weight: 600;
  text-decoration: none;
}

.lg-layerstack__detail-link:hover {
  text-decoration: underline;
}

@media (prefers-reduced-motion: reduce) {
  .lg-layerstack__layer {
    transition: none;
  }
  .lg-layerstack__layer--active {
    transform: none;
  }
}
</style>
