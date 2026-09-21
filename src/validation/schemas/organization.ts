import { z } from "zod";
import { LAUNCH_ENTITY_TYPE, LAUNCH_ENTITY_TYPES, PERSONAL_ONLY_MESSAGE } from "@/domain/organizations/launch-scope";
import { currencySchema } from "./money";

export const createOrganizationSchema = z.object({
  name: z.string().min(1, "Name is required.").max(200),
  // Personal only at launch (src/domain/organizations/launch-scope.ts). Not
  // asked for any more — it defaults — but a request that names another
  // type is refused rather than silently turned into a personal workspace.
  entityType: z.enum(LAUNCH_ENTITY_TYPES, { error: PERSONAL_ONLY_MESSAGE }).default(LAUNCH_ENTITY_TYPE),
  country: z
    .string()
    .length(2)
    .default("US"),
  baseCurrency: currencySchema.default("USD"),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
