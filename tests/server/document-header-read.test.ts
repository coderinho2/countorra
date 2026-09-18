import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Document confirmation must not hang on a teed response body.
 *
 * FOUND DURING LIVE VERIFICATION (Task 7.1)
 *
 * Every upload through the running app stayed `pending`: the bytes reached
 * Storage, but `confirmDocumentUpload` stalled for 10 seconds to 2.6 minutes.
 * The cause was `await reader.cancel()` in `readHeaderBytes`. Inside a Next.js
 * server runtime `fetch` is patched to clone responses with `body.tee()`, and a
 * tee branch's cancel does not settle until the other branch — which Next never
 * reads — is cancelled or drained too.
 *
 * This reproduces that condition without a network: a fetch that hands back
 * one branch of a tee over a stream that delivers its bytes and then stays
 * open, exactly like a kept-alive connection.
 */

vi.mock("server-only", () => ({}));

const { observeUploadedObject } = await import("@/server/storage/documents");

const PDF_HEADER = new TextEncoder().encode("%PDF-1.4\n%synthetic");

function teedResponseThatStaysOpen() {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(PDF_HEADER);
      // Never close: the connection is kept alive.
    },
  });
  const [served, keptByNextsPatchedFetch] = source.tee();
  // The second branch is held but never read — what Next's cloneResponse does.
  void keptByNextsPatchedFetch;
  return new Response(served, { status: 206, headers: { "content-type": "application/pdf" } });
}

function storageClient() {
  return {
    storage: {
      from: () => ({
        info: async () => ({ data: { size: 757 }, error: null }),
        createSignedUrl: async () => ({ data: { signedUrl: "https://storage.example.test/signed" }, error: null }),
      }),
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reading an uploaded file's header", () => {
  it("returns promptly even when the response body is one branch of a tee", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => teedResponseThatStaysOpen()));

    const timeout = new Promise<"timed out">((resolve) => setTimeout(() => resolve("timed out"), 2000));
    const result = await Promise.race([observeUploadedObject(storageClient() as never, "org/file.pdf"), timeout]);

    // With the old `await reader.cancel()` this never settles.
    expect(result).not.toBe("timed out");
    if (result === "timed out") return;
    expect(result.exists).toBe(true);
    if (!result.exists) return;
    expect(new TextDecoder().decode(result.header).startsWith("%PDF-1.4")).toBe(true);
  });

  it("asks only for the header bytes", async () => {
    const fetchSpy = vi.fn(async () => teedResponseThatStaysOpen());
    vi.stubGlobal("fetch", fetchSpy);

    await observeUploadedObject(storageClient() as never, "org/file.pdf");

    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Range).toMatch(/^bytes=0-\d+$/);
  });

  it("still reports a missing object as not existing", async () => {
    const client = { storage: { from: () => ({ info: async () => ({ data: null, error: { message: "not found" } }) }) } };
    await expect(observeUploadedObject(client as never, "org/missing.pdf")).resolves.toEqual({ exists: false });
  });
});
