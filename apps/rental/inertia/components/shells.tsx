import type { ReactNode } from 'react'
import { router, usePage, Head } from '@inertiajs/react'
import type { SharedProps, TenantStatus } from '../types'

/* ─── Small shared UI ────────────────────────────────────────────────────── */

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {sub != null && <div className="stat__sub">{sub}</div>}
    </div>
  )
}

const STATUS_TONE: Record<TenantStatus, string> = {
  active: 'badge--green',
  provisioning: 'badge--blue',
  suspended: 'badge--amber',
  failed: 'badge--red',
  deleted: 'badge--slate',
}

export function StatusBadge({ status }: { status: TenantStatus }) {
  return (
    <span className={`badge ${STATUS_TONE[status] ?? 'badge--slate'}`}>
      <span className="dot" />
      {status}
    </span>
  )
}

function initials(name: string | null, email: string) {
  const src = (name || email || '?').trim()
  const parts = src.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return src.slice(0, 2).toUpperCase()
}

/* ─── Nav model ──────────────────────────────────────────────────────────── */

export type NavItem = { label: string; href?: string; icon: string; soon?: boolean }

/* ─── The shell (sidebar + topbar + content) ─────────────────────────────── */

function Shell({
  brandSub,
  nav,
  title,
  activeHref,
  identity,
  children,
}: {
  brandSub: string
  nav: { section: string; items: NavItem[] }[]
  title: string
  activeHref: string
  identity: { name: string | null; email: string }
  children: ReactNode
}) {
  return (
    <div className="app-shell">
      <Head title={title} />
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="logo">🚗</span>
          <div>
            Karimoto
            <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ink-3)' }}>{brandSub}</div>
          </div>
        </div>

        {nav.map((group) => (
          <div key={group.section}>
            <div className="sidebar__section">{group.section}</div>
            {group.items.map((item) =>
              item.href && !item.soon ? (
                <a
                  key={item.label}
                  href={item.href}
                  className={`nav-link ${item.href === activeHref ? 'is-active' : ''}`}
                  onClick={(e) => {
                    e.preventDefault()
                    router.visit(item.href!)
                  }}
                >
                  <span className="ico">{item.icon}</span>
                  {item.label}
                </a>
              ) : (
                <span key={item.label} className="nav-link" style={{ opacity: 0.55 }}>
                  <span className="ico">{item.icon}</span>
                  {item.label}
                  <span className="spacer" />
                  <span className="badge badge--slate" style={{ fontSize: 10 }}>
                    soon
                  </span>
                </span>
              )
            )}
          </div>
        ))}

        <div className="sidebar__foot">
          <div className="row">
            <div className="avatar">{initials(identity.name, identity.email)}</div>
            <div style={{ minWidth: 0 }}>
              <div className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>
                {identity.name || identity.email}
              </div>
              <div className="truncate muted" style={{ fontSize: 12 }}>
                {identity.email}
              </div>
            </div>
          </div>
          <button
            className="btn btn--ghost btn--sm btn--block"
            style={{ marginTop: 12 }}
            onClick={() => router.post('/logout')}
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">{title}</div>
        </header>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}

/* ─── Operator shell ─────────────────────────────────────────────────────── */

const OPERATOR_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Platform',
    items: [
      { label: 'Companies', href: '/', icon: '▤' },
      { label: 'Reporting', href: '/reporting', icon: '◷' },
      { label: 'Health & doctor', href: '/health', icon: '✚' },
      { label: 'Billing', icon: '❖', soon: true },
    ],
  },
]

export function OperatorShell({
  title,
  activeHref = '/',
  children,
}: {
  title: string
  activeHref?: string
  children: ReactNode
}) {
  const { props } = usePage<SharedProps>()
  const op = props.auth.operator
  return (
    <Shell
      brandSub="Operator"
      nav={OPERATOR_NAV}
      title={title}
      activeHref={activeHref}
      identity={{ name: op?.fullName ?? null, email: op?.email ?? '' }}
    >
      {children}
    </Shell>
  )
}

/* ─── Tenant shell ───────────────────────────────────────────────────────── */

const TENANT_NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Operations',
    items: [
      { label: 'Dashboard', href: '/', icon: '▤' },
      { label: 'Fleet', href: '/fleet', icon: '🚘' },
      { label: 'Bookings', href: '/reservations', icon: '📅' },
      { label: 'Customers', href: '/renters', icon: '👤' },
    ],
  },
  {
    section: 'Company',
    items: [
      { label: 'Billing', href: '/subscription', icon: '❖' },
      { label: 'AI assistant', href: '/assistant', icon: '✦' },
      { label: 'Knowledge base', href: '/knowledge', icon: '📚' },
      { label: 'Settings', href: '/settings', icon: '⚙' },
    ],
  },
]

export function TenantShell({
  title,
  activeHref = '/',
  children,
}: {
  title: string
  activeHref?: string
  children: ReactNode
}) {
  const { props } = usePage<SharedProps>()
  const staff = props.auth.staff
  return (
    <Shell
      brandSub={props.company?.name ?? 'Company'}
      nav={TENANT_NAV}
      title={title}
      activeHref={activeHref}
      identity={{ name: staff?.fullName ?? null, email: staff?.email ?? '' }}
    >
      {children}
    </Shell>
  )
}
