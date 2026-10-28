import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { INDIAN_MOBILE_MESSAGE, ROLE_LABELS, indianMobileDigits, normalizeIndianMobile } from '@shared/constants.js'
import { useAuth } from '@/context/AuthContext.js'
import { api } from '@/services/apiClient.js'
import { useAction } from '@/hooks/useApi.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { FormField, KeyValue, SectionCard } from '@/components/common/FormField.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { Badge } from '@/components/ui/badge.js'
import { formatAuthority } from '@/utils/format.js'
import { PhoneInput, formatLocalMobile } from '@/components/common/PhoneInput.js'

const schema = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name'),
  phone: z.string().trim().refine((v) => v === '' || indianMobileDigits(v) !== null, INDIAN_MOBILE_MESSAGE),
})

export default function ProfilePage() {
  const { user, refreshProfile } = useAuth()
  const action = useAction()
  const { register, handleSubmit, formState } = useForm({
    resolver: zodResolver(schema),
    defaultValues: { fullName: user?.fullName || '', phone: formatLocalMobile(indianMobileDigits(user?.phone) || '') },
  })

  return (
    <MotionPage className="max-w-3xl">
      <PageHeader title="Your profile" description="Personal details and authorized roles." />
      <div className="space-y-6">
        <SectionCard title="Personal details">
          <form
            onSubmit={handleSubmit((v) =>
              action.run(async () => {
                await api.patch('/auth/me', { fullName: v.fullName, phone: normalizeIndianMobile(v.phone) })
                await refreshProfile()
              }, { success: 'Profile updated' }),
            )}
            className="grid gap-4 sm:grid-cols-2"
            noValidate
          >
            <FormField label="Full name" error={formState.errors.fullName?.message} required>
              <Input {...register('fullName')} />
            </FormField>
            <FormField label="Mobile number" hint="10-digit Indian mobile number" error={formState.errors.phone?.message}>
              <PhoneInput {...register('phone')} />
            </FormField>
            <div className="sm:col-span-2">
              <Button type="submit" loading={action.pending}>
                Save changes
              </Button>
            </div>
          </form>
        </SectionCard>
        <SectionCard title="Access" description="Roles and authority limits are granted by Compliance & Security and cannot be changed here.">
          <KeyValue
            items={[
              { label: 'Email', value: user?.email },
              { label: 'Roles', value: <div className="flex flex-wrap gap-1">{user?.roles.map((r) => <Badge key={r} tone="navy">{ROLE_LABELS[r]}</Badge>)}</div> },
              user?.limits && { label: 'Reserve authority', value: formatAuthority(user.limits, 'reserve') },
              user?.limits && { label: 'Settlement authority', value: formatAuthority(user.limits, 'settlement') },
            ]}
          />
        </SectionCard>
      </div>
    </MotionPage>
  )
}
