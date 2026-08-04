import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, money } from '../lib/format';
import {
  Button, Card, DataTable, EmptyState, Loading, PageHeader, Pagination, SearchInput,
  Select, StatTile, Tabs, cx, useDebounced, useToast,
} from '../components/ui';
import { StatusPill } from '../components/payments';
import { Toolbar } from '../components/pickers';
import { LifecycleMini, poTrack } from '../components/lifecycle';

interface PoRow {
  id: string; number: string; direction: 'CUSTOMER' | 'SUPPLIER'; status: string;
  orderDate: string; expectedDate: string | null; paymentDueDate: string | null;
  currency: string; total: string | number; amountPaid: string | number;
  supplierInvoiceNumber: string | null;
  account: { id: string; name: string; type: string };
  deal: { id: string; reference: string } | null;
  owner: { id: string; name: string } | null;
  _count: { lines: number };
}

export default function PurchaseOrders() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();

  const [direction, setDirection] = useState<'SUPPLIER' | 'CUSTOMER'>('SUPPLIER');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search, 300);

  const { data, isLoading } = useQuery({
    queryKey: ['purchase-orders', direction, debounced, status, page],
    queryFn: () =>
      api.get<{ data: PoRow[]; total: number; totalPages: number; page: number; totals: { ordered: number; paid: number; outstanding: number } }>(
        `/purchase-orders${qs({ direction, search: debounced, status, page, pageSize: 25 })}`,
      ),
  });

  const { data: position } = useQuery({
    queryKey: ['cash-position'],
    queryFn: () => api.get<{ receivable: { outstanding: number; overdue: number; dueThisWeek: number }; payable: { outstanding: number; overdue: number; dueThisWeek: number } }>('/payments/position'),
  });

  const isSupplier = direction === 'SUPPLIER';

  return (
    <>
      <PageHeader
        title="Purchase orders"
        description={
          isSupplier
            ? 'Orders you issue to vendors. These create what you owe.'
            : 'Orders your customers sent you. Evidence that the quote was accepted.'
        }
        actions={
          can('invoices', 'create') ? (
            <Link to={`/purchase-orders/new?direction=${direction}`}>
              <Button variant="accent" icon={<Plus size={14} />}>
                {isSupplier ? 'New supplier PO' : 'Record customer PO'}
              </Button>
            </Link>
          ) : undefined
        }
      />

      {position ? (
        <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            label="You owe suppliers"
            value={money(position.payable.outstanding)}
            sub={position.payable.overdue > 0 ? `${money(position.payable.overdue)} already overdue` : `${money(position.payable.dueThisWeek)} due this week`}
            tone={position.payable.overdue > 0 ? 'accent' : 'watch'}
          />
          <StatTile
            label="Customers owe you"
            value={money(position.receivable.outstanding)}
            sub={position.receivable.overdue > 0 ? `${money(position.receivable.overdue)} already overdue` : `${money(position.receivable.dueThisWeek)} due this week`}
            tone="secure"
          />
          <StatTile
            label="Net position"
            value={money(position.receivable.outstanding - position.payable.outstanding)}
            sub="Receivable less payable"
          />
        </div>
      ) : null}

      <Card>
        <Tabs
          tabs={[
            { key: 'SUPPLIER', label: 'Issued to suppliers' },
            { key: 'CUSTOMER', label: 'Received from customers' },
          ]}
          active={direction}
          onChange={(key) => { setDirection(key as 'SUPPLIER' | 'CUSTOMER'); setPage(1); setStatus(''); }}
        />

        <Toolbar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search number, vendor invoice, company…" className="w-full sm:w-72" />
          <Select
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            placeholder="All statuses"
            options={['DRAFT', 'ISSUED', 'ACKNOWLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'].map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
            className="w-[180px]"
          />
          {can('invoices', 'export') ? (
            <Button
              size="sm"
              className="ml-auto"
              icon={<Download size={13} />}
              onClick={() => download(`/reports/receivables?format=xlsx`, 'zeus-receivables.xlsx').catch((err) => toast.push(err instanceof ApiError ? err.message : 'Export failed.', 'error'))}
            >
              Excel
            </Button>
          ) : null}
        </Toolbar>

        {data?.totals ? (
          <div className="flex flex-wrap gap-6 border-b border-line bg-sunken px-3 py-2">
            <span className="text-[12px] text-muted">Ordered <strong className="tabular ml-1 text-[14px] text-ink">{money(data.totals.ordered)}</strong></span>
            <span className="text-[12px] text-muted">{isSupplier ? 'Paid' : 'Settled'} <strong className="tabular ml-1 text-[14px] text-ink">{money(data.totals.paid)}</strong></span>
            <span className="text-[12px] text-muted">Outstanding <strong className="tabular ml-1 text-[14px] text-accent">{money(data.totals.outstanding)}</strong></span>
          </div>
        ) : null}

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/purchase-orders/${row.id}`)}
              empty={
                <EmptyState
                  title={isSupplier ? 'No supplier orders' : 'No customer orders recorded'}
                  message={
                    isSupplier
                      ? 'Raise one from a won quote and the lines come across at cost automatically.'
                      : "Record the PO your customer sent so the order is evidenced against the deal."
                  }
                />
              }
              columns={[
                { key: 'number', header: 'Number', width: '150px', render: (row) => <span className="font-semibold">{row.number}</span> },
                {
                  key: 'account', header: isSupplier ? 'Supplier' : 'Customer',
                  render: (row) => (
                    <span>
                      <span className="block font-semibold">{row.account.name}</span>
                      {row.deal ? <span className="block text-[11px] text-muted">{row.deal.reference}</span> : null}
                    </span>
                  ),
                },
                { key: 'status', header: 'Status', width: '140px', render: (row) => <StatusPill status={row.status} /> },
                { key: 'track', header: 'Progress', width: '104px', render: (row) => <LifecycleMini track={poTrack(row.status)} /> },
                { key: 'orderDate', header: 'Ordered', width: '104px', render: (row) => <span className="text-[12px] text-muted">{date(row.orderDate)}</span> },
                ...(isSupplier
                  ? [{
                      key: 'expectedDate', header: 'Expected', width: '104px',
                      render: (row: PoRow) => <span className="text-[12px] text-muted">{date(row.expectedDate)}</span>,
                    }]
                  : []),
                {
                  key: 'paymentDueDate', header: 'Payment due', width: '112px',
                  render: (row) => {
                    const owed = Number(row.total) - Number(row.amountPaid);
                    const late = row.paymentDueDate && new Date(row.paymentDueDate) < new Date() && owed > 0;
                    return <span className={cx('text-[12px]', late ? 'font-semibold text-accent' : 'text-muted')}>{date(row.paymentDueDate)}</span>;
                  },
                },
                { key: 'total', header: 'Total', align: 'right', width: '120px', render: (row) => <span className="tabular font-semibold">{money(row.total)}</span> },
                {
                  key: 'outstanding', header: 'Outstanding', align: 'right', width: '120px',
                  render: (row) => {
                    const owed = Number(row.total) - Number(row.amountPaid);
                    return <span className={owed > 0 ? 'tabular font-semibold text-accent' : 'tabular text-muted'}>{money(owed)}</span>;
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
