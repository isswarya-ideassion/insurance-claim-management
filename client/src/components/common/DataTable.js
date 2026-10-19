import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js'
import { Button } from '@/components/ui/button.js'
import { NativeSelect } from '@/components/ui/input.js'
import { EmptyState, ErrorState, TableSkeleton } from './States.js'
import { cn } from '@/lib/utils.js'

/**
 * columns: [{ key, header, cell?: (row) => node, sortable?, className? }]
 * sort: { field, order } and onSortChange(field, order) enable header sorting.
 */
export function DataTable({
  columns,
  rows,
  loading,
  error,
  onRetry,
  onRowClick,
  rowKey = (r) => r.id,
  sort,
  onSortChange,
  empty,
  caption,
}) {
  if (error && !rows) return <ErrorState error={error} onRetry={onRetry} className="m-4" />
  return (
    <div className="relative">
      {loading && rows && <div className="absolute inset-x-0 top-0 z-10 h-0.5 animate-pulse bg-accent" aria-hidden="true" />}
      {loading && !rows ? (
        <TableSkeleton cols={Math.min(columns.length, 6)} />
      ) : rows && rows.length === 0 ? (
        <div className="p-4">{empty || <EmptyState title="No records match" description="Try adjusting the filters." />}</div>
      ) : (
        <Table>
          {caption && <caption className="sr-only">{caption}</caption>}
          <TableHeader>
            <TableRow>
              {columns.map((col) => {
                const active = sort?.field === col.key
                const nextOrder = active && sort.order === 'asc' ? 'desc' : 'asc'
                return (
                  <TableHead key={col.key} className={col.headerClassName} aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {col.sortable && onSortChange ? (
                      <button type="button" className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => onSortChange(col.key, nextOrder)}>
                        {col.header}
                        {active ? sort.order === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-50" />}
                      </button>
                    ) : (
                      col.header
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows || []).map((row) => (
              <TableRow
                key={rowKey(row)}
                data-clickable={Boolean(onRowClick)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onRowClick(row)) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} className={col.className}>
                    {col.cell ? col.cell(row) : row[col.key] ?? '—'}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

export function Pagination({ meta, onPageChange, onPageSizeChange, className }) {
  if (!meta) return null
  const { page, pageSize, total, totalPages } = meta
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(page * pageSize, total)
  return (
    <div className={cn('flex flex-col items-center justify-between gap-3 border-t px-4 py-3 text-sm sm:flex-row', className)}>
      <p className="text-muted-foreground">
        Showing <span className="tabular font-medium text-foreground">{from}</span>–<span className="tabular font-medium text-foreground">{to}</span> of{' '}
        <span className="tabular font-medium text-foreground">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        {onPageSizeChange && (
          <label className="flex items-center gap-2 text-muted-foreground">
            <span className="hidden sm:inline">Rows</span>
            <NativeSelect value={pageSize} onChange={(e) => onPageSizeChange(Number(e.target.value))} className="h-8 w-20" aria-label="Rows per page">
              {[10, 20, 50, 100].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Previous page">
          <ChevronLeft />
        </Button>
        <span className="tabular px-1 text-muted-foreground">
          {page} / {totalPages}
        </span>
        <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)} aria-label="Next page">
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
