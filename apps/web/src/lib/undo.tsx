import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useToast } from '../components/ui';

/**
 * Undo.
 *
 * Every mutating endpoint that can be reversed returns an `undoId` — the audit entry
 * holding the recipe. `useUndo().toast()` turns that into the ordinary success message
 * with an Undo button beside it, so the safety net costs each screen one argument.
 *
 * The header panel lists the same entries for anything already dismissed.
 */

export interface UndoEntry {
  id: string;
  action: string;
  entity: string;
  entityId: string | null;
  label: string;
  at: string;
  kind: 'soft-delete' | 'hard-delete' | 'update';
}

export function useUndo() {
  const toastApi = useToast();
  const queryClient = useQueryClient();

  const run = async (undoId: string, onDone?: () => void) => {
    try {
      const res = await api.post<{ label: string }>(`/undo/${undoId}`);
      // Everything is potentially affected by a restore, so nothing is assumed fresh.
      await queryClient.invalidateQueries();
      toastApi.push(`Undone — ${res.label.toLowerCase()} is back.`);
      onDone?.();
    } catch (err) {
      toastApi.push(err instanceof ApiError ? err.message : 'Could not undo that.', 'error');
    }
  };

  return {
    run,
    /** Success message with an Undo button when the server offered one. */
    toast: (message: string, undoId?: string | null, onDone?: () => void) =>
      toastApi.push(
        message,
        'success',
        undoId ? { label: 'Undo', onClick: () => void run(undoId, onDone) } : undefined,
      ),
  };
}

export function useRecentUndo() {
  const queryClient = useQueryClient();
  const { run } = useUndo();

  const query = useQuery({
    queryKey: ['undo-recent'],
    queryFn: () => api.get<UndoEntry[]>('/undo/recent'),
    staleTime: 15_000,
  });

  const undo = useMutation({
    mutationFn: (id: string) => run(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['undo-recent'] }),
  });

  return { entries: query.data ?? [], isLoading: query.isLoading, refetch: query.refetch, undo };
}
