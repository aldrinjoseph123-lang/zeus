import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileSpreadsheet, FileText, Play } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, percent } from '../lib/format';
import {
  Button, Card, CardHeader, DataTable, EmptyState, Field, Input, Loading, PageHeader,
  cx, useToast,
} from '../components/ui';
import { OwnerSelect, Toolbar } from '../components/pickers';

interface ReportColumn { key: string; label: string; align?: 'left' | 'right'; format?: 'money' | 'date' | 'percent' | 'text' }
interface ReportDef { key: string; name: string; description: string; module: string; columns: ReportColumn[] }
interface ReportResult { key: string; name: string; columns: ReportColumn[]; rows: Array<Record<string, unknown>>; summary?: Array<[string, string]> }

export default function Reports() {
  const toast = useToast();
  const { can } = useAuth();

  const [active, setActive] = useState<string | null>(null);
  const [from, setFrom] = useState(new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10));
  const [ownerId, setOwnerId] = useState('');

  const { data: reports, isLoading } = useQuery({
    queryKey: ['reports'],
    queryFn: () => api.get<ReportDef[]>('/reports'),
  });

  const { data: result, isFetching } = useQuery({
    queryKey: ['report', active, from, to, ownerId],
    enabled: Boolean(active),
    queryFn: () => api.get<ReportResult>(`/reports/${active}${qs({ from, to, ownerId, format: 'json' })}`),
  });

  const exportReport = async (key: string, format: 'xlsx' | 'pdf') => {
    try {
      await download(`/reports/${key}?${new URLSearchParams({ from, to, ownerId, format }).toString()}`, `zeus-${key}.${format}`);
      toast.push(`${format.toUpperCase()} downloaded.`);
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error');
    }
  };

  const cell = (value: unknown, format?: string) => {
    if (value === null || value === undefined || value === '') return <span className="text-n400">—</span>;
    if (format === 'money') return <span className="tabular">{money(value as number)}</span>;
    if (format === 'percent') return <span className="tabular">{percent(value as number, 1)}</span>;
    if (format === 'date') return <span className="text-[12px]">{date(value as string)}</span>;
    return <span>{String(value)}</span>;
  };

  if (isLoading) return <Loading label="Loading reports" />;

  return (
    <>
      <PageHeader
        title="Reports"
        description="Run it on screen, then take it away as Excel or PDF. Every report respects your role's visibility."
      />

      <div className="grid gap-3 xl:grid-cols-[320px_1fr]">
        <Card className="xl:sticky xl:top-4 xl:self-start">
          <CardHeader title="Report library" subtitle={`${reports?.length ?? 0} available`} />
          <div className="max-h-[calc(100vh-220px)] overflow-y-auto">
            {(reports ?? []).map((report) => (
              <button
                key={report.key}
                onClick={() => setActive(report.key)}
                className={cx(
                  'block w-full border-b border-line px-4 py-2.5 text-left transition-colors',
                  active === report.key ? 'border-l-[3px] border-l-accent bg-accent-soft' : 'hover:bg-sunken',
                )}
              >
                <span className="block text-[13px] font-semibold">{report.name}</span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">{report.description}</span>
              </button>
            ))}
          </div>
        </Card>

        <div>
          {!active ? (
            <Card>
              <EmptyState
                title="Pick a report"
                message="Choose one from the library to run it against the current data."
                icon={<Play size={24} />}
              />
            </Card>
          ) : (
            <Card>
              <CardHeader
                title={result?.name ?? 'Running…'}
                subtitle={`${date(from)} – ${date(to)}`}
                actions={
                  can('reports', 'export') ? (
                    <>
                      <Button size="sm" icon={<FileSpreadsheet size={13} />} onClick={() => exportReport(active, 'xlsx')}>Excel</Button>
                      <Button size="sm" icon={<FileText size={13} />} onClick={() => exportReport(active, 'pdf')}>PDF</Button>
                    </>
                  ) : undefined
                }
              />

              <Toolbar>
                <Field label="From" className="w-[150px]"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field label="To" className="w-[150px]"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
                <Field label="Owner" className="w-[170px]"><OwnerSelect value={ownerId} onChange={setOwnerId} /></Field>
              </Toolbar>

              {result?.summary?.length ? (
                <div className="flex flex-wrap gap-x-8 gap-y-3 border-b border-line bg-sunken px-4 py-3">
                  {result.summary.map(([label, value]) => (
                    <div key={label}>
                      <span className="eyebrow">{label}</span>
                      <p className="tabular mt-0.5 text-[16px] font-bold">{value}</p>
                    </div>
                  ))}
                </div>
              ) : null}

              {isFetching ? (
                <Loading label="Running report" />
              ) : !result ? null : (
                <div className="max-h-[calc(100vh-360px)] overflow-auto">
                  <DataTable
                    dense
                    rows={result.rows}
                    rowKey={(_, index) => String(index)}
                    empty={<EmptyState title="No rows" message="Nothing matched this period. Widen the date range." />}
                    columns={result.columns.map((column) => ({
                      key: column.key,
                      header: column.label,
                      align: column.align,
                      render: (row: Record<string, unknown>) => cell(row[column.key], column.format),
                    }))}
                  />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
