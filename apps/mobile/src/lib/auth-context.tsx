import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api-client";
import { tokenStore } from "./token-store";

export interface SessionUser {
  id: string;
  email: string | null;
  displayName: string;
  themePreference: "system" | "light" | "dark";
  hasPassword: boolean;
}

interface AuthContextValue {
  user: SessionUser | null;
  isLoading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, displayName: string) => Promise<void>;
  signInWithApple: (identityToken: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api.get<SessionUser>("/v1/auth/me");
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      // Always attempt a refresh on launch, even with no locally-stored bearer token — the web-preview
      // flow (Platform.OS === "web") authenticates via the httpOnly cookie instead, which this process
      // has no visibility into until the request comes back. Worst case with neither: a 401, correctly
      // treated as "not signed in".
      await refresh();
      setIsLoading(false);
    })();
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const result = await api.post<{ userId: string; token?: string }>("/v1/auth/sign-in", { email, password });
      if (result.token) await tokenStore.set(result.token);
      await refresh();
    },
    [refresh],
  );

  const signUp = useCallback(
    async (email: string, password: string, displayName: string) => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const result = await api.post<{ userId: string; token?: string }>("/v1/auth/sign-up", {
        email,
        password,
        displayName,
        timezone,
      });
      if (result.token) await tokenStore.set(result.token);
      await refresh();
    },
    [refresh],
  );

  const signInWithApple = useCallback(
    async (identityToken: string) => {
      const result = await api.post<{ userId: string; token?: string }>("/v1/auth/apple/sign-in", { identityToken });
      if (result.token) await tokenStore.set(result.token);
      await refresh();
    },
    [refresh],
  );

  const signOut = useCallback(async () => {
    try {
      await api.post("/v1/auth/sign-out");
    } catch {
      // Token may already be invalid/expired — clearing local state still succeeds either way.
    }
    await tokenStore.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, isLoading, signIn, signUp, signInWithApple, signOut }),
    [user, isLoading, signIn, signUp, signInWithApple, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export { ApiError };
