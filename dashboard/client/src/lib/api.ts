type ApiRequestOptions = Omit<RequestInit, "body"> & { body?: any; timeoutMs?: number };

async function request(url: string, options: ApiRequestOptions, textOnly: boolean): Promise<any> {
  const { timeoutMs = 30_000, signal, body, ...init } = options;
  const controller = new AbortController();
  const headers = new Headers(init.headers);
  const isMutation = !["GET", "HEAD"].includes((init.method || "GET").toUpperCase());
  const mutationHint = isMutation ? " The operation may still be running; check its status before trying again." : " Try again when the dashboard server is available.";
  const requestInit: RequestInit = { ...init, headers, signal: controller.signal };
  if (body !== undefined) {
    if (body !== null && typeof body === "object" && !(body instanceof FormData)
      && !(body instanceof Blob) && !(body instanceof URLSearchParams) && !(body instanceof ArrayBuffer)
      && !ArrayBuffer.isView(body)) {
      requestInit.body = JSON.stringify(body);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    } else requestInit.body = body;
  }
  let timeout: ReturnType<typeof setTimeout>;
  let rejectAborted: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAborted = reject; });
  const cancel = () => {
    controller.abort();
    const error = new Error("Request cancelled.");
    error.name = "AbortError";
    rejectAborted(error);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  timeout = setTimeout(() => {
    rejectAborted(new Error(`The dashboard request timed out.${mutationHint}`));
    controller.abort();
  }, Math.max(1, timeoutMs));
  try {
    return await Promise.race([aborted, (async () => {
      if (signal?.aborted) return await aborted;
      let response: Response;
      try {
        response = await fetch(url, requestInit);
      } catch {
        if (controller.signal.aborted) return await aborted;
        throw new Error(`Unable to reach the local dashboard server.${mutationHint}`);
      }
      let text: string;
      try { text = await response.text(); }
      catch {
        if (controller.signal.aborted) return await aborted;
        throw new Error(`The dashboard response was interrupted.${mutationHint}`);
      }
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (response.ok && !textOnly && text && !contentType.includes("json")) {
        throw new Error("The dashboard returned an unexpected response instead of JSON. Check the local dashboard server and refresh the page.");
      }
      let payload: any = text;
      if (contentType.includes("json") && text && (!textOnly || !response.ok)) {
        try { payload = JSON.parse(text); }
        catch {
          throw new Error(response.ok
            ? "The dashboard returned an invalid JSON response. Refresh the page and try again."
            : `Dashboard request failed with HTTP ${response.status}. Try again after checking the server.`);
        }
      }
      if (!response.ok) {
        const message = payload && typeof payload === "object" && typeof payload.error === "string"
          ? payload.error
          : typeof payload === "string" && !/^\s*</.test(payload) ? payload.trim() : "";
        throw new Error(message.slice(0, 500) || `Dashboard request failed with HTTP ${response.status}. Try again after checking the server.`);
      }
      return textOnly ? text : response.status === 204 || !text ? null : payload;
    })()]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}

export function api<T = any>(url: string, options: ApiRequestOptions = {}): Promise<T> {
  return request(url, options, false);
}

export function requestText(url: string, options: ApiRequestOptions = {}): Promise<string> {
  return request(url, options, true);
}
