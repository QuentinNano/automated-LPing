import type { FetchLike } from "@lping/adapters";

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Fetch-Stub: arbeitet eine Antwort-Queue ab und protokolliert alle URLs.
 * Einträge können Response-Objekte oder Funktionen (url) => Response sein.
 */
export function fetchQueue(
  entries: Array<Response | ((url: string) => Response)>,
): { fetchImpl: FetchLike; calls: string[] } {
  const queue = [...entries];
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    const url = input.toString();
    calls.push(url);
    const next = queue.shift();
    if (next === undefined) throw new Error(`fetchQueue leer, unerwarteter Request: ${url}`);
    return typeof next === "function" ? next(url) : next;
  };
  return { fetchImpl, calls };
}
