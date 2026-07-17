import { useForm, usePage, Head } from '@inertiajs/react'
import type { FormEvent } from 'react'
import type { SharedProps } from '../types'

type Props = {
  heading: string
  subtitle: string
}

/**
 * The shared session-login card. Both realms render it; the server route
 * (`POST /login`, universal) picks the realm from the resolved host, so the form
 * itself is realm-agnostic. Field errors come back through Inertia's validation
 * bag; a bad-credentials failure arrives as a flash message.
 */
export default function LoginForm({ heading, subtitle }: Props) {
  const { props } = usePage<SharedProps>()
  const form = useForm({ email: '', password: '' })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    form.post('/login', { onFinish: () => form.reset('password') })
  }

  const flashError = props.flash?.error

  return (
    <div className="auth-screen">
      <Head title="Sign in" />
      <div className="auth-card">
        <div className="auth-card__brand">
          <span className="logo">🚗</span> Karimoto
        </div>
        <p className="auth-card__sub">{subtitle}</p>

        {flashError && <div className="alert alert--error">{flashError}</div>}

        <form onSubmit={submit} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="email">
              Email
            </label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="username"
              autoFocus
              value={form.data.email}
              onChange={(e) => form.setData('email', e.target.value)}
            />
            {form.errors.email && <span className="field__error">{form.errors.email}</span>}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={form.data.password}
              onChange={(e) => form.setData('password', e.target.value)}
            />
            {form.errors.password && (
              <span className="field__error">{form.errors.password}</span>
            )}
          </div>

          <button
            className="btn btn--primary btn--block"
            type="submit"
            disabled={form.processing}
          >
            {form.processing ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="muted" style={{ marginTop: 18, fontSize: 13 }}>
          {heading}
        </p>
      </div>
    </div>
  )
}
