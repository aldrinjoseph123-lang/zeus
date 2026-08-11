import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { date, money } from '../lib/format';
import { Checkbox, Field, Input, Select, Textarea } from './ui';

/**
 * Fields an admin added in Settings → Custom fields. Definitions come from the API;
 * values live in each record's `customFields` object. Both the form inputs and the
 * read-only display render from the same definition list, so adding a field lights it
 * up everywhere at once.
 */

export interface CustomFieldDef {
  id: string;
  module: string;
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'currency' | 'date' | 'select' | 'multiselect' | 'checkbox' | 'url' | 'email';
  options: string[];
  required: boolean;
  order: number;
}

export function useCustomFields(module: string) {
  return useQuery({
    queryKey: ['custom-fields', module],
    queryFn: () => api.get<CustomFieldDef[]>(`/custom-fields${qs({ module })}`),
    staleTime: 120_000,
  });
}

export type CustomValues = Record<string, unknown>;

/** Form inputs for every custom field on a module. Renders nothing when none exist. */
export function CustomFieldInputs({ module, values, onChange, disabled }: {
  module: string;
  values: CustomValues;
  onChange: (values: CustomValues) => void;
  disabled?: boolean;
}) {
  const { data: fields } = useCustomFields(module);
  if (!fields?.length) return null;

  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <div className="border-t border-line pt-3">
      <span className="eyebrow mb-2 block">Additional fields</span>
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map((field) => {
          const value = values[field.key];

          if (field.type === 'checkbox') {
            return (
              <div key={field.id} className="flex items-end pb-2">
                <Checkbox label={field.label} checked={value === true} disabled={disabled} onChange={(checked) => set(field.key, checked)} />
              </div>
            );
          }

          if (field.type === 'multiselect') {
            const selected = Array.isArray(value) ? (value as string[]) : [];
            return (
              <Field key={field.id} label={field.label} required={field.required} className="sm:col-span-2">
                <div className="flex flex-wrap gap-1.5">
                  {field.options.map((option) => {
                    const on = selected.includes(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={disabled}
                        onClick={() => set(field.key, on ? selected.filter((o) => o !== option) : [...selected, option])}
                        className={
                          on
                            ? 'rounded-sharp border border-n950 bg-n950 px-2.5 py-1 text-[11px] font-semibold text-white'
                            : 'rounded-sharp border border-line bg-card px-2.5 py-1 text-[11px] text-muted transition-colors hover:border-n900 hover:text-ink'
                        }
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              </Field>
            );
          }

          return (
            <Field
              key={field.id}
              label={field.label}
              required={field.required}
              className={field.type === 'textarea' ? 'sm:col-span-2' : undefined}
            >
              {field.type === 'textarea' ? (
                <Textarea rows={2} value={String(value ?? '')} disabled={disabled} onChange={(e) => set(field.key, e.target.value)} />
              ) : field.type === 'select' ? (
                <Select
                  value={String(value ?? '')}
                  disabled={disabled}
                  placeholder="—"
                  options={field.options.map((option) => ({ value: option, label: option }))}
                  onChange={(e) => set(field.key, e.target.value)}
                />
              ) : (
                <Input
                  type={field.type === 'number' || field.type === 'currency' ? 'number' : field.type === 'date' ? 'date' : field.type === 'email' ? 'email' : 'text'}
                  step={field.type === 'currency' ? '0.01' : undefined}
                  value={String(value ?? '')}
                  disabled={disabled}
                  onChange={(e) => set(field.key, field.type === 'number' || field.type === 'currency' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
                />
              )}
            </Field>
          );
        })}
      </div>
    </div>
  );
}

export function formatCustomValue(field: CustomFieldDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field.type === 'checkbox') return value ? 'Yes' : 'No';
  if (field.type === 'currency') return money(value, true);
  if (field.type === 'date') return date(String(value));
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

/** Read-only rows for a record detail page. Returns null when no fields are defined. */
export function CustomFieldValues({ module, values }: { module: string; values: CustomValues | null | undefined }) {
  const { data: fields } = useCustomFields(module);
  if (!fields?.length) return null;

  const record = values ?? {};

  return (
    <div className="mt-4 border-t border-line pt-3">
      <span className="eyebrow mb-2 block">Additional fields</span>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
        {fields.map((field) => {
          const value = record[field.key];
          const text = formatCustomValue(field, value);
          return (
            <div key={field.id} className="min-w-0">
              <dt className="eyebrow">{field.label}</dt>
              <dd className="mt-0.5 break-words text-[13px]">
                {field.type === 'url' && value ? (
                  <a
                    href={String(value).startsWith('http') ? String(value) : `https://${value}`}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-dotted underline-offset-2"
                  >
                    {text}
                  </a>
                ) : field.type === 'email' && value ? (
                  <a href={`mailto:${value}`} className="underline decoration-dotted underline-offset-2">{text}</a>
                ) : (
                  text
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}
