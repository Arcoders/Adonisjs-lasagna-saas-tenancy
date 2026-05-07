<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { withBase } from 'vitepress'

interface CastFrame {
  /**
   * `prompt` — render the prompt then await a keystroke (auto-resolved).
   * `type`   — type the value into the buffer character by character.
   * `output` — append output without typing.
   * `wait`   — pause for `ms` before the next frame.
   * `clear`  — empty the visible buffer.
   */
  kind: 'prompt' | 'type' | 'output' | 'wait' | 'clear'
  value?: string
  ms?: number
}

interface Cast {
  title?: string
  prompt?: string
  cps?: number
  frames: CastFrame[]
}

const props = defineProps<{
  src: string
  height?: string
}>()

const cast = ref<Cast | null>(null)
const buffer = ref<string>('')
const playing = ref(false)
const finished = ref(false)
const reducedMotion = ref(false)
const error = ref<string | null>(null)

let abortController: AbortController | null = null

const visibleBuffer = computed(() => buffer.value)

async function load() {
  try {
    // Absolute repo paths (e.g. "/casts/foo.cast.json") need the
    // VitePress base prepended; otherwise they hit the apex domain
    // when the site is hosted under a project-pages subpath.
    // Fully-qualified URLs are left as-is.
    const url = /^https?:\/\//i.test(props.src) ? props.src : withBase(props.src)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    cast.value = (await res.json()) as Cast
  } catch (err) {
    error.value = (err as Error).message
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}

async function play() {
  if (!cast.value || playing.value) return
  playing.value = true
  finished.value = false
  buffer.value = ''
  abortController = new AbortController()
  const signal = abortController.signal
  const cps = cast.value.cps ?? 35
  const charDelay = reducedMotion.value ? 0 : Math.max(1, Math.round(1000 / cps))
  const promptText = cast.value.prompt ?? '✦ '

  try {
    for (const frame of cast.value.frames) {
      if (signal.aborted) return
      if (frame.kind === 'prompt') {
        buffer.value += promptText
      } else if (frame.kind === 'type' && frame.value) {
        if (reducedMotion.value) {
          buffer.value += frame.value + '\n'
        } else {
          for (const ch of frame.value) {
            if (signal.aborted) return
            buffer.value += ch
            await sleep(charDelay, signal)
          }
          buffer.value += '\n'
        }
      } else if (frame.kind === 'output' && frame.value) {
        buffer.value += frame.value + '\n'
      } else if (frame.kind === 'wait') {
        const wait = reducedMotion.value ? 0 : (frame.ms ?? 200)
        if (wait > 0) await sleep(wait, signal)
      } else if (frame.kind === 'clear') {
        buffer.value = ''
      }
    }
    finished.value = true
  } catch (err) {
    if ((err as DOMException).name !== 'AbortError') throw err
  } finally {
    playing.value = false
    abortController = null
  }
}

function replay() {
  if (abortController) abortController.abort()
  buffer.value = ''
  finished.value = false
  void play()
}

function skip() {
  if (!cast.value) return
  if (abortController) abortController.abort()
  // Render the final frame state synchronously
  const promptText = cast.value.prompt ?? '✦ '
  let final = ''
  for (const frame of cast.value.frames) {
    if (frame.kind === 'prompt') final += promptText
    else if (frame.kind === 'type' && frame.value) final += frame.value + '\n'
    else if (frame.kind === 'output' && frame.value) final += frame.value + '\n'
    else if (frame.kind === 'clear') final = ''
  }
  buffer.value = final
  finished.value = true
  playing.value = false
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    reducedMotion.value = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  void load().then(() => {
    if (reducedMotion.value) skip()
    else void play()
  })
})

onUnmounted(() => {
  if (abortController) abortController.abort()
})
</script>

<template>
  <figure class="lg-terminal" :style="{ height: height ?? 'auto' }">
    <div class="lg-terminal__chrome" aria-hidden="true">
      <span class="lg-terminal__dot" />
      <span class="lg-terminal__dot" />
      <span class="lg-terminal__dot" />
      <span v-if="cast?.title" class="lg-terminal__title">
        {{ cast.title }}
      </span>
    </div>

    <pre
      class="lg-terminal__buffer"
      role="log"
      aria-live="polite"
      :aria-label="cast?.title ? `Terminal recording: ${cast.title}` : 'Terminal recording'"
    >{{ visibleBuffer }}<span v-if="playing" class="lg-terminal__caret">▎</span></pre>

    <div class="lg-terminal__actions" v-if="cast">
      <button
        type="button"
        class="lg-terminal__btn"
        :disabled="playing"
        @click="replay"
      >
        {{ finished ? 'Replay' : playing ? 'Playing…' : 'Play' }}
      </button>
      <button
        v-if="playing"
        type="button"
        class="lg-terminal__btn"
        @click="skip"
      >
        Skip
      </button>
    </div>

    <p v-if="error" class="lg-terminal__error">
      Failed to load cast: {{ error }}
    </p>
  </figure>
</template>

<style scoped>
.lg-terminal {
  margin: 1.5rem 0;
  border-radius: 12px;
  overflow: hidden;
  background: var(--lg-code-bg);
  border: 1px solid var(--lg-line-strong);
  box-shadow: 0 4px 18px var(--lg-shadow);
}

.lg-terminal__chrome {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.85rem;
  background: color-mix(in oklab, var(--lg-code-bg) 80%, white);
  border-bottom: 1px solid color-mix(in oklab, var(--lg-line-strong) 50%, transparent);
}

.lg-terminal__dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--lg-line-strong);
  opacity: 0.55;
}

.lg-terminal__dot:nth-child(1) {
  background: var(--lg-accent);
}
.lg-terminal__dot:nth-child(2) {
  background: var(--lg-accent-3);
}
.lg-terminal__dot:nth-child(3) {
  background: var(--lg-accent-2);
}

.lg-terminal__title {
  margin-left: 0.5rem;
  color: var(--lg-code-fg);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  opacity: 0.85;
}

.lg-terminal__buffer {
  margin: 0;
  padding: 1.1rem 1.25rem 1.4rem;
  min-height: 220px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  line-height: 1.65;
  color: var(--lg-code-fg);
  white-space: pre-wrap;
  word-break: break-word;
}

.lg-terminal__caret {
  display: inline-block;
  color: var(--lg-accent);
  animation: lg-terminal-blink 1s steps(2) infinite;
}

.lg-terminal__actions {
  display: flex;
  gap: 0.5rem;
  padding: 0 1.25rem 1rem;
}

.lg-terminal__btn {
  appearance: none;
  background: transparent;
  border: 1px solid color-mix(in oklab, var(--lg-line-strong) 65%, transparent);
  color: var(--lg-code-fg);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  cursor: pointer;
  transition: background 200ms ease, border-color 200ms ease;
}

.lg-terminal__btn:hover:not(:disabled) {
  background: color-mix(in oklab, var(--lg-accent) 18%, transparent);
  border-color: var(--lg-accent);
}

.lg-terminal__btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.lg-terminal__error {
  margin: 0;
  padding: 0 1.25rem 1rem;
  color: var(--lg-accent-soft);
  font-size: 0.82rem;
}

@keyframes lg-terminal-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .lg-terminal__caret {
    animation: none;
  }
}
</style>
