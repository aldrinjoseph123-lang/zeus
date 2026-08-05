import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Plus, Tags, Upload } from 'lucide-react';
import { api, ApiError, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { date, daysBetween, moneyIn, percent } from '../lib/format';
import {
  Badge, Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorNote, Field, Input,
  Loading, Modal, PageHeader, Pagination, SearchInput, Textarea, cx, useDebounced, useToast,
} from '../components/ui';
import { AccountPicker, Lookup, Toolbar } from '../components/pickers';
import { useUndo } from '../lib/undo';

/**
 * Vendor price book.
 *
 * The question here is "what do we pay for this, and is that price still good?".
 * Expiry is the thing people forget, so a lapsing price is loud rather than buried in
 * a column nobody sorts by.
 */

interface PriceEntry {
  id: string;
  cost: string | number;
  listPrice: string | number | null;
  currency: string;
  vendorSku: string | null;
  minQuantity: string | number;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  notes: string | null;
  product: { id: string; sku: string; name: string; listPrice: string | number; cost: string | number };
  vendor: { id: string; name: string } | null;
  deal: { id: string; reference: string; name: string } | null;
}

export default function PriceBook() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const undo = useUndo();
  const { can } = useAuth();

  const [search, setSearch] = useState('');
  const [expiring, setExpiring] = useState(false);
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<PriceEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<PriceEntry | null>(null);
  const debounced = useDebounced(search, 300);

  const { data, isLoading, error } = useQuery({
    queryKey: ['price-book', debounced, expiring, page],
    queryFn: () =>
      api.get<{ data: PriceEntry[]; total: number; totalPages: number; page: number }>(
        `/price-book${qs({ search: debounced, expiring: expiring || undefined, page, pageSize: 25 })}`,
      ),
    retry: false,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del<{ undoId?: string }>(`/price-book/${id}`),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['price-book'] });
      setDeleting(null);
      undo.toast('Price removed.', res.undoId);
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not remove it.', 'error'),
  });

  // A 403 here means the role cannot see cost at all — say so plainly rather than
  // showing an empty table that looks like missing data.
  if (error instanceof ApiError && error.status === 403) {
    return (
      <>
        <PageHeader title="Price book" />
        <EmptyState title="Not available to your role" message={error.message} icon={<Tags size={22} />} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Price book"
        description="What each vendor charges us, by quantity and validity. Quote and PO lines take their cost from here."
        actions={
          <>
            <Link to="/imports"><Button icon={<Upload size={14} />}>Import a price list</Button></Link>
            {can('products', 'create') ? (
              <Button variant="accent" icon={<Plus size={14} />} onClick={() => setAdding(true)}>Add price</Button>
            ) : null}
          </>
        }
      />

      <Card>
        <Toolbar>
          <SearchInput
            value={search}
            onChange={(v) => { setSearch(v); setPage(1); }}
            placeholder="Search SKU, product or vendor part number…"
            className="w-full sm:w-80"
          />
          <button
            onClick={() => { setExpiring(!expiring); setPage(1); }}
            className={
              expiring
                ? 'rounded-sharp border border-accent bg-accent px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-white'
                : 'rounded-sharp border border-line bg-white px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted hover:border-n900 hover:text-ink'
            }
          >
            Expiring in 30 days
          </button>
        </Toolbar>

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={(row) => can('products', 'update') && setEditing(row)}
              empty={
                <EmptyState
                  title="No vendor prices yet"
                  message="Import a vendor price list, or add one by hand. Until then, quote lines fall back to the catalogue cost."
                  icon={<Tags size={22} />}
                  action={<Link to="/imports"><Button variant="accent">Import a price list</Button></Link>}
                />
              }
              columns={[
                {
                  key: 'product', header: 'Item',
                  render: (row) => (
                    <span className="min-w-0">
                      <span className="block truncate font-semibold">{row.product.sku}</span>
                      <span className="block truncate text-[11px] text-muted">{row.product.name}</span>
                    </span>
                  ),
                },
                {
                  key: 'vendor', header: 'Vendor', width: '150px',
                  render: (row) => (
                    <span>
                      <span className="block text-[12px]">{row.vendor?.name ?? '—'}</span>
                      {row.vendorSku ? <span className="block text-[10px] text-n400">{row.vendorSku}</span> : null}
                    </span>
                  ),
                },
                {
                  key: 'minQuantity', header: 'From qty', align: 'right', width: '80px',
                  render: (row) => <span className="tabular text-[12px]">{Number(row.minQuantity)}</span>,
                },
                {
                  key: 'cost', header: 'Buy price', align: 'right', width: '130px',
                  render: (row) => {
                    const list = row.listPrice === null ? null : Number(row.listPrice);
                    const off = list && list > 0 ? ((list - Number(row.cost)) / list) * 100 : null;
                    return (
                      <span className="tabular">
                        <span className="block font-semibold">{moneyIn(row.cost, row.currency)}</span>
                        {off !== null ? <span className="block text-[10px] text-n400">{percent(off, 0)} off list</span> : null}
                      </span>
                    );
                  },
                },
                {
                  key: 'scope', header: 'Applies to', width: '160px',
                  render: (row) =>
                    row.deal ? (
                      <Link to={`/deals/${row.deal.id}`} onClick={(e) => e.stopPropagation()}>
                        <Badge tone="secure">Special · {row.deal.reference}</Badge>
                      </Link>
                    ) : (
                      <span className="text-[12px] text-muted">All deals</span>
                    ),
                },
                {
                  key: 'validTo', header: 'Valid to', align: 'right', width: '120px',
                  render: (row) => {
                    if (!row.validTo) return <span className="text-[12px] text-n400">Open-ended</span>;
                    const left = daysBetween(row.validTo);
                    const daysLeft = left === null ? null : -left;
                    const lapsed = daysLeft !== null && daysLeft < 0;
                    return (
                      <span className={cx('tabular text-[12px]', daysLeft !== null && daysLeft <= 30 && 'font-semibold text-accent')}>
                        <span className="block">{date(row.validTo)}</span>
                        <span className="block text-[10px] text-n400">
                          {lapsed ? `expired ${-daysLeft}d ago` : `${daysLeft}d left`}
                        </span>
                      </span>
                    );
                  },
                },
                {
                  key: 'actions', header: '', width: '70px', align: 'right',
                  render: (row) =>
                    can('products', 'delete') ? (
                      <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setDeleting(row); }}>Remove</Button>
                    ) : null,
                },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

      {adding || editing ? (
        <PriceModal entry={editing} onClose={() => { setAdding(false); setEditing(null); }} />
      ) : null}

      {deleting ? (
        <ConfirmDialog
          open
          title="Remove this price?"
          message={`${deleting.product.sku} at ${moneyIn(deleting.cost, deleting.currency)}. Lines already saved keep the cost they were given; new ones will fall back to the next best price.`}
          confirmLabel="Remove"
          danger
          loading={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </>
  );
}

export function PriceModal({ entry, dealId, registrationId, onClose }: {
  entry?: PriceEntry | null;
  /** Set when adding a special price from a deal — scopes it to that opportunity. */
  dealId?: string | null;
  registrationId?: string | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    productId: entry?.product.id ?? '',
    productLabel: entry ? `${entry.product.sku} — ${entry.product.name}` : null,
    vendorId: entry?.vendor?.id ?? '',
    cost: entry ? String(entry.cost) : '',
    listPrice: entry?.listPrice != null ? String(entry.listPrice) : '',
    vendorSku: entry?.vendorSku ?? '',
    minQuantity: entry ? String(entry.minQuantity) : '1',
    validFrom: entry?.validFrom?.slice(0, 10) ?? '',
    validTo: entry?.validTo?.slice(0, 10) ?? '',
    notes: entry?.notes ?? '',
  });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        productId: form.productId,
        vendorId: form.vendorId || null,
        cost: Number(form.cost) || 0,
        listPrice: form.listPrice ? Number(form.listPrice) : null,
        vendorSku: form.vendorSku || null,
        minQuantity: Number(form.minQuantity) || 1,
        validFrom: form.validFrom || null,
        validTo: form.validTo || null,
        notes: form.notes || null,
        ...(dealId ? { dealId } : {}),
        ...(registrationId ? { registrationId } : {}),
      };
      return entry ? api.patch(`/price-book/${entry.id}`, body) : api.post('/price-book', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['price-book'] });
      void queryClient.invalidateQueries({ queryKey: ['deal'] });
      toast.push(entry ? 'Price updated.' : 'Price added.');
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not save.'),
  });

  const margin = () => {
    const cost = Number(form.cost) || 0;
    const list = Number(form.listPrice) || 0;
    if (!cost || !list) return null;
    return ((list - cost) / list) * 100;
  };
  const off = margin();

  return (
    <Modal
      open
      onClose={onClose}
      title={dealId ? 'Special price for this deal' : entry ? 'Edit price' : 'Add a vendor price'}
      subtitle={
        dealId
          ? 'Applies to this opportunity only. It beats the standing price and never reaches another deal.'
          : 'Applies to every deal, from the quantity given, until it expires.'
      }
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!form.productId || !form.cost} loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}

        <Field label="Catalogue item" required hint="The SKU this price is for. Import the catalogue first if it is missing.">
          <Lookup<{ id: string; sku: string; name: string }>
            value={form.productId || null}
            onChange={(id, row) => setForm({ ...form, productId: id ?? '', productLabel: row ? `${row.sku} — ${row.name}` : null })}
            endpoint="/products"
            selectedLabel={form.productLabel}
            placeholder="Search the catalogue…"
            render={(row) => ({ primary: `${row.sku} — ${row.name}`, secondary: '' })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vendor" hint="Who we buy it from.">
            <AccountPicker value={form.vendorId || null} type="VENDOR" onChange={(id) => setForm({ ...form, vendorId: id ?? '' })} placeholder="Search vendors…" />
          </Field>
          <Field label="Their part number">
            <Input value={form.vendorSku} onChange={(e) => setForm({ ...form, vendorSku: e.target.value })} placeholder="CS-FAL-PRO-1Y" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Buy price" required>
            <Input type="number" min="0" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
          </Field>
          <Field label="Their list price" hint="Optional — shows the discount.">
            <Input type="number" min="0" step="0.01" value={form.listPrice} onChange={(e) => setForm({ ...form, listPrice: e.target.value })} />
          </Field>
          <Field label="From quantity" hint="A quantity break applies from here up.">
            <Input type="number" min="1" step="1" value={form.minQuantity} onChange={(e) => setForm({ ...form, minQuantity: e.target.value })} disabled={Boolean(dealId)} />
          </Field>
        </div>

        {off !== null ? (
          <p className="text-[12px] text-muted">
            That is <strong className="text-ink">{percent(off, 1)}</strong> off their list price.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Valid from">
            <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
          </Field>
          <Field label="Valid to" hint="Blank means open-ended. Zeus stops using an expired price.">
            <Input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
          </Field>
        </div>

        {form.validTo && new Date(form.validTo) < new Date() ? (
          <p className="flex items-center gap-1.5 text-[12px] text-accent">
            <AlertTriangle size={13} /> That date has already passed, so this price will not be used.
          </p>
        ) : null}

        <Field label="Notes">
          <Textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Q1 promo, SPA reference, approval email…" />
        </Field>
      </div>
    </Modal>
  );
}
