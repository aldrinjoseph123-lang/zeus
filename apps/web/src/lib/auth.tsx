import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

export type Scope = 'all' | 'team' | 'own' | 'none';

export interface ModulePermission {
  read: Scope;
  create: boolean;
  update: Scope;
  delete: Scope;
  export: boolean;
  /** May sign off someone else's deal, purchase order or invoice. */
  approve?: boolean;
  fields?: Record<string, 'hidden' | 'read' | 'write'>;
}

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  jobTitle: string | null;
  phone: string | null;
  avatarColor: string;
  lastLoginAt: string | null;
  team: { id: string; name: string; kind: string } | null;
  role: { id: string; name: string; permissions: Record<string, ModulePermission> };
}

interface AuthValue {
  user: CurrentUser | null;
  unread: number;
  loading: boolean;
  refresh: () => void;
  can: (module: string, action: 'read' | 'create' | 'update' | 'delete' | 'export' | 'approve') => boolean;
  /** False when the role hides this field — hide the column or input entirely. */
  sees: (module: string, field: string) => boolean;
}

const AuthContext = createContext<AuthValue>({
  user: null,
  unread: 0,
  loading: true,
  refresh: () => {},
  can: () => false,
  sees: () => true,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ user: CurrentUser; unreadNotifications: number }>('/auth/me'),
    retry: false,
    staleTime: 60_000,
  });

  const user = data?.user ?? null;

  const value: AuthValue = {
    user,
    unread: data?.unreadNotifications ?? 0,
    loading: isLoading,
    refresh: () => void queryClient.invalidateQueries({ queryKey: ['me'] }),
    can: (module, action) => {
      const perm = user?.role.permissions?.[module];
      if (!perm) return false;
      if (action === 'create') return perm.create === true;
      if (action === 'export') return perm.export === true;
      // Mirrors the server: roles saved before approvals existed fall back to
      // "can edit every record here", which is the manager tier.
      if (action === 'approve') return perm.approve ?? perm.update === 'all';
      return perm[action] !== 'none';
    },
    sees: (module, field) => user?.role.permissions?.[module]?.fields?.[field] !== 'hidden',
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
