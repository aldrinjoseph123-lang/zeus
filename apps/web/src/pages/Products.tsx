import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, ApiError, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, percent } from '../lib/format';
import {
  Badge, Button, Card, DataTable, EmptyState, ErrorNote, Field, Input, Loading, Modal,
  PageHeader, Pagination, SearchInput, Select, Textarea, useDebounced, useToast,
} from '../components/ui';
import { AccountPicker, ListSelect, Toolbar } from '../components/pickers';

interface Product {
  id: string; sku: string; name: string; type: string; category: string | null; unit: string;
  listPrice: string | number; cost?: string | number; taxable: boolean; isActive: boolean;
  description: string | null;
  vendor: { id: string; name: string } | null;
}

export default function Products() {
  const { can, sees } = useAuth();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const debounced = useDebounced(search, 300);

  const showCost = sees('products', 'cost');

  const { data, isLoading } = useQuery({
    queryKey: ['products', debounced, type, category, page],
    queryFn: () => api.get<{ data: Product[]; total: number; totalPages: number; page: number }>(`/products${qs({ search: debounced, type, category, page, pageSize: 25 })}`),
  });

  return (
    <>
      <PageHeader
        title="Catalog"
        description="Vendor products and managed service lines, with the sell and buy price behind each quote line."
        actions={can('products', 'create') ? <Button variant="accent" icon={<Plus size={14} />} onClick={() => setCreating(true)}>New item</Button> : undefined}
      />

      <Card>
        <Toolbar>
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search SKU, name, vendor…" className="w-full sm:w-72" />
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} placeholder="All types" options={[{ value: 'PRODUCT', label: 'Products' }, { value: 'SERVICE', label: 'Services' }]} className="w-[140px]" />
          <ListSelect listKey="lists.productCategories" value={category} onChange={(v) => { setCategory(v); setPage(1); }} placeholder="All categories" className="w-[190px]" />
        </Toolbar>

        {isLoading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={data?.data ?? []}
              rowKey={(row) => row.id}
              onRowClick={can('products', 'update') ? (row) => setEditing(row) : undefined}
              empty={<EmptyState title="Catalog is empty" message="Add items by hand, or bring your vendor price list in through Import." />}
              columns={[
                { key: 'sku', header: 'SKU', width: '130px', render: (row) => <span className="text-[12px] font-semibold">{row.sku}</span> },
                {
                  key: 'name', header: 'Item',
                  render: (row) => (
                    <span>
                      <span className="block font-semibold">{row.name}</span>
                      <span className="block text-[11px] text-muted">{row.vendor?.name ?? 'No vendor'}{row.category ? ` · ${row.category}` : ''}</span>
                    </span>
                  ),
                },
                { key: 'type', header: 'Type', width: '96px', render: (row) => <Badge tone={row.type === 'SERVICE' ? 'info' : 'neutral'}>{row.type}</Badge> },
                { key: 'unit', header: 'Unit', width: '90px', render: (row) => <span className="text-[12px] text-muted">{row.unit}</span> },
                { key: 'listPrice', header: 'Sell', align: 'right', width: '112px', render: (row) => <span className="tabular font-semibold">{money(row.listPrice, true)}</span> },
                ...(showCost
                  ? [
                      { key: 'cost', header: 'Cost', align: 'right' as const, width: '112px', render: (row: Product) => <span className="tabular text-muted">{money(row.cost ?? 0, true)}</span> },
                      {
                        key: 'margin', header: 'Margin', align: 'right' as const, width: '92px',
                        render: (row: Product) => {
                          const sell = Number(row.listPrice);
                          const marginPct = sell > 0 ? ((sell - Number(row.cost ?? 0)) / sell) * 100 : 0;
                          return <span className={marginPct < 10 ? 'tabular text-accent' : 'tabular'}>{percent(marginPct, 1)}</span>;
                        },
                      },
                    ]
                  : []),
                { key: 'taxable', header: 'VAT', align: 'center', width: '64px', render: (row) => row.taxable ? <span className="text-[12px]">5%</span> : <Badge tone="neutral">Zero</Badge> },
                { key: 'isActive', header: '', width: '90px', render: (row) => row.isActive ? null : <Badge tone="neutral">Inactive</Badge> },
              ]}
            />
            <Pagination page={data?.page ?? 1} totalPages={data?.totalPages ?? 1} total={data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>

      {creating || editing ? (
        <ProductModal product={editing} onClose={() => { setCreating(false); setEditing(null); }} />
      ) : null}
    </>
  );
}

function ProductModal({ product, onClose }: { product: Product | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { sees } = useAuth();
  const showCost = sees('products', 'cost');

  const [form, setForm] = useState({
    sku: product?.sku ?? '',
    name: product?.name ?? '',
    type: product?.type ?? 'PRODUCT',
    category: product?.category ?? '',
    vendorId: product?.vendor?.id ?? '',
    unit: product?.unit ?? 'licence',
    listPrice: String(product?.listPrice ?? ''),
    cost: String(product?.cost ?? ''),
    taxable: product?.taxable ?? true,
    isActive: product?.isActive ?? true,
    description: product?.description ?? '',
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        sku: form.sku.trim(),
        name: form.name.trim(),
        type: form.type,
        category: form.category || null,
        vendorId: form.vendorId || null,
        unit: form.unit,
        listPrice: Number(form.listPrice || 0),
        ...(showCost ? { cost: Number(form.cost || 0) } : {}),
        taxable: form.taxable,
        isActive: form.isActive,
        description: form.description || null,
      };
      return product ? api.patch(`/products/${product.id}`, body) : api.post('/products', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['products'] });
      toast.push(product ? 'Item updated.' : 'Item added.');
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  const sell = Number(form.listPrice || 0);
  const marginPct = sell > 0 ? ((sell - Number(form.cost || 0)) / sell) * 100 : 0;

  return (
    <Modal
      open
      onClose={onClose}
      title={product ? 'Edit catalog item' : 'New catalog item'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="accent" disabled={!form.sku.trim() || !form.name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            {product ? 'Save changes' : 'Add item'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorNote error={error} /> : null}

        <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
          <Field label="SKU" required hint="Vendor part number.">
            <Input value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} disabled={Boolean(product)} />
          </Field>
          <Field label="Name" required>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} options={[{ value: 'PRODUCT', label: 'Product' }, { value: 'SERVICE', label: 'Service' }]} />
          </Field>
          <Field label="Category">
            <ListSelect listKey="lists.productCategories" value={form.category} onChange={(v) => setForm({ ...form, category: v })} placeholder="—" />
          </Field>
          <Field label="Billing unit">
            <ListSelect listKey="lists.units" value={form.unit} onChange={(v) => setForm({ ...form, unit: v })} />
          </Field>
        </div>

        <Field label="Vendor">
          <AccountPicker value={form.vendorId || null} type="VENDOR" selectedLabel={product?.vendor?.name} onChange={(id) => setForm({ ...form, vendorId: id ?? '' })} placeholder="Search vendors…" />
        </Field>

        <div className={showCost ? 'grid gap-3 sm:grid-cols-3' : 'grid gap-3 sm:grid-cols-2'}>
          <Field label="Sell price (AED)">
            <Input type="number" min="0" step="0.01" value={form.listPrice} onChange={(e) => setForm({ ...form, listPrice: e.target.value })} />
          </Field>
          {showCost ? (
            <Field label="Cost (AED)">
              <Input type="number" min="0" step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
            </Field>
          ) : null}
          {showCost ? (
            <Field label="Margin">
              <div className="rounded-sharp border border-line bg-sunken px-3 py-2 text-[13px]">
                <span className={marginPct < 10 ? 'tabular font-semibold text-accent' : 'tabular font-semibold'}>{percent(marginPct, 1)}</span>
                <span className="ml-2 text-muted">{money(sell - Number(form.cost || 0), true)}</span>
              </div>
            </Field>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={form.taxable} onChange={(e) => setForm({ ...form, taxable: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
            Subject to 5% VAT
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} className="h-4 w-4 accent-[var(--red-500)]" />
            Available for quoting
          </label>
        </div>

        <Field label="Description">
          <Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
      </div>
    </Modal>
  );
}
