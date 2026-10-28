import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/context/AuthContext.js'
import { AppRoutes } from '@/routes/AppRoutes.js'
import { Toaster } from '@/components/ui/sonner.js'
import { TooltipProvider } from '@/components/ui/misc.js'
import { ErrorBoundary } from '@/components/common/ErrorBoundary.js'

export default function App() {
  return (
    <BrowserRouter>
      <TooltipProvider>
        <AuthProvider>
          <ErrorBoundary className="m-6">
            <AppRoutes />
          </ErrorBoundary>
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </BrowserRouter>
  )
}
