<script setup lang="ts">
import { computed, ref } from 'vue'
import { useData } from 'vitepress'

const { page, frontmatter } = useData()
const submitted = ref<'up' | 'down' | null>(null)
const note = ref('')
const sent = ref(false)
const error = ref<string | null>(null)

// Configure at build time:
//   VITE_FEEDBACK_URL=https://feedback.workers.dev/lasagna
// Without it the widget is still rendered but the POST is a no-op.
const endpoint = import.meta.env.VITE_FEEDBACK_URL as string | undefined

const path = computed(() => page.value.relativePath)
const title = computed(
  () => (frontmatter.value as { title?: string }).title ?? page.value.title
)

async function vote(verdict: 'up' | 'down') {
  submitted.value = verdict
  if (verdict === 'up') void send({})
}

async function sendWithNote() {
  await send({ note: note.value })
  sent.value = true
}

async function send(extra: Record<string, unknown>) {
  if (!endpoint) {
    sent.value = true
    return
  }
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: path.value,
        title: title.value,
        verdict: submitted.value,
        userAgent: navigator.userAgent,
        ...extra,
      }),
      keepalive: true,
    })
  } catch (err) {
    error.value = (err as Error).message
  }
}
</script>

<template>
  <section class="lg-feedback" aria-labelledby="lg-feedback-title">
    <h3 id="lg-feedback-title" class="lg-feedback__title">
      Was this page helpful?
    </h3>

    <div v-if="!submitted" class="lg-feedback__buttons">
      <button
        type="button"
        class="lg-feedback__btn"
        @click="vote('up')"
        aria-label="Yes, this page was helpful"
      >
        Yes
      </button>
      <button
        type="button"
        class="lg-feedback__btn"
        @click="vote('down')"
        aria-label="No, this page needs improvement"
      >
        Not really
      </button>
    </div>

    <div v-else-if="submitted === 'up' && !sent" class="lg-feedback__thanks">
      Thanks — recorded.
    </div>

    <div v-else-if="submitted === 'down' && !sent" class="lg-feedback__form">
      <label for="lg-feedback-note" class="lg-feedback__label">
        What was missing or unclear? (optional)
      </label>
      <textarea
        id="lg-feedback-note"
        v-model="note"
        class="lg-feedback__textarea"
        rows="3"
        placeholder="Tell us where this page could be sharper…"
      />
      <div class="lg-feedback__form-actions">
        <button type="button" class="lg-feedback__btn" @click="sendWithNote">
          Send
        </button>
      </div>
    </div>

    <div v-else class="lg-feedback__thanks">
      Thanks — your note helps shape the next iteration.
    </div>

    <p v-if="error" class="lg-feedback__error">
      Couldn't reach the feedback endpoint. Open an issue on GitHub instead.
    </p>
  </section>
</template>

<style scoped>
.lg-feedback {
  margin: 3rem 0 0;
  padding: 1.25rem 1.5rem;
  border-top: 1px solid var(--lg-line);
  border-bottom: 1px solid var(--lg-line);
  background: color-mix(in oklab, var(--lg-accent) 4%, var(--lg-bg));
  border-radius: 0;
}

.lg-feedback__title {
  margin: 0 0 0.65rem;
  font-family: var(--lg-font-serif);
  font-size: 1rem;
  font-weight: 600;
  color: var(--lg-text);
}

.lg-feedback__buttons,
.lg-feedback__form-actions {
  display: flex;
  gap: 0.5rem;
}

.lg-feedback__btn {
  appearance: none;
  background: var(--lg-bg);
  border: 1px solid var(--lg-line-strong);
  color: var(--lg-text);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 0.85rem;
  font-weight: 500;
  padding: 0.45rem 1rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background 200ms ease, border-color 200ms ease;
}

.lg-feedback__btn:hover {
  background: color-mix(in oklab, var(--lg-accent) 14%, var(--lg-bg));
  border-color: var(--lg-accent);
  color: var(--lg-accent);
}

.lg-feedback__thanks {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  color: var(--lg-text-muted);
}

.lg-feedback__form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.lg-feedback__label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: var(--lg-text-muted);
}

.lg-feedback__textarea {
  width: 100%;
  padding: 0.5rem 0.65rem;
  background: var(--lg-bg);
  border: 1px solid var(--lg-line);
  border-radius: 6px;
  color: var(--lg-text);
  font-family: 'Inter', system-ui, sans-serif;
  font-size: 0.85rem;
  resize: vertical;
}

.lg-feedback__textarea:focus {
  outline: 2px solid var(--lg-accent);
  outline-offset: 2px;
  border-color: var(--lg-accent);
}

.lg-feedback__error {
  margin: 0.5rem 0 0;
  color: var(--lg-accent);
  font-size: 0.82rem;
}
</style>
