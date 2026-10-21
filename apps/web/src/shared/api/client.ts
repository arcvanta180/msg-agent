export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
let token: string | null = null;
let refreshing: Promise<string> | null = null;
export const getToken = () => token;
export const setToken = (value: string | null) => {
  token = value;
};
export async function refresh(): Promise<string> {
  if (!refreshing) {
    const execute = async () => {
      const r = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new ApiError(401, "UNAUTHORIZED", "请重新登录");
      token = (await r.json()).accessToken;
      return token!;
    };
    refreshing = (async () => {
      if (navigator.locks) {
        let access = "";
        await navigator.locks.request("relay-refresh", async () => {
          access = await execute();
        });
        return access;
      }
      return execute();
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing!;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const response = await fetch("/api" + path, {
    ...options,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (response.status === 401 && retry && !path.startsWith("/auth/")) {
    try {
      await refresh();
      return api<T>(path, options, false);
    } catch {
      token = null;
      window.dispatchEvent(new Event("session-ended"));
      throw new ApiError(401, "UNAUTHORIZED", "会话已结束，请重新登录");
    }
  }
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      result.error?.code || "ERROR",
      result.error?.message || "请求失败",
      result.error,
    );
  return result as T;
}
export const post = <T>(path: string, body: object = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: object) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
