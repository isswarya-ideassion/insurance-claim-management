import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { MailCheck } from 'lucide-react'
import { toast } from 'sonner'
import { authService } from '@/services/authService.js'
import { forgotSchema } from '@/schemas/authSchemas.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'

export default function ForgotPasswordPage() {
  const [result, setResult] = useState(null)
  const { register, handleSubmit, formState } = useForm({ resolver: zodResolver(forgotSchema), defaultValues: { email: '' } })

  async function onSubmit(values) {
    try {
      setResult(await authService.requestPasswordReset(values.email))
    } catch (err) {
      toast.error(err.message)
    }
  }

  if (result) {
    return (
      <div className="text-center">
        <MailCheck className="mx-auto size-10 text-accent" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-semibold">Reset requested</h1>
        <p className="mt-2 text-sm text-muted-foreground">{result.message}</p>
        {result.note && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">{result.note}</p>}
        <Button asChild variant="outline" className="mt-6">
          <Link to="/login">Back to sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1 text-sm text-muted-foreground">Enter your account email and we will issue a reset link.</p>
      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
        <FormField label="Email" error={formState.errors.email?.message} required>
          <Input type="email" autoComplete="email" {...register('email')} />
        </FormField>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Send reset link
        </Button>
      </form>
      <p className="mt-6 text-center text-sm">
        <Link to="/login" className="font-medium text-accent hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
