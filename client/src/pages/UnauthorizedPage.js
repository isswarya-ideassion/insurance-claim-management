import { Link } from 'react-router-dom'
import { ShieldX } from 'lucide-react'
import { Button } from '@/components/ui/button.js'

export default function UnauthorizedPage() {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <ShieldX className="size-12 text-destructive" aria-hidden="true" />
      <h1 className="text-2xl font-semibold">Access restricted</h1>
      <p className="max-w-md text-sm text-muted-foreground">Your roles do not include access to this area. If you believe this is wrong, contact your data administrator.</p>
      <Button asChild className="mt-2">
        <Link to="/">Go to my workspace</Link>
      </Button>
    </div>
  )
}
