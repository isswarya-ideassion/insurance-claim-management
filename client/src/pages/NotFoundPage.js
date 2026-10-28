import { Link } from 'react-router-dom'
import { FileSearch } from 'lucide-react'
import { Button } from '@/components/ui/button.js'

export default function NotFoundPage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileSearch className="size-12 text-muted-foreground" aria-hidden="true" />
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">The page you requested does not exist or has moved.</p>
      <Button asChild className="mt-2">
        <Link to="/">Back to dashboard</Link>
      </Button>
    </div>
  )
}
