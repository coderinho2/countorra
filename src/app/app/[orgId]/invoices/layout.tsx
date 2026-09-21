import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/domain/organizations/launch-scope";

/**
 * Invoicing is deferred at launch — Countorra is personal-only
 * (src/domain/organizations/launch-scope.ts). Every page under this segment
 * answers 404 until the module returns; the pages, and every invoice and
 * customer already stored, are kept unchanged.
 */
export default function DeferredInvoicingLayout({ children }: { children: React.ReactNode }) {
  if (!isModuleEnabled("invoicing")) notFound();
  return children;
}
