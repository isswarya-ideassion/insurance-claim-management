import { useState } from 'react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Table2, BarChart3 } from 'lucide-react'
import { Button } from '@/components/ui/button.js'
import { EmptyState } from '@/components/common/States.js'
import { cn } from '@/lib/utils.js'

/** Height for a horizontal bar chart so each category label gets its own row. */
export const rowsHeight = (rows, min = 220) => Math.max(min, (rows?.length || 0) * 34 + 40)

export const SERIES = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)']
const axisProps = { tick: { fill: 'var(--chart-axis)', fontSize: 12 }, axisLine: false, tickLine: false }

function ChartTooltip({ active, payload, label, format }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-lg">
      <p className="font-medium text-foreground">{label ?? payload[0].payload.label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          <span className="size-2 rounded-full" style={{ background: p.color || p.fill }} aria-hidden="true" />
          <span className="tabular font-medium text-foreground">{format ? format(p.value) : p.value}</span>
          {p.name && payload.length > 1 && <span>{p.name}</span>}
        </p>
      ))}
    </div>
  )
}

/** Card wrapper with a chart/table toggle so every chart has an accessible table view. */
export function ChartCard({ title, description, data, columns, children, className, height = 260, empty = 'No data for this period' }) {
  const [table, setTable] = useState(false)
  const hasData = Array.isArray(data) && data.length > 0
  return (
    <section className={cn('rounded-xl border bg-card shadow-sm', className)} aria-label={title}>
      <div className="flex items-start justify-between gap-3 px-5 pt-4">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {hasData && columns && (
          <Button size="icon-sm" variant="ghost" onClick={() => setTable((t) => !t)} aria-label={table ? 'Show chart' : 'Show as table'} aria-pressed={table}>
            {table ? <BarChart3 /> : <Table2 />}
          </Button>
        )}
      </div>
      <div className="p-4 pt-3">
        {!hasData ? (
          <EmptyState title={empty} className="border-none py-8" />
        ) : table ? (
          <div className="max-h-[300px] overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  {columns.map((c) => <th key={c.key} className="py-1.5 pr-3 font-semibold">{c.header}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {columns.map((c) => <td key={c.key} className="tabular py-1.5 pr-3">{c.format ? c.format(row[c.key]) : row[c.key]}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ height }}>{children}</div>
        )}
      </div>
    </section>
  )
}

/** Single-series bar chart; horizontal layout suits long category labels. */
export function SimpleBarChart({ data, x = 'label', y = 'count', horizontal = false, color = SERIES[0], format, colorBy }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ top: 4, right: 12, bottom: 0, left: horizontal ? 8 : -12 }} barCategoryGap={horizontal ? 6 : '22%'}>
        <CartesianGrid stroke="var(--chart-grid)" vertical={horizontal} horizontal={!horizontal} />
        {horizontal ? (
          <>
            <XAxis type="number" {...axisProps} allowDecimals={false} tickFormatter={format} />
            <YAxis type="category" dataKey={x} {...axisProps} width={140} interval={0} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} {...axisProps} interval={0} angle={data.length > 6 ? -30 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 60 : 30} />
            <YAxis {...axisProps} allowDecimals={false} tickFormatter={format} />
          </>
        )}
        <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: 'rgba(15,27,45,0.04)' }} />
        <Bar dataKey={y} fill={color} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={36} isAnimationActive={false}>
          {colorBy && data.map((d, i) => <Cell key={i} fill={colorBy(d) || color} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

export function TrendAreaChart({ data, x = 'label', y = 'count', color = SERIES[0], format }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.22} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
        <XAxis dataKey={x} {...axisProps} minTickGap={24} />
        <YAxis {...axisProps} allowDecimals={false} tickFormatter={format} />
        <Tooltip content={<ChartTooltip format={format} />} cursor={{ stroke: 'var(--chart-axis)', strokeDasharray: '3 3' }} />
        <Area type="monotone" dataKey={y} stroke={color} strokeWidth={2} fill="url(#trendFill)" dot={false} activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }} isAnimationActive={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}
