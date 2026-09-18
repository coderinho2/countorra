import { z } from "zod";
import { currencySchema } from "./money";

export const createTransactionSchema = z
  .object({
    organizationId: z.uuid(),
    accountId: z.uuid(),
    categoryId: z.uuid().nullable().optional(),
    merchantId: z.uuid().nullable().optional(),
    kind: z.enum(["income", "expense", "transfer"]),
    /** The OTHER side of a transfer. Required for `transfer` and forbidden
     *  otherwise — the database enforces both
     *  (`transactions_transfer_requires_kind` and
     *  `transactions_transfer_not_self`, 0016). Restating the rule here is
     *  what lets the user be told about it instead of seeing a constraint
     *  violation. */
    transferAccountId: z.uuid().nullable().optional(),
    // Major-unit decimal string ("10.50"), converted to minor units via
    // src/domain/money before it ever reaches the database — never trust a
    // client-supplied minor-unit integer directly.
    amount: z.string().regex(/^\d+(\.\d{1,2})?$/, "Amount must be a decimal like 10.50"),
    currency: currencySchema,
    occurredOn: z.iso.date(),
    description: z.string().max(500).optional(),
    memo: z.string().max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === "transfer") {
      if (!value.transferAccountId) {
        ctx.addIssue({ code: "custom", path: ["transferAccountId"], message: "Choose the account the money is moving to." });
        return;
      }
      if (value.transferAccountId === value.accountId) {
        // The database refuses this too. Catching it here turns a constraint
        // violation into a sentence someone can act on.
        ctx.addIssue({ code: "custom", path: ["transferAccountId"], message: "A transfer has to move money between two different accounts." });
      }
      if (value.categoryId) {
        // Categories classify income and spending. A transfer is neither —
        // it is the same money in a different account — and every aggregate
        // excludes it, so a category on one would appear in no report and
        // silently misrepresent the breakdown if that ever changed.
        ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Transfers aren't categorized — the money hasn't been spent or earned." });
      }
      return;
    }

    if (value.transferAccountId) {
      ctx.addIssue({ code: "custom", path: ["transferAccountId"], message: "Only a transfer can have a destination account." });
    }
  });

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;
