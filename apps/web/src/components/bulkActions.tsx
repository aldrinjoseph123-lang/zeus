import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, ConfirmDialog, useToast } from './ui';
import { OwnerSelect } from './pickers';

/**
 * Row selection for a list page. Deals' bulk bar predates this and stays inline
 * (working, tested, not worth the churn to migrate) — every list added since reuses
 * this instead of repeating the same Set-of-ids plumbing.
 */
export function useBulkSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return {
    selected,
    clear: () => setSelected(new Set()),
    toggle: (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }),
    toggleAll: (ids: string[]) => setSelected((s) => (ids.every((id) => s.has(id)) ? new Set() : new Set(ids))),
  };
}

/**
 * The reassign/delete bar shown above a list once rows are selected. Assumes the
 * module has `POST {basePath}/bulk-assign` and `POST {basePath}/bulk-delete`
 * endpoints with the deals-established shape: `{ ids, ownerId? }` in,
 * `{ updated|deleted, skipped }` out.
 */
export function BulkActionBar({
  basePath, selected, onClear, canAssign, canDelete, queryKey, noun = 'record',
}: {
  basePath: string;
  selected: Set<string>;
  onClear: () => void;
  canAssign: boolean;
  canDelete: boolean;
  queryKey: string;
  noun?: string;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [bulkOwner, setBulkOwner] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const afterBulk = (msg: string) => {
    onClear();
    void queryClient.invalidateQueries({ queryKey: [queryKey] });
    toast.push(msg);
  };
  const bulkAssign = useMutation({
    mutationFn: () => api.post<{ updated: number; skipped: number }>(`${basePath}/bulk-assign`, { ids: [...selected], ownerId: bulkOwner }),
    onSuccess: (r) => { setBulkOwner(''); afterBulk(`${r.updated} reassigned${r.skipped ? `, ${r.skipped} skipped` : ''}.`); },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not reassign.', 'error'),
  });
  const bulkDelete = useMutation({
    mutationFn: () => api.post<{ deleted: number; skipped: number }>(`${basePath}/bulk-delete`, { ids: [...selected] }),
    onSuccess: (r) => { setConfirmDelete(false); afterBulk(`${r.deleted} deleted${r.skipped ? `, ${r.skipped} skipped` : ''}.`); },
    onError: (err) => { setConfirmDelete(false); toast.push(err instanceof ApiError ? err.message : 'Could not delete.', 'error'); },
  });

  if (!selected.size || (!canAssign && !canDelete)) return null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-3 py-2">
        <span className="text-[12px] font-semibold">{selected.size} selected</span>
        {canAssign ? (
          <span className="flex items-center gap-1.5">
            <OwnerSelect value={bulkOwner} onChange={setBulkOwner} className="w-[170px]" />
            <Button size="sm" disabled={!bulkOwner || bulkAssign.isPending} loading={bulkAssign.isPending} onClick={() => bulkAssign.mutate()}>Assign</Button>
          </span>
        ) : null}
        {canDelete ? (
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>Delete</Button>
        ) : null}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>Clear</Button>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => bulkDelete.mutate()}
        loading={bulkDelete.isPending}
        title={`Delete ${selected.size} ${noun}${selected.size === 1 ? '' : 's'}?`}
        confirmLabel="Delete"
        message="Archived rather than destroyed — can be restored from the audit trail."
      />
    </>
  );
}
