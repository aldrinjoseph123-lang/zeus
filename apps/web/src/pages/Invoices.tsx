import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money } from '../lib/format';
import {
  Button, Card, DataTable, EmptyState, Loading, PageHeader,
  Pagination, SearchInput, Select, StatTile, Tabs, useDebounced, useToast,
} from '../components/ui';
import { Toolbar } from '../components/pickers';
import { StatusPill } from '../components/payments';
import { LifecycleMini, invoiceTrack } from '../components/lifecycle';

interface Invoice {
  id: string; number: string; status: string; issueDate: string; dueDate: string | null;
  subtotal: string | number; vatAmount: string | number; total: string | number; amountPaid: string | number;
  poNumber: string | null;
  account: { id: string; name: string };
  deal: { id: string; reference: string } | null;
}

export default function Invoices() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [page, setPage] = useState(1);
  const [docType, setDocType] = useState('TAX_INVOICE');
  const debounced = useDebounced(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', debounced, status, overdue, docType, page],
    queryFn: () =>
      api.get<{ data: Invoice[]; total: number; totalPages: number; page: number; totals: { invoiced: number; paid: number; outstanding: number } }>(
        `/invoices${qs({ search: debounced, status, type: docType, overdue: overdue || undefined, page, pageSize: 25 })}`,
      ),
  });

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Raised from accepted quotes. Zeus tracks what is outstanding — your accounting system stays the book of record."
        actions={
          <>
          {can('invoices', 'create') ? (
            <Link to="/invoices/new"><Button variant="accent" icon={<Plus size={14} />}>New invoice</Button></Link>
          ) : null}
          {can('invoices', 'export') ? (
            <Button
              icon={<Download size={14} />}
              onClick={() => download('/reports/receivables?format=xlsx', 'zeus-receivables.xlsx').catch((err) => toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error'))}
            >
              Ageing (Excel)
            </Button>
          ) : null}
          </>
        }
      />

      {data?.totals ? (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile label="Invoiced" value={money(data.totals.invoiced)} sub={`${data.total} invoice${data.total === 1 ? '' : 's'} in view`} />
          <StatTile label="Received" value={money(data.totals.paid)} tone="secure" />
          <StatTile label="Outstanding" value={money(data.totals.outstanding)} tone={data.totals.outstanding > 0 ? 'watch' : 'default'} />
        </div>
      ) : null}

      <Card>
        <Tabs
          tabs={[{ key: 'TAX_INVOICE', label: 'Tax invoices' }, { key: 'CREDIT_NOTE', label: 'Credit notes' }]}
          active={docType}
          onChange={(key) => { setDocType(key); setPage(1); }}
        />
        <Toolbar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search number, PO, customer…" className="w-full sm:w-72" />
          <Select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            placeholder="All statuses"
            options={['DRAFT', 'SENT', 'PARTIAL', 'PAID', 'OVERDUE', 'CANCELLED'].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
            className="w-[150px]"
          />
          <button
            onClick={() => { setOverdue(!overdue); setPage(1); }}
            className={
              overdue
                ? 'rounded-sharp border border-accent bg-accent px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-white'
                : 'rounded-sharp border border-line bg-card px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted hover:border-n900 hover:text-ink'
            }
          >
            Overdue only
          </button>
        </Toolbar>

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/invoices/${row.id}`)}
              empty={<EmptyState title="No invoices" message="Accept a quote, then raise the invoice from it." />}
              columns={[
                { key: 'number', header: 'Invoice', width: '140px', render: (row) => <span className="font-semibold">{row.number}</span> },
                {
                  key: 'account', header: 'Customer',
                  render: (row) => (
                    <span>
                      <Link to={`/accounts/${row.account.id}`} onClick={(e) => e.stopPropagation()} className="block font-semibold underline decoration-dotted underline-offset-2">{row.account.name}</Link>
                      {row.poNumber ? <span className="block text-[11px] text-muted">PO {row.poNumber}</span> : null}
                    </span>
                  ),
                },
                { key: 'status', header: 'Status', width: '104px', render: (row) => <StatusPill status={row.status} /> },
                { key: 'track', header: 'Progress', width: '80px', render: (row) => <LifecycleMini track={invoiceTrack(row.status)} /> },
                { key: 'issueDate', header: 'Issued', width: '104px', render: (row) => <span className="text-[12px] text-muted">{date(row.issueDate)}</span> },
                {
                  key: 'dueDate', header: 'Due', width: '104px',
                  render: (row) => (
                    <span className={row.dueDate && new Date(row.dueDate) < new Date() && row.status !== 'PAID' ? 'text-[12px] font-semibold text-accent' : 'text-[12px] text-muted'}>
                      {date(row.dueDate)}
                    </span>
                  ),
                },
                { key: 'vatAmount', header: 'VAT', align: 'right', width: '100px', render: (row) => <span className="tabular text-muted">{money(row.vatAmount)}</span> },
                { key: 'total', header: 'Total', align: 'right', width: '120px', render: (row) => <span className="tabular font-semibold">{money(row.total)}</span> },
                {
                  key: 'outstanding', header: 'Outstanding', align: 'right', width: '120px',
                  render: (row) => {
                    const left = Number(row.total) - Number(row.amountPaid);
                    return <span className={left > 0 ? 'tabular font-semibold text-accent' : 'tabular text-muted'}>{money(left)}</span>;
                  },
                },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

    </>
  );
}
