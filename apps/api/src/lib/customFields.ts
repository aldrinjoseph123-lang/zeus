import { prisma } from '../db.js';
import { badRequest } from './http.js';

/**
 * Custom fields let an admin add a field to any module without a migration; the values
 * live in each record's `customFields` JSON column.
 *
 * That column is a trust boundary: without this, any client could post arbitrary JSON of
 * any size into it. Everything written goes through `sanitizeCustomFields`, which keeps
 * only keys that are actually defined and active for the module, and coerces each value
 * to its declared type.
 */

export interface CustomFieldDef {
  key: string;
  label: string;
  type: string;
  options: string[];
  required: boolean;
}

// Definitions change rarely and are read on every write — cache with a short TTL
// rather than joining the table into every create.
let cache: { at: number; byModule: Map<string, CustomFieldDef[]> } | null = null;
const TTL_MS = 30_000;

export function invalidateCustomFields(): void {
  cache = null;
}

async function definitions(module: string): Promise<CustomFieldDef[]> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    const rows = await prisma.customField.findMany({
      where: { isActive: true },
      select: { module: true, key: true, label: true, type: true, options: true, required: true },
      orderBy: { order: 'asc' },
    });
    const byModule = new Map<string, CustomFieldDef[]>();
    for (const row of rows) {
      const list = byModule.get(row.module) ?? [];
      list.push(row);
      byModule.set(row.module, list);
    }
    cache = { at: Date.now(), byModule };
  }
  return cache.byModule.get(module) ?? [];
}

const MAX_TEXT = 5000;

function coerce(def: CustomFieldDef, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;

  switch (def.type) {
    case 'number':
    case 'currency': {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw badRequest(`${def.label} must be a number.`);
      return value;
    }
    case 'checkbox':
      return raw === true || raw === 'true' || raw === 1 || raw === '1';
    case 'date': {
      const date = new Date(String(raw));
      if (Number.isNaN(date.getTime())) throw badRequest(`${def.label} must be a valid date.`);
      return date.toISOString().slice(0, 10);
    }
    case 'select': {
      const value = String(raw);
      if (def.options.length && !def.options.includes(value)) {
        throw badRequest(`${def.label} must be one of: ${def.options.join(', ')}.`);
      }
      return value;
    }
    case 'multiselect': {
      const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      for (const value of values) {
        if (def.options.length && !def.options.includes(value)) {
          throw badRequest(`${def.label} must be one of: ${def.options.join(', ')}.`);
        }
      }
      return values;
    }
    case 'email': {
      const value = String(raw).trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw badRequest(`${def.label} must be a valid email address.`);
      return value;
    }
    case 'url': {
      const value = String(raw).trim();
      if (!/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(value)) throw badRequest(`${def.label} must be a valid URL.`);
      return value;
    }
    default: {
      const value = String(raw);
      if (value.length > MAX_TEXT) throw badRequest(`${def.label} is longer than ${MAX_TEXT} characters.`);
      return value;
    }
  }
}

/**
 * Keep only defined, active keys and coerce each value.
 * `existing` is merged under the incoming values so a partial update does not wipe
 * fields the form did not send.
 */
export async function sanitizeCustomFields(
  module: string,
  incoming: unknown,
  existing: Record<string, unknown> = {},
  opts: { enforceRequired?: boolean } = {},
): Promise<Record<string, unknown>> {
  const defs = await definitions(module);
  if (defs.length === 0) return {};

  const input = (incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};

  for (const def of defs) {
    const provided = Object.prototype.hasOwnProperty.call(input, def.key);
    const value = provided ? coerce(def, input[def.key]) : (existing[def.key] ?? null);

    if (opts.enforceRequired && def.required && (value === null || value === '' || (Array.isArray(value) && value.length === 0))) {
      throw badRequest(`${def.label} is required.`);
    }
    if (value !== null) merged[def.key] = value;
  }

  return merged;
}
