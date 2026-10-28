import { PRIVACY_NOTICE_VERSION, normalizeIndianMobile } from '@shared/constants.js'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { authService } from '@/services/authService.js'
import { useAuth } from '@/context/AuthContext.js'
import { registerSchema } from '@/schemas/authSchemas.js'
import { FormField } from '@/components/common/FormField.js'
import { Button } from '@/components/ui/button.js'
import { Input, Label } from '@/components/ui/input.js'
import { Checkbox } from '@/components/ui/misc.js'
import { PhoneInput } from '@/components/common/PhoneInput.js'

export default function RegisterPage() {
  const navigate = useNavigate()
  const { login } = useAuth()
  const [confirmationSent, setConfirmationSent] = useState(false)
  const { register, handleSubmit, control, formState, setError } = useForm({
    resolver: zodResolver(registerSchema),
    defaultValues: { fullName: '', email: '', phone: '', password: '', confirmPassword: '', terms: false },
  })

  async function onSubmit(values) {
    try {
      const result = await authService.signUp({ email: values.email, password: values.password, fullName: values.fullName, phone: normalizeIndianMobile(values.phone) || undefined, acceptPrivacyNotice: values.terms })
      if (result.needsConfirmation) {
        setConfirmationSent(true)
        return
      }
      await login(values.email, values.password)
      toast.success('Welcome to HarborPoint')
      navigate('/customer', { replace: true })
    } catch (err) {
      if (err.code === 'USER_EXISTS') setError('email', { message: 'An account already exists for this email' })
      else toast.error(err.message)
    }
  }

  if (confirmationSent) {
    return (
      <div className="text-center">
        <CheckCircle2 className="mx-auto size-10 text-accent" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">Confirm your address using the link we emailed you, then sign in.</p>
        <Button asChild variant="outline" className="mt-6">
          <Link to="/login">Back to sign in</Link>
        </Button>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <p className="mt-1 text-sm text-muted-foreground">Policyholders can register to submit and track claims.</p>
      <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
        <FormField label="Full name" error={formState.errors.fullName?.message} required>
          <Input autoComplete="name" {...register('fullName')} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Email" error={formState.errors.email?.message} required>
            <Input type="email" autoComplete="email" {...register('email')} />
          </FormField>
          <FormField label="Mobile number" hint="Optional. 10-digit Indian mobile number." error={formState.errors.phone?.message}>
            <PhoneInput {...register('phone')} />
          </FormField>
        </div>
        <FormField label="Password" error={formState.errors.password?.message} hint="10+ characters with upper, lower case and a number" required>
          <Input type="password" autoComplete="new-password" {...register('password')} />
        </FormField>
        <FormField label="Confirm password" error={formState.errors.confirmPassword?.message} required>
          <Input type="password" autoComplete="new-password" {...register('confirmPassword')} />
        </FormField>
        <div>
          <div className="flex items-start gap-2">
            <Controller
              control={control}
              name="terms"
              render={({ field }) => <Checkbox id="terms" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" />}
            />
            <Label htmlFor="terms" className="text-sm font-normal leading-snug text-muted-foreground">
              I have read the privacy notice (version {PRIVACY_NOTICE_VERSION}) and consent to HarborPoint processing my personal data to manage my policies and claims.
            </Label>
          </div>
          {formState.errors.terms && <p className="mt-1 text-xs font-medium text-destructive">{formState.errors.terms.message}</p>}
        </div>
        <Button type="submit" className="w-full" loading={formState.isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already registered?{' '}
        <Link to="/login" className="font-medium text-accent hover:underline">
          Sign in
        </Link>
      </p>
      <p className="mt-3 text-center text-xs text-muted-foreground">Staff accounts are created by an administrator; self-registration only grants customer access.</p>
    </div>
  )
}
