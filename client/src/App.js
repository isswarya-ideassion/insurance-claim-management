import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/context/AuthContext.js'
import { AppRoutes } from '@/routes/AppRoutes.js'
import { Toaster } from '@/components/ui/sonner.js'
import { TooltipProvider } from '@/components/ui/misc.js'
import { configurationProblem } from '@/constants/config.js'

function ConfigurationError({ message }) {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div role="alert" className="max-w-lg rounded-xl border border-red-200 bg-white p-6 shadow-sm">
        <h1 className="text-lg font-semibold text-red-800">Configuration required</h1>
        <p className="mt-2 text-sm text-slate-700">{message}</p>
        <p className="mt-3 text-xs text-slate-500">See docs/SETUP.md. The application does not fall back to mock mode automatically.</p>
      </div>
    </div>
  )
}

export default function App() {
  const problem = configurationProblem()
  if (problem) return <ConfigurationError message={problem} />
  return (
    <BrowserRouter>
      <TooltipProvider>
        <AuthProvider>
          <AppRoutes />
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </BrowserRouter>
  )
}
