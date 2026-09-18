import { z } from "zod";
import { currencySchema } from "./money";

export const invoiceLineItemSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive().max(1_000_000),
  unitPrice: z.string().regex(/^\d+(\.\d{1,2})?$/, "Unit price must be a decimal like 10.50"),
  taxRate: z.number().min(0).max(100).default(0),
});

export const createInvoiceSchema = z.object({
  organizationId: z.uuid(),
  customerId: z.uuid(),
  currency: currencySchema,
  issueDate: z.iso.date(),
  dueDate: z.iso.date().optional(),
  notes: z.string().max(2000).optional(),
  lineItems: z.array(invoiceLineItemSchema).min(1, "At least one line item is required."),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
