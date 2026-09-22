import "server-only";
import { headers } from "next/headers";
import { requestIdFrom } from "@/lib/observability";

/**
 * The current request's correlation id, inside a server action or a server
 * component — the one src/proxy.ts set. Undefined outside a request (a test,
 * a script), never a thrown error: observability must not break the work.
 */
export async function currentRequestId(): Promise<string | undefined> {
  try {
    return requestIdFrom(await headers());
  } catch {
    return undefined;
  }
}
