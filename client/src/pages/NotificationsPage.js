import { Link } from 'react-router-dom'
import { Bell, CheckCheck, Mail } from 'lucide-react'
import { notificationsService } from '@/services/workflowService.js'
import { useApiQuery, useAction } from '@/hooks/useApi.js'
import { useListParams } from '@/hooks/useListParams.js'
import { NOTIFICATIONS_CHANGED } from '@/layouts/AppShell.js'
import { PageHeader } from '@/components/common/PageHeader.js'
import { EmptyState, QueryState, TableSkeleton } from '@/components/common/States.js'
import { Pagination } from '@/components/common/DataTable.js'
import { MotionPage } from '@/components/common/MotionPage.js'
import { Button } from '@/components/ui/button.js'
import { Badge } from '@/components/ui/badge.js'
import { formatRelative, formatDateTime, humanize } from '@/utils/format.js'
import { cn } from '@/lib/utils.js'

const EMAIL_LABEL = {
  LOGGED_DEV: 'Email logged (dev, not delivered)',
  SENT: 'Email sent',
  FAILED: 'Email failed',
  PENDING: 'Email pending',
}

export default function NotificationsPage() {
  const { params, setParams } = useListParams({ pageSize: 20 })
  const query = useApiQuery(() => notificationsService.list(params), [params.page, params.pageSize, params.unread])
  const action = useAction()
  const changed = () => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED))

  async function markRead(n) {
    if (n.is_read) return
    await notificationsService.markRead(n.id).catch(() => {})
    query.setData((rows) => rows.map((r) => (r.id === n.id ? { ...r, is_read: true } : r)))
    changed()
  }

  return (
    <MotionPage>
      <PageHeader
        title="Notification Center"
        description="Updates about claims, tasks, approvals and payments."
        actions={
          <>
            <Button variant={params.unread === 'true' ? 'secondary' : 'outline'} size="sm" onClick={() => setParams({ unread: params.unread === 'true' ? '' : 'true' })}>
              {params.unread === 'true' ? 'Show all' : 'Unread only'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              loading={action.pending}
              onClick={() =>
                action.run(async () => {
                  await notificationsService.markAllRead()
                  changed()
                  await query.reload()
                }, { success: 'All notifications marked as read' })
              }
            >
              <CheckCheck /> Mark all read
            </Button>
          </>
        }
      />
      <div className="rounded-xl border bg-card shadow-sm">
        <QueryState query={query} skeleton={<TableSkeleton rows={6} cols={2} />} empty={<div className="p-4"><EmptyState icon={Bell} title="You're all caught up" description="New notifications will appear here." /></div>}>
          {(rows, meta) => (
            <>
              <ul className="divide-y">
                {rows.map((n) => (
                  <li key={n.id} className={cn('flex gap-3 px-5 py-4', !n.is_read && 'bg-teal-50/40')}>
                    <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.is_read ? 'bg-transparent' : 'bg-accent')} aria-label={n.is_read ? undefined : 'Unread'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{n.title}</p>
                        <Badge tone="neutral">{humanize(n.type)}</Badge>
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">{n.message}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <time dateTime={n.created_at} title={formatDateTime(n.created_at)}>{formatRelative(n.created_at)}</time>
                        {EMAIL_LABEL[n.email_status] && (
                          <span className="inline-flex items-center gap-1">
                            <Mail className="size-3" aria-hidden="true" /> {EMAIL_LABEL[n.email_status]}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1.5">
                      {n.link && (
                        <Button asChild size="sm" variant="outline" onClick={() => markRead(n)}>
                          <Link to={n.link}>Open</Link>
                        </Button>
                      )}
                      {!n.is_read && (
                        <Button size="sm" variant="ghost" onClick={() => markRead(n)}>
                          Mark read
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <Pagination meta={meta} onPageChange={(page) => setParams({ page }, { resetPage: false })} />
            </>
          )}
        </QueryState>
      </div>
    </MotionPage>
  )
}
