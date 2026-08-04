import type { FastifyReply, FastifyRequest } from 'fastify';
import { can, type Module, type SessionUser } from '../auth/rbac.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser;
  }
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const forbidden = (msg = 'You do not have permission to do that.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);

/** Route-level guard. Attach as a preHandler. */
export function requirePermission(module: Module | string, action: 'read' | 'create' | 'update' | 'delete' | 'export' | 'approve') {
  return async (request: FastifyRequest) => {
    if (!request.user) throw new HttpError(401, 'Sign in required.');
    if (!can(request.user, module, action)) {
      throw forbidden(`Your role (${request.user.roleName}) cannot ${action} ${module}.`);
    }
  };
}

export interface ListParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
  search: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  filters: Record<string, string>;
}

const RESERVED = new Set(['page', 'pageSize', 'search', 'sortBy', 'sortDir', 'format']);

export function listParams(query: Record<string, unknown>, defaultSort = 'updatedAt'): ListParams {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize) || 25));
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    filters[key] = String(value);
  }
  return {
    page,
    pageSize,
    skip: (page - 1) * pageSize,
    take: pageSize,
    search: String(query.search ?? '').trim(),
    sortBy: String(query.sortBy ?? defaultSort),
    sortDir: query.sortDir === 'asc' ? 'asc' : 'desc',
    filters,
  };
}

export function orderBy(params: ListParams, allowed: string[], fallback = 'updatedAt'): Record<string, 'asc' | 'desc'> {
  const field = allowed.includes(params.sortBy) ? params.sortBy : fallback;
  return { [field]: params.sortDir };
}

export interface Paged<T> {
  data: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export function paged<T>(data: T[], total: number, params: ListParams): Paged<T> {
  return {
    data,
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  };
}

export function clientIp(request: FastifyRequest): string {
  const fwd = request.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return request.ip;
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HttpError) {
    return reply.status(err.statusCode).send({ error: err.message, details: err.details ?? undefined });
  }
  request_log(err);
  return reply.status(500).send({ error: 'Something went wrong on our side.' });
}

function request_log(err: unknown): void {
  console.error('[api]', err);
}
