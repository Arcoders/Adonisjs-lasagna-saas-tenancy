import { usePage } from '@inertiajs/react'
import LoginForm from '../../components/login_form'
import type { SharedProps } from '../../types'

/**
 * Company staff sign-in (`<slug>.localhost`). The company name comes from the
 * resolved tenant via shared props.
 */
export default function TenantLogin() {
  const { props } = usePage<SharedProps>()
  const name = props.company?.name ?? 'your company'
  return (
    <LoginForm
      heading={`${name} · staff console`}
      subtitle={`Sign in to manage ${name}'s fleet, bookings and customers.`}
    />
  )
}
