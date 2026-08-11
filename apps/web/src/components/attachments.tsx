import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileArchive, FileImage, FileSpreadsheet, FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { api, ApiError, download, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, relative } from '../lib/format';
import { Button, ConfirmDialog, EmptyState, ErrorNote, Loading, cx, useToast } from './ui';

export type AttachmentParent = 'account' | 'contact' | 'lead' | 'deal';

interface Attachment {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  uploadedBy: { id: string; name: string } | null;
}

const PARENT_MODULE: Record<AttachmentParent, string> = {
  account: 'accounts',
  contact: 'contacts',
  lead: 'leads',
  deal: 'deals',
};

function iconFor(filename: string, mime: string) {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return FileImage;
  if (['xlsx', 'xls', 'csv'].includes(ext)) return FileSpreadsheet;
  if (['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) return FileArchive;
  return FileText;
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Attachment list plus drag-and-drop upload, used on every record detail page.
 * Files download through the API rather than a public URL, so record permissions
 * still apply and nothing is served inline from the app's origin.
 */
export function AttachmentPanel({ parent, parentId }: { parent: AttachmentParent; parentId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Attachment | null>(null);

  const module = PARENT_MODULE[parent];
  const canUpload = can(module, 'update');

  const { data, isLoading } = useQuery({
    queryKey: ['attachments', parent, parentId],
    queryFn: () => api.get<Attachment[]>(`/attachments${qs({ parent, parentId })}`),
  });

  const upload = async (files: FileList | File[]) => {
    setError(null);
    setBusy(true);
    let uploaded = 0;
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        // Fields must precede the file part — the server reads them off the same stream.
        body.append('parent', parent);
        body.append('parentId', parentId);
        body.append('file', file);

        const res = await fetch('/api/attachments', { method: 'POST', credentials: 'include', body });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(res.status, (json as { error?: string }).error ?? `Upload failed (${res.status})`);
        uploaded += 1;
      }
      void queryClient.invalidateQueries({ queryKey: ['attachments', parent, parentId] });
      toast.push(`${uploaded} file${uploaded === 1 ? '' : 's'} uploaded.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/attachments/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['attachments', parent, parentId] });
      setDeleting(null);
      toast.push('File removed.');
    },
    onError: (err) => toast.push(err instanceof ApiError ? err.message : 'Could not remove the file.', 'error'),
  });

  const get = async (attachment: Attachment) => {
    try {
      await download(`/attachments/${attachment.id}/download`, attachment.filename);
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : 'Download failed.', 'error');
    }
  };

  const files = data ?? [];

  return (
    <div>
      {canUpload ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            if (e.dataTransfer.files?.length) void upload(e.dataTransfer.files);
          }}
          className={cx(
            'flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 transition-colors',
            dragging ? 'border-accent bg-accent-soft' : 'bg-sunken',
          )}
        >
          <span className="flex items-center gap-2 text-[12px] text-muted">
            <Paperclip size={13} />
            {busy ? 'Uploading…' : dragging ? 'Drop to upload' : 'Drag files here, or'}
          </span>
          <Button
            size="sm"
            icon={<Upload size={13} />}
            loading={busy}
            onClick={() => fileRef.current?.click()}
          >
            Choose files
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void upload(e.target.files);
            }}
          />
        </div>
      ) : null}

      {error ? <div className="px-4 py-2"><ErrorNote error={error} /></div> : null}

      {isLoading ? (
        <Loading label="Loading files" />
      ) : files.length === 0 ? (
        <EmptyState
          title="No files"
          message={canUpload ? 'Purchase orders, signed quotes, vendor confirmations — keep them on the record.' : 'Nothing has been attached to this record.'}
          icon={<Paperclip size={22} />}
        />
      ) : (
        <ul>
          {files.map((attachment) => {
            const Icon = iconFor(attachment.filename, attachment.mimeType);
            return (
              <li key={attachment.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-line bg-card text-muted">
                  <Icon size={15} />
                </span>
                <button onClick={() => void get(attachment)} className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[13px] font-semibold underline decoration-dotted underline-offset-2">
                    {attachment.filename}
                  </span>
                  <span className="block text-[10px] uppercase tracking-[0.08em] text-n400" title={dateTime(attachment.createdAt)}>
                    {fileSize(attachment.sizeBytes)} · {attachment.uploadedBy?.name ?? 'Unknown'} · {relative(attachment.createdAt)}
                  </span>
                </button>
                <button onClick={() => void get(attachment)} aria-label={`Download ${attachment.filename}`} className="shrink-0 text-n300 transition-colors hover:text-ink">
                  <Download size={15} />
                </button>
                {canUpload ? (
                  <button onClick={() => setDeleting(attachment)} aria-label={`Remove ${attachment.filename}`} className="shrink-0 text-n300 transition-colors hover:text-accent">
                    <Trash2 size={15} />
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={() => remove.mutate(deleting!.id)}
        loading={remove.isPending}
        title="Remove this file?"
        confirmLabel="Remove file"
        message={<><strong>{deleting?.filename}</strong> will be deleted from the server. This cannot be undone.</>}
      />
    </div>
  );
}
