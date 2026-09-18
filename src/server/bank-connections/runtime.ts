import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/server/supabase/admin";
import { createSupabaseBankStore } from "@/server/db/repositories/bank-connections";
import { recordSystemAuditEvent } from "@/domain/audit/audit-log";
import { configuredBankProviders, configuredSecretStore } from "./providers";
import type { ServiceDependencies } from "./service";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The production wiring: the service-role store, the configured providers
 * (none), the configured secret store (none), and system audit events.
 *
 * Service role, because every bank table is written only by server code after
 * authorization — members have no write privilege at all (0047). Callers are
 * Server Actions that have already checked membership and permission, and the
 * verified webhook route.
 */
/** What releasing an organization's bank credentials needs, on a caller's
 *  existing admin client (account deletion already holds one). */
export function bankCredentialDependencies(admin: ReturnType<typeof createAdminClient>): Pick<ServiceDependencies, "store" | "providers" | "secrets"> {
  return { store: createSupabaseBankStore(admin), providers: configuredBankProviders(), secrets: configuredSecretStore(admin) };
}

export function productionBankDependencies(): ServiceDependencies {
  const admin = createAdminClient();
  return {
    store: createSupabaseBankStore(admin),
    providers: configuredBankProviders(),
    secrets: configuredSecretStore(admin),
    now: () => new Date(),
    hash: sha256Hex,
    audit: (event) => recordSystemAuditEvent(admin, event),
  };
}
