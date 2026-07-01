import {
  context,
  trace,
  SpanStatusCode,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api'

/** Attribute values a span/event may carry. Ids, counts, outcomes — never content. */
export type SpanAttrs = Record<string, string | number | boolean>

/**
 * Static helper that wraps OpenTelemetry tracing for the multitenancy package. It lazily
 * builds a named tracer, runs an async callback inside a span via withSpan (setting OK or
 * ERROR status, recording exceptions, and always ending the span), and annotates the
 * active span with the current tenant id through setTenant.
 */
export default class TelemetryService {
  private static _tracer: Tracer | null = null

  static get tracer(): Tracer {
    if (!this._tracer) {
      this._tracer = trace.getTracer('adonis-multitenant', '1.0.0')
    }
    return this._tracer
  }

  static async withSpan<T>(
    name: string,
    attributes: Record<string, string | number | boolean>,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const span = this.tracer.startSpan(name, { attributes })
    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await fn(span)
        span.setStatus({ code: SpanStatusCode.OK })
        return result
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) })
        span.recordException(err as Error)
        throw err
      } finally {
        span.end()
      }
    })
  }

  static setTenant(tenantId: string): void {
    trace.getActiveSpan()?.setAttribute('tenant.id', tenantId)
  }

  /**
   * Record a timestamped event on `span`. Thin wrapper over the OTel `Span` API
   * the {@link withSpan} callback hides, so instrumentation reads uniformly and
   * every event flows through one seam. Attributes are ids/counts/outcomes only.
   */
  static addEvent(span: Span, name: string, attributes?: SpanAttrs): void {
    span.addEvent(name, attributes)
  }

  /**
   * Record an event on the CURRENTLY ACTIVE span, or no-op when there is none.
   * For hot, per-fragment signals (a streaming settle) that must not each open
   * their own span: the event lands on the caller's stream span if one is active,
   * and costs nothing otherwise.
   */
  static addEventOnActive(name: string, attributes?: SpanAttrs): void {
    trace.getActiveSpan()?.addEvent(name, attributes)
  }

  /**
   * Link `span` to another span's context (for example the satellite's
   * `ai.stream` span linking the `quota.reserve` it drove). The forward seam for
   * cross-span correlation; the OTel API models a link as `{ context }`.
   */
  static addLink(span: Span, linked: SpanContext): void {
    span.addLink({ context: linked })
  }
}
