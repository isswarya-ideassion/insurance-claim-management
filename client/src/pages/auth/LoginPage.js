import { forwardRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, Eye, EyeOff, LogIn } from 'lucide-react'
import { useAuth } from '@/context/AuthContext.js'
import { loginSchema } from '@/schemas/authSchemas.js'
import { DEMO_ACCOUNTS, DEMO_PASSWORD } from '@/constants/config.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'

/**
 * Password field with a show/hide toggle. The toggle is a sibling of the input,
 * so FormField's id and aria props (and react-hook-form's ref) reach the <input> itself.
 */
const PasswordInput = forwardRef(function PasswordInput(props, ref) {
  const [showPassword, setShowPassword] = useState(false)
  return (
    <div className="relative">
      <Input ref={ref} type={showPassword ? 'text' : 'password'} className="pr-10" {...props} />
      <button
        type="button"
        onClick={() => setShowPassword((shown) => !shown)}
        aria-label={showPassword ? 'Hide password' : 'Show password'}
        aria-pressed={showPassword}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {showPassword ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </button>
    </div>
  )
})

export default function LoginPage() {
  const { login, demoData, serverUnreachable } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState(null)
  const { register, handleSubmit, setValue, formState } = useForm({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })

  async function onSubmit(values) {
    setError(null)
    try {
      await login(values.email, values.password)
      // Some demo accounts open a specific page after sign-in (e.g. Customer Records).
      const demoTarget = DEMO_ACCOUNTS.find((a) => a.email === values.email.trim().toLowerCase())?.to
      navigate(location.state?.from?.pathname || demoTarget || '/', { replace: true })
    } catch (err) {
      setError(err.message || 'Sign-in failed')
    }
  }

  // Demo servers only (the list is hidden otherwise): fill the account and sign in at once.
  // The password stays out of the page text; a server with a custom DEMO_PASSWORD shows the normal sign-in error.
  function quickSignIn(email) {
    if (!email) return
    setValue('email', email, { shouldValidate: true })
    setValue('password', DEMO_PASSWORD, { shouldValidate: true })
    handleSubmit(onSubmit)()
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">Access your HarborPoint claims workspace.</p>

      {error && (
        <div role="alert" className="mt-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
        <FormField label="Email" error={formState.errors.email?.message} required>
          <Input type="email" autoComplete="email" {...register('email')} />
        </FormField>
        <FormField label="Password" error={formState.errors.password?.message} required>
          <PasswordInput autoComplete="current-password" {...register('password')} />
        </FormField>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-accent hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={formState.isSubmitting} disabled={serverUnreachable}>
          <LogIn /> Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        New policyholder?{' '}
        <Link to="/register" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>

      {demoData && (
        <div className="mt-8 border-t pt-4">
          <label htmlFor="quick-role" className="text-xs font-medium text-muted-foreground">
            Quick role switch
          </label>
          <select
            id="quick-role"
            value=""
            disabled={formState.isSubmitting || serverUnreachable}
            onChange={(e) => quickSignIn(e.target.value)}
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="" disabled>
              Sign in as…
            </option>
            {DEMO_ACCOUNTS.map((a) => (
              <option key={a.email} value={a.email}>
                {a.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}
