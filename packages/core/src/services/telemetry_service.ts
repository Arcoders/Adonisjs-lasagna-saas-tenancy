import { context, trace, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api'

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
}
