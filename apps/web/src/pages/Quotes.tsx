import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money, percent } from '../lib/format';
import {
  Badge, Button, Card, DataTable, EmptyState, Loading, PageHeader, Pagination, SearchInput,
  Select, useDebounced, useToast,
} from '../components/ui';
import { Toolbar } from '../components/pickers';
import { LifecycleMini, quoteTrack } from '../components/lifecycle';

interface Quote {
  id: string; number: string; version: number; status: string; issueDate: string; validUntil: string | null;
  subtotal: string | number; discountAmt: string | number; vatAmount: string | number; total: string | number;
  marginAmount?: string | number; totalCost?: string | number;
  account: { id: string; name: string };
  deal: { id: string; reference: string } | null;
  preparedBy: { id: string; name: string } | null;
}

const STATUS_TONE: Record<string, 'neutral' | 'info' | 'secure' | 'accent' | 'watch'> = {
  DRAFT: 'neutral', SENT: 'info', ACCEPTED: 'secure', REJECTED: 'accent', EXPIRED: 'watch',
};

export default function Quotes() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can, sees } = useAuth();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['quotes', debounced, status, page],
    queryFn: () => api.get<{ data: Quote[]; total: number; totalPages: number; page: number }>(`/quotes${qs({ search: debounced, status, page, pageSize: 25 })}`),
  });

  const showMargin = sees('quotes', 'marginAmount');

  return (
    <>
      <PageHeader
        title="Quotations"
        description="AED, 5% VAT applied to taxable lines. Every quote prints on the Zeus letterhead."
        actions={
          <>
            {can('quotes', 'export') ? (
              <Button
                icon={<Download size={14} />}
                onClick={() => download(`/reports/quotes?format=xlsx${qs({ status })}`, 'zeus-quotes.xlsx').catch((err) => toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error'))}
              >
                Excel
              </Button>
            ) : null}
            {can('quotes', 'create') ? (
              <Link to="/quotes/new"><Button variant="accent" icon={<Plus size={14} />}>New quote</Button></Link>
            ) : null}
          </>
        }
      />

      <Card>
        <Toolbar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search number or customer…" className="w-full sm:w-72" />
          <Select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            placeholder="All statuses"
            options={['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
            className="w-[150px]"
          />
        </Toolbar>

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/quotes/${row.id}`)}
              empty={<EmptyState title="No quotes yet" message="Build one from a deal, and Zeus keeps the deal value in step with it." />}
              columns={[
                {
                  key: 'number', header: 'Number', width: '130px',
                  render: (row) => (
                    <span>
                      <span className="block font-semibold">{row.number}</span>
                      {row.version > 1 ? <span className="block text-[11px] text-muted">v{row.version}</span> : null}
                    </span>
                  ),
                },
                { key: 'account', header: 'Customer', render: (row) => <span className="font-semibold">{row.account.name}</span> },
                { key: 'deal', header: 'Deal', width: '110px', render: (row) => row.deal ? <span className="text-[12px] text-muted">{row.deal.reference}</span> : <span className="text-n400">—</span> },
                { key: 'status', header: 'Status', width: '104px', render: (row) => <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{row.status}</Badge> },
                { key: 'track', header: 'Progress', width: '72px', render: (row) => <LifecycleMini track={quoteTrack(row.status)} /> },
                { key: 'issueDate', header: 'Issued', width: '104px', render: (row) => <span className="text-[12px] text-muted">{date(row.issueDate)}</span> },
                {
                  key: 'validUntil', header: 'Valid to', width: '104px',
                  render: (row) => (
                    <span className={row.validUntil && new Date(row.validUntil) < new Date() && row.status === 'SENT' ? 'text-[12px] font-semibold text-accent' : 'text-[12px] text-muted'}>
                      {date(row.validUntil)}
                    </span>
                  ),
                },
                { key: 'subtotal', header: 'Net', align: 'right', width: '110px', render: (row) => <span className="tabular">{money(Number(row.subtotal) - Number(row.discountAmt))}</span> },
                { key: 'vatAmount', header: 'VAT', align: 'right', width: '96px', render: (row) => <span className="tabular text-muted">{money(row.vatAmount)}</span> },
                { key: 'total', header: 'Total', align: 'right', width: '120px', render: (row) => <span className="tabular font-semibold">{money(row.total)}</span> },
                ...(showMargin
                  ? [{
                      key: 'margin', header: 'Margin', align: 'right' as const, width: '110px',
                      render: (row: Quote) => {
                        const net = Number(row.subtotal) - Number(row.discountAmt);
                        const marginPct = net > 0 ? (Number(row.marginAmount ?? 0) / net) * 100 : 0;
                        return (
                          <span className="tabular">
                            <span className="block font-semibold">{money(row.marginAmount ?? 0)}</span>
                            <span className="block text-[11px] text-muted">{percent(marginPct, 1)}</span>
                          </span>
                        );
                      },
                    }]
                  : []),
                { key: 'preparedBy', header: 'By', width: '120px', render: (row) => <span className="text-[12px]">{row.preparedBy?.name ?? '—'}</span> },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
