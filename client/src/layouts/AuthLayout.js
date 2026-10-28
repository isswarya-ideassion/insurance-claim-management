import { Outlet } from 'react-router-dom'
import { motion } from 'framer-motion'
import { CheckCircle2 } from 'lucide-react'
import { ModeBanner } from '@/components/common/ModeBanner.js'

const POINTS = ['Submit and track claims in real time', 'Secure, private document handling', 'Role-based workflows from intake to payment']

export function AuthLayout() {
  return (
    <div className="flex min-h-full flex-col">
      <ModeBanner />
      <div className="grid flex-1 lg:grid-cols-[1.1fr_1fr]">
        <aside className="relative hidden overflow-hidden bg-sidebar p-12 text-white lg:flex lg:flex-col lg:justify-between">
          <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-teal-500/10 blur-3xl" aria-hidden="true" />
          <div className="pointer-events-none absolute -bottom-32 left-10 size-[28rem] rounded-full bg-blue-500/10 blur-3xl" aria-hidden="true" />
          <div className="relative flex items-center gap-3">
            <svg viewBox="0 0 32 32" className="size-10" aria-hidden="true">
              <rect width="32" height="32" rx="8" fill="#13325c" />
              <path d="M8 20c3-1.5 5-1.5 8 0s5 1.5 8 0" stroke="#2dd4bf" strokeWidth="2.4" fill="none" strokeLinecap="round" />
              <path d="M16 6l7 3v5c0 3.5-3 6-7 7-4-1-7-3.5-7-7V9l7-3z" fill="none" stroke="#e2e8f0" strokeWidth="2" />
            </svg>
            <div>
              <p className="text-lg font-semibold">HarborPoint General Insurance</p>
              <p className="text-sm text-sidebar-muted">Claims Operations Hub</p>
            </div>
          </div>
          <div className="relative max-w-md">
            <h2 className="text-3xl font-semibold leading-tight tracking-tight">Every claim, from first notice to final payment.</h2>
            <ul className="mt-6 space-y-3">
              {POINTS.map((p) => (
                <li key={p} className="flex items-center gap-3 text-sidebar-foreground">
                  <CheckCircle2 className="size-5 text-sidebar-accent" aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
          </div>
          <p className="relative text-xs text-sidebar-muted">© {new Date().getFullYear()} HarborPoint General Insurance. Fictional company for demonstration.</p>
        </aside>
        <main className="flex items-center justify-center px-4 py-10 sm:px-8">
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }} className="w-full max-w-md">
            <Outlet />
          </motion.div>
        </main>
      </div>
    </div>
  )
}
