import { z } from "zod";
import { USER_ENTITY_TYPES } from "@/domain/organizations/types";
import { currencySchema } from "./money";

export const createOrganizationSchema = z.object({
  name: z.string().min(1, "Name is required.").max(200),
  entityType: z.enum(USER_ENTITY_TYPES as [string, ...string[]]),
  country: z
    .string()
    .length(2)
    .default("US"),
  baseCurrency: currencySchema.default("USD"),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
