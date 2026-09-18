import { z } from "zod";

export const sendAiMessageSchema = z.object({
  organizationId: z.uuid(),
  conversationId: z.uuid().nullable(),
  message: z.string().min(1).max(8_000),
});

export type SendAiMessageInput = z.infer<typeof sendAiMessageSchema>;

export const confirmAiActionSchema = z.object({
  aiActionId: z.uuid(),
  approve: z.boolean(),
});

export type ConfirmAiActionInput = z.infer<typeof confirmAiActionSchema>;

export const loadConversationSchema = z.object({
  conversationId: z.uuid(),
});

export type LoadConversationInput = z.infer<typeof loadConversationSchema>;

export const renameConversationSchema = z.object({
  conversationId: z.uuid(),
  title: z.string().trim().min(1).max(120),
});

export type RenameConversationInput = z.infer<typeof renameConversationSchema>;

export const deleteConversationSchema = z.object({
  conversationId: z.uuid(),
});

export type DeleteConversationInput = z.infer<typeof deleteConversationSchema>;
