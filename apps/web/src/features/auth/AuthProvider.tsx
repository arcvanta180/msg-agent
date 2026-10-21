import { api, post, refresh, setToken } from "@/shared/api/client";
import { useQueryClient } from "@tanstack/react-query";
import React, { createContext, useContext, useEffect, useState } from "react";
import type { User } from "./types";
const AuthContext = createContext<{
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
});
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true);
  const query = useQueryClient();
  useEffect(() => {
    let active = true;
    refresh()
      .then(() => api<User>("/auth/me"))
      .then((u) => {
        if (active) setUser(u);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    const end = () => {
      setUser(null);
      query.clear();
    };
    window.addEventListener("session-ended", end);
    return () => {
      active = false;
      window.removeEventListener("session-ended", end);
    };
  }, [query]);
  const login = async (username: string, password: string) => {
    const response = await post<{ accessToken: string }>("/auth/login", {
      username,
      password,
    });
    setToken(response.accessToken);
    query.clear();
    setUser(await api<User>("/auth/me"));
  };
  const logout = async () => {
    await post("/auth/logout");
    setToken(null);
    setUser(null);
    query.clear();
  };
  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
export const useAuth = () => useContext(AuthContext);
