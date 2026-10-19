import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { authService } from '@/services/authService.js'
import { resetSchema } from '@/schemas/authSchemas.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'

export default function ResetPasswordPage() {
  const [params] = useSearchParams()
  const [done, setDone] = useState(false)
  const token = params.get('token')
  const { register, handleSubmit, formState } = useForm({ resolver: zodResolver(resetSchema), defaultValues: { password: '', confirmPassword: '' } })

  async function onSubmit(values) {
    try {
      await authService.resetPassword({ token, password: values.password })
      await authService.signOut().catch(() => {})
      setDone(true)
    } catch (err) {
      toast.error(err.message)
    }
  }

  if (done) {
    return (
      <div className="text-center">
        <CheckCircle2 className="mx-auto size-10 text-accent" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-semibold">Password updated</h1>
        <Button asChild className="mt-6">
          <Link to="/login">Sign in</Link>
        </Button>
      </div>
    )
  }

  if (authService.mode === 'mock' && !token) {
    return (
      <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">
        This reset link is missing its token. Request a new link from the sign-in page.
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
        <FormField label="New password" error={formState.errors.password?.message} hint="10+ characters with upper, lower case and a number" required>
          <Input type="password" autoComplete="new-password" {...register('password')} />
        </FormField>
        <FormField label="Confirm password" error={formState.errors.confirmPassword?.message} required>
          <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
        </FormField>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Update password
        </Button>
      </form>
    </div>
  )
}
