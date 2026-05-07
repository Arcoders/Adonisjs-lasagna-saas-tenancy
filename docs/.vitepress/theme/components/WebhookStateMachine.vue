<script setup lang="ts">
// Pure SVG state machine. No runtime deps.
// Five states: pending → delivering → delivered / failed → retry_scheduled (loop) / permanently_failed
</script>

<template>
  <figure class="lg-fsm" role="img" aria-labelledby="lg-fsm-title">
    <figcaption id="lg-fsm-title" class="lg-fsm__caption">
      Webhook delivery state machine
    </figcaption>

    <svg
      viewBox="0 0 760 320"
      xmlns="http://www.w3.org/2000/svg"
      preserveAspectRatio="xMidYMid meet"
      class="lg-fsm__svg"
    >
      <defs>
        <marker
          id="lg-fsm-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      <!-- States -->
      <g class="lg-fsm__states">
        <g transform="translate(40 130)">
          <rect width="120" height="60" rx="10" class="lg-fsm__node" />
          <text x="60" y="36" text-anchor="middle" class="lg-fsm__label">pending</text>
        </g>

        <g transform="translate(220 130)">
          <rect width="130" height="60" rx="10" class="lg-fsm__node" />
          <text x="65" y="36" text-anchor="middle" class="lg-fsm__label">delivering</text>
        </g>

        <g transform="translate(420 30)">
          <rect width="130" height="60" rx="10" class="lg-fsm__node lg-fsm__node--good" />
          <text x="65" y="36" text-anchor="middle" class="lg-fsm__label">delivered</text>
        </g>

        <g transform="translate(420 230)">
          <rect width="130" height="60" rx="10" class="lg-fsm__node lg-fsm__node--warn" />
          <text x="65" y="36" text-anchor="middle" class="lg-fsm__label">failed</text>
        </g>

        <g transform="translate(610 230)">
          <rect width="130" height="60" rx="10" class="lg-fsm__node lg-fsm__node--bad" />
          <text x="65" y="22" text-anchor="middle" class="lg-fsm__label">permanently</text>
          <text x="65" y="44" text-anchor="middle" class="lg-fsm__label">failed</text>
        </g>

        <g transform="translate(220 230)">
          <rect width="180" height="60" rx="10" class="lg-fsm__node lg-fsm__node--accent" />
          <text x="90" y="36" text-anchor="middle" class="lg-fsm__label">retry_scheduled</text>
        </g>
      </g>

      <!-- Edges -->
      <g class="lg-fsm__edges" fill="none" stroke="currentColor">
        <!-- pending → delivering -->
        <path d="M 160 160 L 220 160" marker-end="url(#lg-fsm-arrow)" />

        <!-- delivering → delivered (top right) -->
        <path
          d="M 350 150 C 410 130, 410 90, 420 70"
          marker-end="url(#lg-fsm-arrow)"
        />
        <text x="395" y="100" class="lg-fsm__edge-label">2xx</text>

        <!-- delivering → failed (bottom right) -->
        <path
          d="M 350 170 C 410 190, 410 230, 420 250"
          marker-end="url(#lg-fsm-arrow)"
        />
        <text x="395" y="230" class="lg-fsm__edge-label">non-2xx</text>

        <!-- failed → retry_scheduled -->
        <path d="M 420 260 L 400 260" marker-end="url(#lg-fsm-arrow)" />
        <text x="408" y="252" class="lg-fsm__edge-label">retries left</text>

        <!-- failed → permanently_failed -->
        <path d="M 550 260 L 610 260" marker-end="url(#lg-fsm-arrow)" />
        <text x="582" y="252" class="lg-fsm__edge-label">no retries</text>

        <!-- retry_scheduled → delivering (loop back, up) -->
        <path
          d="M 310 230 C 290 200, 285 195, 285 190"
          marker-end="url(#lg-fsm-arrow)"
        />
        <text x="245" y="216" class="lg-fsm__edge-label">backoff elapsed</text>
      </g>
    </svg>
  </figure>
</template>

<style scoped>
.lg-fsm {
  margin: 1.5rem 0;
  padding: 1.25rem 1rem 0.5rem;
  border: 1px solid var(--lg-line);
  border-radius: 12px;
  background: var(--lg-surface);
  color: var(--lg-text-muted);
}

.lg-fsm__caption {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: var(--lg-text-muted);
  margin-bottom: 0.25rem;
}

.lg-fsm__svg {
  width: 100%;
  height: auto;
  font-family: 'Inter', system-ui, sans-serif;
}

.lg-fsm__node {
  fill: var(--lg-bg);
  stroke: var(--lg-line-strong);
  stroke-width: 1.5;
}

.lg-fsm__node--good {
  fill: color-mix(in oklab, var(--lg-accent-2) 14%, var(--lg-bg));
  stroke: var(--lg-accent-2);
}

.lg-fsm__node--warn {
  fill: color-mix(in oklab, var(--lg-accent-3) 18%, var(--lg-bg));
  stroke: var(--lg-accent-3);
}

.lg-fsm__node--bad {
  fill: color-mix(in oklab, var(--lg-accent) 16%, var(--lg-bg));
  stroke: var(--lg-accent);
}

.lg-fsm__node--accent {
  fill: color-mix(in oklab, var(--lg-accent-4) 14%, var(--lg-bg));
  stroke: var(--lg-accent-4);
}

.lg-fsm__label {
  font-size: 13px;
  font-weight: 500;
  fill: var(--lg-text);
}

.lg-fsm__edges {
  color: var(--lg-line-strong);
  stroke-width: 1.4;
}

.lg-fsm__edge-label {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  fill: var(--lg-text-muted);
  stroke: none;
}
</style>
