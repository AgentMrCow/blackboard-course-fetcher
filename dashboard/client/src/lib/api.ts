type ApiRequestOptions = Omit<RequestInit, "body"> & { body?: any };

export async function api<T = any>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  const request: RequestInit = {
    ...options,
    headers: { ...(options.headers || {}) },
  };
  if (options.body && typeof options.body !== "string" && !(options.body instanceof FormData)) {
    request.body = JSON.stringify(options.body);
    (request.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const response = await fetch(url, request);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof payload === "object" && payload?.error
      ? payload.error
      : payload || `Request failed with HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return payload as T;
}
