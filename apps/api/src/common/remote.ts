export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
export interface RemoteResponse {
  status: number;
  body: Record<string, any>;
  raw: string;
}
export async function remote(
  base: string,
  path: string,
  body?: object,
  timeout = 6000,
  signal?: AbortSignal,
): Promise<RemoteResponse> {
  try {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
    const raw = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed, raw };
  } catch (e) {
    return {
      status: 0,
      body: { code: "TRANSPORT_UNCERTAIN", message: String(e) },
      raw: String(e),
    };
  }
}
export function remoteCode(r: RemoteResponse) {
  return (
    r.body.code ||
    r.body.error?.code ||
    (r.status === 503
      ? "SERVICE_UNAVAILABLE"
      : r.status === 0
        ? "TRANSPORT_UNCERTAIN"
        : `HTTP_${r.status}`)
  );
}
