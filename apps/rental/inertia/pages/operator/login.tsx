import LoginForm from '../../components/login_form'

/**
 * Operator sign-in (apex `localhost`). Rendered by ConsoleAuthController.show
 * when no company host is resolved.
 */
export default function OperatorLogin() {
  return (
    <LoginForm
      heading="Platform operator console"
      subtitle="Sign in to manage rental companies across the Karimoto platform."
    />
  )
}
