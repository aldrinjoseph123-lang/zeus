import { createContext, useContext } from 'react';
import type { Me } from './api';

/** Who is signed in, resolved once by App and read by any screen. */
export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
