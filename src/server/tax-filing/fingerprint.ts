import "server-only";
import { createHash } from "node:crypto";
import { canonicalJson } from "@/domain/tax-filing/canonical-json";
import { inputFingerprintMaterial, type FrozenPreparation } from "@/domain/tax-filing/inputs";
import type { FilingPackage } from "@/domain/tax-filing/types";

/**
 * SHA-256 over canonical JSON.
 *
 * Integrity and staleness checks, not secrecy: a fingerprint proves that a
 * stored package is byte-for-byte what its frozen inputs produce, and that a
 * filing snapshot was built from the preparation state that is current now.
 */

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function packageFingerprint(filingPackage: FilingPackage): string {
  return sha256Hex(canonicalJson(filingPackage));
}

export function inputFingerprint(frozen: FrozenPreparation): string {
  return sha256Hex(inputFingerprintMaterial(frozen));
}
