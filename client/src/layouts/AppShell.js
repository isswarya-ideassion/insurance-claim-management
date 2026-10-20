import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Bell, ChevronDown, LogOut, Menu, Search, UserCog } from 'lucide-react'
import { ROLE_LABELS } from '@shared/constants.js'
import { useAuth } from '@/context/AuthContext.js'
import { NAVIGATION, ROLE_HOME } from '@/constants/navigation.js'
import { notificationsService } from '@/services/workflowService.js'
import { ModeBanner } from '@/components/common/ModeBanner.js'
import { ErrorBoundary } from '@/components/common/ErrorBoundary.js'
import { Avatar } from '@/components/ui/misc.js'
import { Button } from '@/components/ui/button.js'
import { Input } from '@/components/ui/input.js'
import { SheetContent } from '@/components/ui/dialog.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { cn } from '@/lib/utils.js'

export const NOTIFICATIONS_CHANGED = 'harborpoint:notifications-changed'

function Brand() {
  return (
    <div className="flex h-14 items-center gap-2.5 px-4">
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="#13325c" />
        <path d="M8 20c3-1.5 5-1.5 8 0s5 1.5 8 0" stroke="#2dd4bf" strokeWidth="2.4" fill="none" strokeLinecap="round" />
        <path d="M16 6l7 3v5c0 3.5-3 6-7 7-4-1-7-3.5-7-7V9l7-3z" fill="none" stroke="#e2e8f0" strokeWidth="2" />
      </svg>
      <div className="leading-tight">
        <p className="text-sm font-semibold text-white">HarborPoint</p>
        <p className="text-[11px] text-sidebar-muted">Claims Operations Hub</p>
      </div>
    </div>
  )
}

function NavList({ items, onNavigate }) {
  return (
    <nav aria-label="Main navigation" className="flex-1 space-y-0.5 overflow-y-auto px-2 py-3">
      {items.map((item) => {
        const Icon = item.icon
        return (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-active/70 hover:text-white',
                isActive && 'bg-sidebar-active text-white',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-sidebar-accent" aria-hidden="true" />}
                <Icon className={cn('size-4 shrink-0', isActive ? 'text-sidebar-accent' : 'text-sidebar-muted group-hover:text-white')} aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}

export function AppShell() {
  const { user, activeRole, setActiveRole, logout, can } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [unread, setUnread] = useState(0)
  const [search, setSearch] = useState('')
  const items = NAVIGATION[activeRole] || []

  const refreshUnread = useCallback(() => {
    notificationsService.unreadCount().then(setUnread).catch(() => {})
  }, [])

  useEffect(() => {
    refreshUnread()
    const timer = setInterval(refreshUnread, 60_000)
    window.addEventListener(NOTIFICATIONS_CHANGED, refreshUnread)
    return () => {
      clearInterval(timer)
      window.removeEventListener(NOTIFICATIONS_CHANGED, refreshUnread)
    }
  }, [refreshUnread])

  useEffect(() => setMobileOpen(false), [location.pathname])

  function switchRole(role) {
    setActiveRole(role)
    navigate(ROLE_HOME[role])
  }

  const staffSearch = can('claims.viewQueue')
  const customerSearch = user?.roles.includes('CUSTOMER') && activeRole === 'CUSTOMER'
  function submitSearch(e) {
    e.preventDefault()
    const q = search.trim()
    if (!q) return
    navigate(customerSearch ? `/customer/claims?search=${encodeURIComponent(q)}` : `/claims?search=${encodeURIComponent(q)}`)
    setSearch('')
  }

  return (
    <div className="flex h-full flex-col">
      <ModeBanner />
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
          <Brand />
          <NavList items={items} />
        </aside>

        <DialogPrimitive.Root open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="bg-sidebar p-0" aria-describedby={undefined}>
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="flex h-full flex-col">
              <Brand />
              <NavList items={items} onNavigate={() => setMobileOpen(false)} />
            </div>
          </SheetContent>
        </DialogPrimitive.Root>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur sm:px-6">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
              <Menu />
            </Button>
            {(staffSearch || customerSearch) && (
              <form onSubmit={submitSearch} className="relative hidden max-w-md flex-1 sm:block" role="search">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={customerSearch ? 'Search my claims…' : 'Search claim ID, claimant or policy number…'}
                  aria-label="Search claims"
                  className="pl-8"
                />
              </form>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" size="icon" asChild>
                <Link to="/notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative">
                  <Bell />
                  {unread > 0 && (
                    <span className="tabular absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[10px] font-semibold leading-4 text-accent-foreground ring-2 ring-card" aria-hidden="true">
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </Link>
              </Button>

              {user?.roles.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="hidden sm:inline-flex" aria-label="Switch workspace">
                      {ROLE_LABELS[activeRole]}
                      <ChevronDown className="opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <DropdownMenuLabel>Workspace</DropdownMenuLabel>
                    <DropdownMenuRadioGroup value={activeRole} onValueChange={switchRole}>
                      {user.roles.map((r) => (
                        <DropdownMenuRadioItem key={r} value={r}>
                          {ROLE_LABELS[r]}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <p className="px-2 pb-1 pt-2 text-[11px] text-muted-foreground">Only roles granted by an administrator are listed.</p>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="flex items-center gap-2 rounded-lg p-1 pr-2 hover:bg-muted" aria-label="Account menu">
                    <Avatar name={user?.fullName || user?.email} />
                    <span className="hidden text-left leading-tight md:block">
                      <span className="block max-w-40 truncate text-sm font-medium">{user?.fullName || user?.email}</span>
                      <span className="block text-[11px] text-muted-foreground">{ROLE_LABELS[activeRole]}</span>
                    </span>
                    <ChevronDown className="hidden size-3.5 text-muted-foreground md:block" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-64">
                  <DropdownMenuLabel className="normal-case tracking-normal">
                    <span className="block text-sm font-semibold text-foreground">{user?.fullName}</span>
                    <span className="block text-xs font-normal">{user?.email}</span>
                  </DropdownMenuLabel>
                  <div className="flex flex-wrap gap-1 px-2 pb-2">
                    {user?.roles.map((r) => (
                      <span key={r} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                        {ROLE_LABELS[r]}
                      </span>
                    ))}
                  </div>
                  {user?.roles.length > 1 && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuRadioGroup value={activeRole} onValueChange={switchRole} className="sm:hidden">
                        {user.roles.map((r) => (
                          <DropdownMenuRadioItem key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigate('/profile')}>
                    <UserCog /> Profile
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={async () => {
                      await logout()
                      navigate('/login', { replace: true })
                    }}
                  >
                    <LogOut /> Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
              <ErrorBoundary resetKey={location.pathname}>
                <Outlet />
              </ErrorBoundary>
            </div>
          </main>
        </div>
      </div>
    </div>
  )
}
