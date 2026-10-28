import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { AnimatePresence, motion } from 'framer-motion'
import { AlertTriangle, ArrowLeft, ArrowRight, Check, CheckCircle2, Save, Send, ShieldCheck, Upload, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { INCIDENT_CATEGORIES, POLICY_TYPE_LABELS, REQUIRED_DOCUMENTS, humanize } from '@shared/constants.js'
import { claimsService, policiesService } from '@/services/claimsService.js'
import { documentsService } from '@/services/documentsService.js'
import { useAuth } from '@/context/AuthContext.js'
import { claimFormSchema, STEP_FIELDS, serverFieldToForm, stepForField, toDraftPayload } from '@/schemas/claimSchemas.js'
import { FormField, KeyValue } from '@/components/common/FormField.js'
import { ConfirmDialog } from '@/components/common/ConfirmDialog.js'
import { Button } from '@/components/ui/button.js'
import { Input, Textarea } from '@/components/ui/input.js'
import { Select } from '@/components/ui/select.js'
import { Checkbox } from '@/components/ui/misc.js'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog.js'
import { RequiredDocumentsChecklist } from '@/components/documents/DocumentList.js'
import { UploadDocumentDialog } from '@/components/documents/DocumentDialogs.js'
import { StatusBadge } from '@/components/common/StatusBadge.js'
import { formatDate, formatDateTime, formatFileSize, formatMoney, toDateTimeLocal } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

const STEPS = [
  { n: 1, label: 'Policy' },
  { n: 2, label: 'Incident' },
  { n: 3, label: 'Loss details' },
  { n: 4, label: 'Documents' },
  { n: 5, label: 'Contact' },
  { n: 6, label: 'Review & submit' },
]

const submissionKeyFor = (draftId) => {
  const storageKey = `harborpoint.submission.${draftId}`
  let key = sessionStorage.getItem(storageKey)
  if (!key) {
    key = crypto.randomUUID()
    sessionStorage.setItem(storageKey, key)
  }
  return key
}

function Stepper({ step, maxReached, onJump }) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto pb-1" aria-label="Claim steps">
      {STEPS.map((s, i) => {
        const done = s.n < step
        const current = s.n === step
        return (
          <li key={s.n} className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              disabled={s.n > maxReached}
              onClick={() => onJump(s.n)}
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full px-2.5 py-1.5 text-sm transition-colors disabled:cursor-not-allowed',
                current ? 'bg-primary text-primary-foreground' : done ? 'text-foreground hover:bg-muted' : 'text-muted-foreground',
              )}
            >
              <span className={cn('flex size-6 items-center justify-center rounded-full text-xs font-semibold', current ? 'bg-white/15' : done ? 'bg-accent text-white' : 'bg-muted')}>
                {done ? <Check className="size-3.5" /> : s.n}
              </span>
              <span className="hidden sm:inline">{s.label}</span>
            </button>
            {i < STEPS.length - 1 && <span className="h-px w-4 bg-border sm:w-6" aria-hidden="true" />}
          </li>
        )
      })}
    </ol>
  )
}

export function NewClaimWizard({ draftId: initialDraftId, initialPolicy }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [draftId, setDraftId] = useState(initialDraftId || null)
  const [step, setStep] = useState(1)
  const [maxReached, setMaxReached] = useState(1)
  const [policies, setPolicies] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [eligibility, setEligibility] = useState(null)
  const [documents, setDocuments] = useState([])
  const [uploadOpen, setUploadOpen] = useState(false)
  const [duplicate, setDuplicate] = useState(null)
  const [discardOpen, setDiscardOpen] = useState(false)

  const form = useForm({
    resolver: zodResolver(claimFormSchema),
    mode: 'onTouched',
    defaultValues: {
      policyNumber: initialPolicy || '',
      insuredName: '',
      incidentAt: '',
      incidentLocation: '',
      incidentCategory: '',
      incidentDescription: '',
      estimatedLoss: '',
      affectedAsset: '',
      contactName: user?.fullName || '',
      contactPhone: user?.phone || '',
      contactEmail: user?.email || '',
      declarationAccepted: false,
    },
  })
  const { register, control, watch, setValue, getValues, trigger, setError, formState } = form
  const policyNumber = watch('policyNumber')
  const incidentAt = watch('incidentAt')
  const incidentCategory = watch('incidentCategory')
  const estimatedLoss = watch('estimatedLoss')
  const policy = useMemo(() => policies.find((p) => p.policy_number === policyNumber), [policies, policyNumber])

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await policiesService.list({ pageSize: 100 })
        if (cancelled) return
        setPolicies(res.data)
        if (initialDraftId) {
          const detail = await claimsService.get(initialDraftId)
          const c = detail.claim
          if (c.status !== 'DRAFT') {
            navigate(`/customer/claims/${c.id}`, { replace: true })
            return
          }
          form.reset({
            policyNumber: detail.policy?.policy_number || '',
            insuredName: c.insured_name || '',
            incidentAt: toDateTimeLocal(c.incident_at),
            incidentLocation: c.incident_location || '',
            incidentCategory: c.incident_category || '',
            incidentDescription: c.incident_description || '',
            estimatedLoss: c.estimated_loss ?? '',
            affectedAsset: c.affected_asset || '',
            contactName: c.contact_name || user?.fullName || '',
            contactPhone: c.contact_phone || user?.phone || '',
            contactEmail: c.contact_email || user?.email || '',
            declarationAccepted: Boolean(c.declaration_accepted),
          })
          setStep(c.draft_step || 1)
          setMaxReached(c.draft_step || 1)
          setDocuments(await documentsService.list(initialDraftId))
        }
      } catch (err) {
        toast.error(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [initialDraftId])

  useEffect(() => {
    if (policy && !getValues('insuredName')) setValue('insuredName', policy.insured_name)
    if (policy && !getValues('affectedAsset')) setValue('affectedAsset', policy.insured_asset || '')
  }, [policy])

  useEffect(() => {
    if (!policyNumber) return setEligibility(null)
    const handle = setTimeout(() => {
      policiesService
        .eligibility({
          policyNumber,
          incidentAt: incidentAt ? new Date(incidentAt).toISOString() : undefined,
          incidentCategory: incidentCategory || undefined,
          estimatedLoss: estimatedLoss === '' ? undefined : Number(estimatedLoss),
        })
        .then(setEligibility)
        .catch(() => setEligibility(null))
    }, 300)
    return () => clearTimeout(handle)
  }, [policyNumber, incidentAt, incidentCategory, estimatedLoss])

  async function saveDraft(nextStep = step, { silent = false } = {}) {
    setSaving(true)
    try {
      const payload = toDraftPayload(getValues(), nextStep)
      if (draftId) {
        await claimsService.updateDraft(draftId, payload)
      } else {
        const created = await claimsService.createDraft(payload)
        setDraftId(created.id)
        window.history.replaceState(null, '', `/customer/claims/${created.id}/edit`)
      }
      if (!silent) toast.success('Draft saved')
      return true
    } catch (err) {
      if (err.details?.length) err.details.forEach((d) => setError(d.field, { message: d.message }))
      toast.error(err.message)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function goNext() {
    const valid = await trigger(STEP_FIELDS[step])
    if (!valid) return
    if (step === 1 && policy && policy.status !== 'ACTIVE') {
      setError('policyNumber', { message: `This policy is ${policy.status.toLowerCase()} and cannot be used for a new claim` })
      return
    }
    const next = step + 1
    if (await saveDraft(next, { silent: true })) {
      setStep(next)
      setMaxReached((m) => Math.max(m, next))
      window.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }

  async function submit(confirmSeparateClaim = false) {
    const valid = await trigger()
    if (!valid) {
      const first = Object.keys(form.formState.errors)[0]
      if (first) setStep(stepForField(first))
      toast.error('Please complete the highlighted fields')
      return
    }
    if (!(await saveDraft(6, { silent: true }))) return
    setSubmitting(true)
    try {
      const res = await claimsService.submit(draftId, { submissionKey: submissionKeyFor(draftId), confirmSeparateClaim })
      sessionStorage.removeItem(`harborpoint.submission.${draftId}`)
      toast.success(`Claim ${res.data.claim_number} submitted`, { description: res.meta?.replayed ? 'This submission had already been received.' : 'We will keep you updated here and by notification.' })
      navigate(`/customer/claims/${draftId}`, { replace: true })
    } catch (err) {
      if (err.code === 'POSSIBLE_DUPLICATE') setDuplicate(err.details.existing)
      else if (err.code === 'ALREADY_SUBMITTED') navigate(`/customer/claims/${draftId}`, { replace: true })
      else if (err.details?.length && Array.isArray(err.details)) {
        err.details.forEach((d) => setError(serverFieldToForm(d.field), { message: d.message }))
        setStep(stepForField(serverFieldToForm(err.details[0].field)))
        toast.error(err.message)
      } else toast.error(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="h-96 animate-pulse rounded-xl bg-slate-200/70" aria-busy="true" aria-label="Loading claim form" />

  const errors = formState.errors
  const categories = policy ? INCIDENT_CATEGORIES[policy.policy_type] || [] : []
  const values = getValues()
  const required = policy ? REQUIRED_DOCUMENTS[policy.policy_type] || [] : []

  return (
    <div className="rounded-xl border bg-card shadow-sm">
      <div className="border-b p-4 sm:px-6">
        <Stepper step={step} maxReached={maxReached} onJump={(n) => n <= maxReached && setStep(n)} />
      </div>
      <form onSubmit={(e) => e.preventDefault()} noValidate className="p-4 sm:p-6">
        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} className="min-h-[340px]">
            {step === 1 && (
              <div className="space-y-5">
                <h2 className="text-lg font-semibold">Which policy is this claim for?</h2>
                {policies.length === 0 && <p className="text-sm text-muted-foreground">No policies are linked to your account. Contact HarborPoint to link your policy.</p>}
                <div className="grid gap-3 md:grid-cols-2" role="radiogroup" aria-label="Policy">
                  {policies.map((p) => {
                    const selected = policyNumber === p.policy_number
                    const disabled = p.status !== 'ACTIVE'
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => {
                          setValue('policyNumber', p.policy_number, { shouldValidate: true })
                          setValue('incidentCategory', '')
                          setValue('insuredName', p.insured_name)
                          setValue('affectedAsset', p.insured_asset || '')
                        }}
                        className={cn('rounded-xl border p-4 text-left transition-colors', selected ? 'border-accent bg-teal-50/60 ring-1 ring-accent' : 'hover:border-slate-300', disabled && 'opacity-60')}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{p.policy_number}</span>
                          <StatusBadge value={p.status} />
                        </div>
                        <p className="mt-1 text-sm">{POLICY_TYPE_LABELS[p.policy_type]} · {p.insured_asset}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {formatDate(p.effective_from)} – {formatDate(p.effective_to)} · Sum insured {formatMoney(p.sum_insured)}
                        </p>
                      </button>
                    )
                  })}
                </div>
                {errors.policyNumber && <p className="text-sm font-medium text-destructive" role="alert">{errors.policyNumber.message}</p>}
                {policy && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField label="Policy type">
                      <Input value={POLICY_TYPE_LABELS[policy.policy_type]} readOnly className="bg-muted" />
                    </FormField>
                    <FormField label="Insured name" error={errors.insuredName?.message} required>
                      <Input {...register('insuredName')} />
                    </FormField>
                  </div>
                )}
              </div>
            )}

            {step === 2 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <h2 className="text-lg font-semibold sm:col-span-2">What happened?</h2>
                <FormField label="Incident date and time" error={errors.incidentAt?.message} required>
                  <Input type="datetime-local" max={toDateTimeLocal(new Date())} {...register('incidentAt')} />
                </FormField>
                <FormField label="Incident category" error={errors.incidentCategory?.message} required>
                  <Controller control={control} name="incidentCategory" render={({ field }) => <Select value={field.value} onValueChange={field.onChange} placeholder="Select category" options={categories.map((c) => ({ value: c, label: humanize(c) }))} />} />
                </FormField>
                <FormField label="Incident location" error={errors.incidentLocation?.message} required className="sm:col-span-2">
                  <Input placeholder="Street address, city, or a clear description of the place" {...register('incidentLocation')} />
                </FormField>
                <FormField label="Incident description" error={errors.incidentDescription?.message} hint="Describe the sequence of events, any people involved and any reports made." required className="sm:col-span-2">
                  <Textarea className="min-h-32" {...register('incidentDescription')} />
                </FormField>
              </div>
            )}

            {step === 3 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <h2 className="text-lg font-semibold sm:col-span-2">Loss details</h2>
                <FormField label="Estimated loss amount (USD)" error={errors.estimatedLoss?.message} hint={policy ? `Sum insured ${formatMoney(policy.sum_insured)} · deductible ${formatMoney(policy.deductible)}` : undefined} required>
                  <Input type="number" min="0" step="0.01" inputMode="decimal" {...register('estimatedLoss')} />
                </FormField>
                <FormField label="Affected property or asset" error={errors.affectedAsset?.message} required>
                  <Input {...register('affectedAsset')} />
                </FormField>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">Supporting documents</h2>
                    <p className="text-sm text-muted-foreground">Uploading required documents now speeds up your claim. You can also add them later.</p>
                  </div>
                  <Button type="button" onClick={() => setUploadOpen(true)} disabled={!draftId}>
                    <Upload /> Upload document
                  </Button>
                </div>
                <RequiredDocumentsChecklist required={required} documents={documents} />
                {documents.length > 0 ? (
                  <ul className="divide-y rounded-lg border">
                    {documents.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                        <span className="min-w-0 truncate">
                          <strong className="font-medium">{d.file_name}</strong> · {humanize(d.category)} · {formatFileSize(d.size_bytes)}
                        </span>
                        <StatusBadge value={d.status} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No documents uploaded yet.</p>
                )}
              </div>
            )}

            {step === 5 && (
              <div className="grid gap-4 sm:grid-cols-2">
                <h2 className="text-lg font-semibold sm:col-span-2">How can we reach you?</h2>
                <FormField label="Contact name" error={errors.contactName?.message} required>
                  <Input autoComplete="name" {...register('contactName')} />
                </FormField>
                <FormField label="Phone number" error={errors.contactPhone?.message} required>
                  <Input type="tel" autoComplete="tel" {...register('contactPhone')} />
                </FormField>
                <FormField label="Email" error={errors.contactEmail?.message} required className="sm:col-span-2">
                  <Input type="email" autoComplete="email" {...register('contactEmail')} />
                </FormField>
              </div>
            )}

            {step === 6 && (
              <div className="space-y-5">
                <h2 className="text-lg font-semibold">Review and submit</h2>
                <div className="rounded-xl border p-4">
                  <KeyValue
                    items={[
                      { label: 'Policy', value: `${values.policyNumber} · ${policy ? POLICY_TYPE_LABELS[policy.policy_type] : ''}` },
                      { label: 'Insured name', value: values.insuredName },
                      { label: 'Incident', value: `${humanize(values.incidentCategory)} · ${formatDateTime(values.incidentAt)}` },
                      { label: 'Location', value: values.incidentLocation },
                      { label: 'Description', value: values.incidentDescription, wide: true },
                      { label: 'Estimated loss', value: formatMoney(values.estimatedLoss) },
                      { label: 'Affected asset', value: values.affectedAsset },
                      { label: 'Documents', value: `${documents.length} uploaded` },
                      { label: 'Contact', value: `${values.contactName} · ${values.contactPhone} · ${values.contactEmail}`, wide: true },
                    ]}
                  />
                </div>
                {required.some((cat) => !documents.some((d) => d.category === cat)) && (
                  <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" /> Some required documents are missing. You can submit now, but we will ask for them before assessing your claim.
                  </p>
                )}
                <div className="rounded-xl border bg-muted/40 p-4">
                  <div className="flex items-start gap-3">
                    <Controller control={control} name="declarationAccepted" render={({ field }) => <Checkbox id="declaration" checked={field.value} onCheckedChange={(v) => field.onChange(v === true)} className="mt-0.5" />} />
                    <label htmlFor="declaration" className="text-sm leading-relaxed">
                      I declare that the information provided is true and complete to the best of my knowledge. I understand that providing false information may invalidate my claim, and I consent to HarborPoint processing my personal data and contacting third parties to assess this claim.
                    </label>
                  </div>
                  {errors.declarationAccepted && <p className="mt-2 text-sm font-medium text-destructive" role="alert">{errors.declarationAccepted.message}</p>}
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>

        {eligibility && step <= 3 && (
          <div className={cn('mt-4 flex items-start gap-2 rounded-lg p-3 text-sm', eligibility.eligible ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-900')} role="status">
            {eligibility.eligible ? <ShieldCheck className="mt-0.5 size-4 shrink-0" /> : <XCircle className="mt-0.5 size-4 shrink-0" />}
            <span>{eligibility.eligible ? 'Policy checks passed for the details entered so far.' : `Policy check: ${eligibility.reasons.join('; ')}`}</span>
          </div>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-2">
            {step > 1 && (
              <Button type="button" variant="outline" onClick={() => setStep(step - 1)}>
                <ArrowLeft /> Back
              </Button>
            )}
            {draftId && (
              <Button type="button" variant="ghost" className="text-red-700" onClick={() => setDiscardOpen(true)}>
                Discard draft
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => saveDraft(step)} loading={saving} disabled={!policyNumber}>
              <Save /> Save draft
            </Button>
            {step < 6 ? (
              <Button type="button" onClick={goNext} loading={saving}>
                Continue <ArrowRight />
              </Button>
            ) : (
              <Button type="button" variant="accent" onClick={() => submit(false)} loading={submitting}>
                <Send /> Submit claim
              </Button>
            )}
          </div>
        </div>
      </form>

      {draftId && (
        <UploadDocumentDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          claimId={draftId}
          customer
          onUploaded={async () => setDocuments(await documentsService.list(draftId))}
        />
      )}

      <Dialog open={Boolean(duplicate)} onOpenChange={(o) => !o && setDuplicate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Is this a separate incident?</DialogTitle>
            <DialogDescription>You already have a claim on this policy for a similar incident around the same time. Submitting twice for the same event can delay processing.</DialogDescription>
          </DialogHeader>
          <ul className="space-y-2">
            {duplicate?.map((d) => (
              <li key={d.id} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                <span>
                  <strong>{d.claim_number}</strong> · {formatDateTime(d.incident_at)} · {formatMoney(d.estimated_loss)}
                </span>
                <span className="text-xs text-muted-foreground">{d.status_label}</span>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => navigate(`/customer/claims/${duplicate[0].id}`)}>
              View existing claim
            </Button>
            <Button
              variant="accent"
              loading={submitting}
              onClick={async () => {
                setDuplicate(null)
                await submit(true)
              }}
            >
              <CheckCircle2 /> Yes, submit separate claim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard this draft?"
        description="The draft will be withdrawn and cannot be submitted."
        variant="destructive"
        confirmLabel="Discard draft"
        onConfirm={async () => {
          try {
            await claimsService.discardDraft(draftId)
            toast.success('Draft discarded')
            navigate('/customer/claims', { replace: true })
            return true
          } catch (err) {
            toast.error(err.message)
            return false
          }
        }}
      />
    </div>
  )
}
