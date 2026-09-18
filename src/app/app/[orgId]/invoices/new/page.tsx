import Link from "next/link";
import { createClient } from "@/server/supabase/server";
import { listCustomers } from "@/server/db/repositories/customers";
import { getOrganization } from "@/server/db/repositories/organizations";
import { NewInvoiceForm } from "@/components/invoices/new-invoice-form";
import { notFound } from "next/navigation";

export default async function NewInvoicePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const client = await createClient();
  const [organization, customers] = await Promise.all([getOrganization(client, orgId), listCustomers(client, orgId)]);
  if (!organization) notFound();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 lg:p-8">
      <Link href={`/app/${orgId}/invoices`} className="text-[13px] text-accent hover:underline">
        ← Back to invoices
      </Link>
      <h1 className="text-lg font-semibold text-ink">New invoice</h1>
      {customers.length === 0 && (
        <p className="text-[13px] text-text-secondary">
          You need at least one customer before creating an invoice.{" "}
          <Link href={`/app/${orgId}/customers`} className="text-accent hover:underline">
            Add one
          </Link>
          .
        </p>
      )}
      <NewInvoiceForm organizationId={orgId} customers={customers} currency={organization.baseCurrency} />
    </div>
  );
}
