import { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AlertCircle, LogIn } from 'lucide-react'
import { useAuth } from '@/context/AuthContext.js'
import { loginSchema } from '@/schemas/authSchemas.js'
import { DEMO_ACCOUNTS } from '@/constants/config.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'

export default function LoginPage() {
  const { login, appMode, modeMismatch } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [error, setError] = useState(null)
  const { register, handleSubmit, setValue, formState } = useForm({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } })

  async function onSubmit(values) {
    setError(null)
    try {
      await login(values.email, values.password)
      navigate(location.state?.from?.pathname || '/', { replace: true })
    } catch (err) {
      setError(err.message || 'Sign-in failed')
    }
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
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </FormField>
        <div className="flex justify-end">
          <Link to="/forgot-password" className="text-sm font-medium text-accent hover:underline">
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" loading={formState.isSubmitting} disabled={modeMismatch}>
          <LogIn /> Sign in
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        New policyholder?{' '}
        <Link to="/register" className="font-medium text-accent hover:underline">
          Create an account
        </Link>
      </p>

      {appMode === 'mock' && (
        <div className="mt-8 rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Mock mode demo accounts</p>
          <p className="mt-1 text-xs text-amber-900/80">
            Fictional users seeded by the local API. Password: the server&apos;s MOCK_DEMO_PASSWORD (default <code className="font-mono">HarborDemo!2026</code>).
          </p>
          <div className="mt-3 grid grid-cols-2 gap-1.5">
            {DEMO_ACCOUNTS.map((a) => (
              <button
                key={a.email}
                type="button"
                className="rounded-md border border-amber-200 bg-white px-2 py-1.5 text-left text-xs text-amber-950 hover:border-amber-400"
                onClick={() => {
                  setValue('email', a.email, { shouldValidate: true })
                  setValue('password', 'HarborDemo!2026', { shouldValidate: true })
                }}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
