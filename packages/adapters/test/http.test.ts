import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AdapterError, fetchJson } from "@lping/adapters";
import { fetchQueue, jsonResponse } from "./helpers";

describe("fetchJson", () => {
  it("wiederholt bei 5xx und liefert dann das validierte Ergebnis", async () => {
    const { fetchImpl, calls } = fetchQueue([
      jsonResponse({ error: "boom" }, 500),
      jsonResponse({ ok: true }),
    ]);
    const result = await fetchJson("https://example.com/x", {
      schema: z.object({ ok: z.boolean() }),
      fetchImpl,
      backoffMs: 1,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("wiederholt 4xx (außer 429) nicht", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse({ error: "no route" }, 400)]);
    await expect(
      fetchJson("https://example.com/x", { schema: z.unknown(), fetchImpl, backoffMs: 1 }),
    ).rejects.toMatchObject({ kind: "http", meta: { status: 400 } });
    expect(calls).toHaveLength(1);
  });

  it("wiederholt bei 429", async () => {
    const { fetchImpl, calls } = fetchQueue([
      jsonResponse({ error: "slow down" }, 429, { "retry-after": "0" }),
      jsonResponse({ ok: 1 }),
    ]);
    const result = await fetchJson("https://example.com/x", {
      schema: z.object({ ok: z.number() }),
      fetchImpl,
      backoffMs: 1,
    });
    expect(result).toEqual({ ok: 1 });
    expect(calls).toHaveLength(2);
  });

  it("meldet Schema-Verstöße als validation-Fehler ohne Retry", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse({ ok: "nope" })]);
    await expect(
      fetchJson("https://example.com/x", {
        schema: z.object({ ok: z.number() }),
        fetchImpl,
        backoffMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "validation" });
    expect(calls).toHaveLength(1);
  });

  it("hängt searchParams an die URL an", async () => {
    const { fetchImpl, calls } = fetchQueue([jsonResponse({})]);
    await fetchJson("https://example.com/quote", {
      schema: z.unknown(),
      searchParams: { a: 1, b: "x", skip: undefined },
      fetchImpl,
    });
    expect(calls[0]).toBe("https://example.com/quote?a=1&b=x");
  });

  it("klassifiziert Netzwerkfehler und reicht sie nach Retries durch", async () => {
    const failing = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(
      fetchJson("https://example.com/x", {
        schema: z.unknown(),
        fetchImpl: failing,
        retries: 1,
        backoffMs: 1,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("AdapterError trägt URL und Body-Ausschnitt", async () => {
    const { fetchImpl } = fetchQueue([jsonResponse({ detail: "kaputt" }, 503)]);
    try {
      await fetchJson("https://example.com/x", {
        schema: z.unknown(),
        fetchImpl,
        retries: 0,
        backoffMs: 1,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      const adapterError = error as AdapterError;
      expect(adapterError.meta.url).toContain("example.com");
      expect(adapterError.meta.bodySnippet).toContain("kaputt");
    }
  });
});
