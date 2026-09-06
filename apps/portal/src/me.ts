import { createContext, useContext } from 'react';
import type { Branding, Me } from './api';

/** Who is signed in, resolved once by App and read by any screen. */
export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;

export const BrandingContext = createContext<Branding | null>(null);
export const useBranding = () => useContext(BrandingContext);
