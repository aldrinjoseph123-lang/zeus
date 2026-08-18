import { prisma } from '../db.js';

/**
 * RBAC model
 * ----------
 * A Role holds a JSON permission map. Every module gets a scope for read/update/delete
 * ("all" | "team" | "own" | "none"), a boolean for create/export, and an optional
 * field-level map so a rep can work a deal without ever seeing `cost` or `margin`.
 *
 * Nothing here is hard-coded per role — the Roles screen edits this JSON, so new roles
 * (Partner Manager, Finance, Intern) need no code change.
 */

export const MODULES = [
  'dashboard',
  'leads',
  'accounts',
  'contacts',
  'deals',
  'quotes',
  'invoices',
  'products',
  'activities',
  'reports',
  'imports',
  'users',
  'roles',
  'settings',
  'integrations',
  'backups',
  'audit',
] as const;

export type Module = (typeof MODULES)[number];
export type Scope = 'all' | 'team' | 'own' | 'none';
export type FieldAccess = 'hidden' | 'read' | 'write';

export interface ModulePermission {
  read: Scope;
  create: boolean;
  update: Scope;
  delete: Scope;
  export: boolean;
  /**
   * May sign off someone else's work — releasing a deal to won, a PO to the supplier,
   * an invoice to the customer. Left undefined on roles written before approvals
   * existed, which `can()` reads as "whoever can already edit every record".
   */
  approve?: boolean;
  fields?: Record<string, FieldAccess>;
}

export type PermissionMap = Record<string, ModulePermission>;

/** Fields worth protecting per module — surfaced in the Roles editor. */
export const PROTECTED_FIELDS: Partial<Record<Module, string[]>> = {
  deals: ['cost', 'margin'],
  quotes: ['totalCost', 'marginAmount', 'unitCost'],
  products: ['cost'],
  invoices: ['amountPaid'],
  accounts: ['trn'],
};

const NONE: ModulePermission = { read: 'none', create: false, update: 'none', delete: 'none', export: false, approve: false };


function fullAccess(): ModulePermission {
  return { read: 'all', create: true, update: 'all', delete: 'all', export: true, approve: true };
}

function scoped(read: Scope, update: Scope, create = true, del: Scope = 'none', exp = true, approve = false): ModulePermission {
  return { read, create, update, delete: del, export: exp, approve };
}

/** The four roles that ship on install. Every one of them is editable afterwards. */
export const SYSTEM_ROLES: Array<{ name: string; description: string; permissions: PermissionMap }> = [
  {
    name: 'Administrator',
    description: 'Full control including users, roles, settings and integrations.',
    permissions: Object.fromEntries(MODULES.map((m) => [m, fullAccess()])) as PermissionMap,
  },
  {
    name: 'Sales Manager',
    description: 'Sees and edits everything commercial across the whole team. No system settings.',
    permissions: {
      ...(Object.fromEntries(MODULES.map((m) => [m, NONE])) as PermissionMap),
      dashboard: fullAccess(),
      leads: fullAccess(),
      accounts: fullAccess(),
      contacts: fullAccess(),
      deals: fullAccess(),
      quotes: fullAccess(),
      // The sales manager is the sign-off on money leaving or landing.
      invoices: scoped('all', 'all', true, 'none', true, true),
      products: scoped('all', 'all', true, 'none'),
      activities: fullAccess(),
      reports: scoped('all', 'all', true, 'all'),
      imports: scoped('all', 'all', true, 'none'),
      users: scoped('all', 'none', false, 'none', false),
      audit: scoped('all', 'none', false, 'none', true),
    },
  },
  {
    name: 'Sales Executive',
    description: 'Works own and team records. Cost and margin hidden.',
    permissions: {
      ...(Object.fromEntries(MODULES.map((m) => [m, NONE])) as PermissionMap),
      dashboard: scoped('own', 'none', false, 'none', false),
      leads: scoped('team', 'own', true, 'none'),
      accounts: scoped('team', 'own', true, 'none'),
      contacts: scoped('team', 'own', true, 'none'),
      deals: { ...scoped('team', 'own', true, 'none'), fields: { cost: 'hidden', margin: 'hidden' } },
      quotes: { ...scoped('team', 'own', true, 'none'), fields: { totalCost: 'hidden', marginAmount: 'hidden', unitCost: 'hidden' } },
      invoices: scoped('team', 'none', false, 'none', false),
      products: { ...scoped('all', 'none', false, 'none', false), fields: { cost: 'hidden' } },
      activities: scoped('team', 'own', true, 'own'),
      reports: scoped('own', 'none', false, 'none', true),
    },
  },
  {
    name: 'Read Only',
    description: 'Sees everything commercial, changes nothing. Cost and margin hidden.',
    permissions: {
      ...(Object.fromEntries(MODULES.map((m) => [m, NONE])) as PermissionMap),
      dashboard: scoped('all', 'none', false, 'none', false),
      leads: scoped('all', 'none', false, 'none', true),
      accounts: scoped('all', 'none', false, 'none', true),
      contacts: scoped('all', 'none', false, 'none', true),
      deals: { ...scoped('all', 'none', false, 'none', true), fields: { cost: 'hidden', margin: 'hidden' } },
      quotes: { ...scoped('all', 'none', false, 'none', true), fields: { totalCost: 'hidden', marginAmount: 'hidden', unitCost: 'hidden' } },
      invoices: scoped('all', 'none', false, 'none', true),
      products: { ...scoped('all', 'none', false, 'none', true), fields: { cost: 'hidden' } },
      activities: scoped('all', 'none', false, 'none', true),
      reports: scoped('all', 'none', false, 'none', true),
    },
  },
];

/**
 * Backfill any MODULES a role is missing — runs at boot so adding a module (e.g.
 * 'backups') does not silently lock everyone, including the admin, out of it.
 * Administrator gains full access to the new module; every other role gets none, so
 * a new capability is opt-in per the least-privilege default until an admin grants it.
 */
export async function ensureRoleModules(): Promise<number> {
  const roles = await prisma.role.findMany();
  let patched = 0;
  for (const role of roles) {
    const perms = { ...((role.permissions ?? {}) as Record<string, unknown>) };
    let changed = false;
    for (const m of MODULES) {
      if (!(m in perms)) {
        perms[m] = role.name === 'Administrator' ? fullAccess() : NONE;
        changed = true;
      }
    }
    if (changed) {
      await prisma.role.update({ where: { id: role.id }, data: { permissions: perms as never } });
      patched++;
    }
  }
  return patched;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  roleId: string;
  roleName: string;
  teamId: string | null;
  permissions: PermissionMap;
  totpEnabledAt: Date | null;
}

export function permissionFor(user: SessionUser, module: Module | string): ModulePermission {
  return user.permissions?.[module] ?? NONE;
}

export function can(
  user: SessionUser,
  module: Module | string,
  action: 'read' | 'create' | 'update' | 'delete' | 'export' | 'approve',
): boolean {
  const perm = permissionFor(user, module);
  if (action === 'create') return perm.create === true;
  if (action === 'export') return perm.export === true;
  // Roles saved before approvals existed have no `approve` key. Rather than leaving
  // every one of them unable to sign anything off until an admin re-saves the role,
  // fall back to "can already edit any record here" — the manager tier. An explicit
  // true or false from the Roles editor always wins.
  if (action === 'approve') return perm.approve ?? perm.update === 'all';
  return perm[action] !== 'none';
}

/** Everyone whose records a "team" scope may reach: the user, their team, their reports. */
export async function teamMemberIds(user: SessionUser): Promise<string[]> {
  const ids = new Set<string>([user.id]);
  if (user.teamId) {
    const mates = await prisma.user.findMany({ where: { teamId: user.teamId }, select: { id: true } });
    for (const m of mates) ids.add(m.id);
  }
  const reports = await prisma.user.findMany({ where: { managerId: user.id }, select: { id: true } });
  for (const r of reports) ids.add(r.id);
  return [...ids];
}

/**
 * Prisma `where` fragment enforcing record-level scope.
 * `none` returns an impossible clause rather than throwing so list endpoints
 * degrade to an empty grid instead of a 500.
 */
export async function scopeWhere(
  user: SessionUser,
  module: Module | string,
  action: 'read' | 'update' | 'delete' = 'read',
  ownerField = 'ownerId',
): Promise<Record<string, unknown>> {
  const scope = permissionFor(user, module)[action];
  if (scope === 'all') return {};
  if (scope === 'own') return { [ownerField]: user.id };
  if (scope === 'team') return { [ownerField]: { in: await teamMemberIds(user) } };
  return { id: '__no_access__' };
}

/** True when this user may act on this specific record's owner. */
export async function ownerAllowed(
  user: SessionUser,
  module: Module | string,
  action: 'read' | 'update' | 'delete',
  ownerId: string | null | undefined,
): Promise<boolean> {
  const scope = permissionFor(user, module)[action];
  if (scope === 'all') return true;
  if (scope === 'none') return false;
  if (!ownerId) return true; // unassigned records stay reachable so nothing gets orphaned
  if (scope === 'own') return ownerId === user.id;
  return (await teamMemberIds(user)).includes(ownerId);
}

const hiddenCache = new WeakMap<object, Map<string, Set<string>>>();

function hiddenFields(user: SessionUser, module: Module | string): Set<string> {
  let perUser = hiddenCache.get(user as unknown as object);
  if (!perUser) {
    perUser = new Map();
    hiddenCache.set(user as unknown as object, perUser);
  }
  let set = perUser.get(module);
  if (!set) {
    set = new Set(
      Object.entries(permissionFor(user, module).fields ?? {})
        .filter(([, access]) => access === 'hidden')
        .map(([field]) => field),
    );
    perUser.set(module, set);
  }
  return set;
}

/**
 * A plain `{}` — something safe to rebuild key by key.
 *
 * Anything with a class behind it is not: a Prisma `Decimal`, a `Date`, a `Buffer` all
 * carry behaviour that copying their enumerable properties destroys. A Decimal rebuilt
 * this way becomes `{s, e, d}` — its internal sign, exponent and digits — and serialises
 * as that object instead of the number, so every money figure on the record arrives as
 * something the UI cannot read.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Strip field-level-hidden keys from a record or array of records before it leaves the API. */
export function maskFields<T>(user: SessionUser, module: Module | string, data: T): T {
  const hidden = hiddenFields(user, module);
  if (hidden.size === 0) return data;

  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    // Leave class instances exactly as they are — masking hides fields, it does not
    // get to change what the surviving ones are.
    if (!isPlainObject(value)) return value;

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (hidden.has(key)) continue;
      out[key] = strip(child);
    }
    return out;
  };
  return strip(data) as T;
}

/** Reject a write that tries to set a field the role cannot write. */
export function stripUnwritableFields<T extends Record<string, unknown>>(
  user: SessionUser,
  module: Module | string,
  body: T,
): T {
  const fields = permissionFor(user, module).fields ?? {};
  const out = { ...body };
  for (const [field, access] of Object.entries(fields)) {
    if (access !== 'write' && field in out) delete out[field];
  }
  return out;
}
