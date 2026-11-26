import { forwardRef, useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Controller } from 'react-hook-form'
import { ChevronLeft, ChevronRight, Calendar } from 'lucide-react'
import { cn } from '@/lib/utils.js'
import { Button } from '@/components/ui/button.js'

// Same control styling as Input, so the picker sits in a form like its neighbours.
const triggerBase =
  'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-left text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-destructive'

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3))
const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const pad = (n) => String(n).padStart(2, '0')

/** "YYYY-MM-DDTHH:mm" (the datetime-local format the form stores) -> parts, or null. */
export function parseDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value || '')
  if (!m) return null
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] }
}

/** Parts -> "YYYY-MM-DDTHH:mm", the same string a native datetime-local input would hold. */
export function formatDateTime({ y, mo, d, h, mi }) {
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`
}

function displayValue(value) {
  const p = parseDateTime(value)
  if (!p) return null
  return `${pad(p.d)} ${MONTHS_SHORT[p.mo - 1]} ${p.y}, ${pad(p.h)}:${pad(p.mi)}`
}

const daysIn = (y, mo) => new Date(y, mo, 0).getDate()
const dayKey = ({ y, mo, d }) => `${y}-${pad(mo)}-${pad(d)}`
const nowParts = () => {
  const n = new Date()
  return { y: n.getFullYear(), mo: n.getMonth() + 1, d: n.getDate(), h: n.getHours(), mi: n.getMinutes() }
}

/** Clamps a candidate to the maximum allowed "YYYY-MM-DDTHH:mm" (e.g. "now" for an incident date). */
function clampToMax(parts, max) {
  const limit = parseDateTime(max)
  if (!limit) return parts
  const value = formatDateTime(parts)
  return value > max ? limit : parts
}

/**
 * Date and time picker that commits only on OK. Clear, Today, Escape and a click
 * outside behave as described below; the form sees one "YYYY-MM-DDTHH:mm" string.
 * Forwards id and aria attributes to its trigger, so FormField labels still work.
 */
export const DateTimePicker = forwardRef(function DateTimePicker(
  { value = '', onChange, onBlur, max, disabled, placeholder = 'Select date and time', className, name, id, ...aria },
  ref,
) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(null) // parts, or null for "cleared"
  const [view, setView] = useState(() => parseDateTime(value) || nowParts())
  const rootRef = useRef(null)
  const triggerRef = useRef(null)
  const panelId = useId()

  const maxParts = parseDateTime(max)
  const maxDay = maxParts ? dayKey(maxParts) : null

  function openPanel() {
    const current = parseDateTime(value) || clampToMax(nowParts(), max)
    setDraft(current)
    setView({ y: current.y, mo: current.mo })
    setOpen(true)
  }

  function close({ restoreFocus = true } = {}) {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  function commit() {
    onChange?.(draft ? formatDateTime(draft) : '')
    close()
  }

  // Escape and outside clicks discard the draft: the value only changes on OK.
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) {
      if (e.key === 'Escape') close()
    }
    function onPointer(e) {
      if (!rootRef.current?.contains(e.target)) close({ restoreFocus: false })
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
    }
    // close is stable for our purposes; the listeners only depend on `open`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function pickDay(day) {
    const candidate = { ...(draft || clampToMax(nowParts(), max)), y: view.y, mo: view.mo, d: day }
    setDraft(clampToMax(candidate, max))
  }

  function setTime(part, n) {
    const base = draft || clampToMax(nowParts(), max)
    setDraft(clampToMax({ ...base, [part]: n }, max))
  }

  function goToday() {
    const t = clampToMax(nowParts(), max)
    setDraft(t)
    setView({ y: t.y, mo: t.mo })
  }

  function shiftMonth(delta) {
    setView((v) => {
      const total = v.y * 12 + (v.mo - 1) + delta
      return { y: Math.floor(total / 12), mo: (total % 12) + 1 }
    })
  }

  // Calendar cells: leading blanks, then the days of the viewed month.
  const leading = new Date(view.y, view.mo - 1, 1).getDay()
  const cells = [...Array(leading).fill(null), ...Array.from({ length: daysIn(view.y, view.mo) }, (_, i) => i + 1)]
  const todayKey = dayKey(nowParts())
  const selectedKey = draft ? dayKey(draft) : null
  const maxMonthKey = maxParts ? maxParts.y * 12 + maxParts.mo : null
  const viewKey = view.y * 12 + view.mo
  const canGoNext = maxMonthKey === null || viewKey < maxMonthKey

  // Hours and minutes past the maximum are disabled on the maximum day.
  const onMaxDay = !!draft && maxDay && dayKey(draft) === maxDay
  const hourDisabled = (h) => onMaxDay && h > maxParts.h
  const minuteDisabled = (mi) => onMaxDay && draft.h === maxParts.h && mi > maxParts.mi

  const shown = displayValue(value)

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={(node) => {
          triggerRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref) ref.current = node
        }}
        type="button"
        id={id}
        name={name}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onBlur={onBlur}
        onClick={() => (open ? close() : openPanel())}
        className={triggerBase}
        {...aria}
      >
        <span className={cn(!shown && 'text-muted-foreground')}>{shown || placeholder}</span>
        <Calendar className="size-4 text-muted-foreground" aria-hidden="true" />
      </button>

      <AnimatePresence>
      {open && (
        <motion.div
          id={panelId}
          role="dialog"
          aria-label="Choose date and time"
          initial={{ opacity: 0, scale: 0.97, y: -4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -4 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          className="absolute left-0 z-50 mt-1 w-72 origin-top rounded-lg border border-border bg-card p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between">
            <button type="button" onClick={() => shiftMonth(-1)} aria-label="Previous month" className="rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronLeft className="size-4" />
            </button>
            <div className="text-sm font-semibold text-primary">
              {MONTHS[view.mo - 1]} {view.y}
            </div>
            <button
              type="button"
              onClick={() => shiftMonth(1)}
              disabled={!canGoNext}
              aria-label="Next month"
              className="rounded p-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          <div role="grid" aria-label={`${MONTHS[view.mo - 1]} ${view.y}`} className="grid grid-cols-7 gap-0.5 text-center text-xs">
            {WEEKDAYS.map((w) => (
              <div key={w} role="columnheader" className="py-1 font-medium text-muted-foreground">
                {w}
              </div>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <div key={`b${i}`} />
              const key = dayKey({ y: view.y, mo: view.mo, d: day })
              const future = maxDay !== null && key > maxDay
              const selected = key === selectedKey
              return (
                <button
                  key={key}
                  type="button"
                  role="gridcell"
                  aria-selected={selected}
                  aria-label={`${day} ${MONTHS[view.mo - 1]} ${view.y}`}
                  disabled={future}
                  onClick={() => pickDay(day)}
                  className={cn(
                    'h-8 rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground/40',
                    selected ? 'bg-primary font-semibold text-primary-foreground' : 'hover:bg-muted',
                    !selected && key === todayKey && 'ring-1 ring-accent text-accent font-semibold',
                  )}
                >
                  {day}
                </button>
              )
            })}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
            <label className="sr-only" htmlFor={`${panelId}-h`}>Hour</label>
            <select
              id={`${panelId}-h`}
              value={draft ? draft.h : 0}
              onChange={(e) => setTime('h', Number(e.target.value))}
              disabled={!draft}
              className="h-8 flex-1 rounded-md border border-input bg-card px-2 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h} disabled={hourDisabled(h)}>
                  {pad(h)} h
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor={`${panelId}-m`}>Minute</label>
            <select
              id={`${panelId}-m`}
              value={draft ? draft.mi : 0}
              onChange={(e) => setTime('mi', Number(e.target.value))}
              disabled={!draft}
              className="h-8 flex-1 rounded-md border border-input bg-card px-2 text-sm"
            >
              {Array.from({ length: 60 }, (_, mi) => (
                <option key={mi} value={mi} disabled={minuteDisabled(mi)}>
                  {pad(mi)} min
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3">
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDraft(null)}>
                Clear
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={goToday}>
                Today
              </Button>
            </div>
            <Button type="button" size="sm" onClick={commit}>
              OK
            </Button>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </div>
  )
})

/**
 * react-hook-form binding. Wrapping the Controller here (rather than inside the
 * form) lets FormField's cloned props (id, aria-invalid, aria-describedby) reach the trigger.
 */
export function FormDateTimePicker({ control, name, ...props }) {
  return (
    <Controller
      name={name}
      control={control}
      render={({ field }) => (
        <DateTimePicker {...props} name={field.name} value={field.value || ''} onChange={field.onChange} onBlur={field.onBlur} />
      )}
    />
  )
}
