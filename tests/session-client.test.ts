import { it, expect, vi, afterEach } from "vitest";
import { api, setToken } from "../apps/web/src/shared/api/client";
afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});
it("多个请求同时 401 只续期一次，并使用新 access 重试", async () => {
  setToken("expired-test-token");
  let renewals = 0;
  vi.stubGlobal("navigator", {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, options: RequestInit) => {
      if (path === "/api/auth/refresh") {
        renewals++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(JSON.stringify({ accessToken: "new-test-token" }), {
          status: 200,
        });
      }
      const headers = options.headers as Record<string, string>;
      return new Response(
        JSON.stringify(
          headers.authorization === "Bearer new-test-token"
            ? { ok: true }
            : { error: { code: "UNAUTHORIZED" } },
        ),
        {
          status: headers.authorization === "Bearer new-test-token" ? 200 : 401,
        },
      );
    }),
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => api<{ ok: boolean }>(`/read-${i}`)),
  );
  expect(renewals).toBe(1);
  expect(results.every((r) => r.ok)).toBe(true);
});
