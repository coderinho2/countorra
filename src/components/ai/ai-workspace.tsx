"use client";

import { useState } from "react";
import { AiConversationList } from "./ai-conversation-list";
import { AiChatPanel, type Turn } from "./ai-chat-panel";
import { loadConversationAction, type ConversationSummary } from "@/server/ai/actions";
import type { UserEntityType } from "@/domain/organizations/types";

function toTurns(messages: { id: string; role: string; content: string | null }[]): Turn[] {
  return messages
    .filter((m): m is { id: string; role: "user" | "assistant"; content: string | null } => m.role === "user" || m.role === "assistant")
    .map((m) => ({ id: m.id, role: m.role, content: m.content ?? "" }));
}

/**
 * Owns the conversation list + which conversation is active; AiChatPanel
 * owns the live turn-by-turn state for whichever conversation is active.
 * Selecting a different conversation (or "New") bumps `selectionToken`,
 * which is used as AiChatPanel's `key` — remounting it is the simplest
 * correct way to reset its internal state. A conversation created by the
 * panel itself (the user's first message in a fresh thread) reports back
 * via `onConversationCreated` WITHOUT bumping the token, so that flow
 * never remounts the panel out from under itself.
 */
export function AiWorkspace({
  organizationId,
  entityType,
  initialConversations,
  grounding,
}: {
  organizationId: string;
  entityType: UserEntityType;
  initialConversations: ConversationSummary[];
  /** Real counts of what the assistant can read, from the server. */
  grounding: { transactions: number; invoices: number; accounts: number; through: string };
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [selectionToken, setSelectionToken] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [initialMessages, setInitialMessages] = useState<Turn[]>([]);

  const startNew = () => {
    setActiveId(null);
    setInitialMessages([]);
    setSelectionToken((t) => t + 1);
  };

  const selectConversation = async (id: string) => {
    const result = await loadConversationAction({ conversationId: id });
    setActiveId(id);
    setInitialMessages(toTurns(result.messages));
    setSelectionToken((t) => t + 1);
  };

  const handleConversationCreated = (id: string, title: string) => {
    setActiveId(id);
    setConversations((prev) => [{ id, title, updatedAt: new Date().toISOString() }, ...prev.filter((c) => c.id !== id)]);
  };

  const handleRenamed = (id: string, title: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
  };

  const handleDeleted = (id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeId === id) startNew();
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <AiConversationList
        conversations={conversations}
        activeId={activeId}
        onSelect={selectConversation}
        onNew={startNew}
        onRenamed={handleRenamed}
        onDeleted={handleDeleted}
      />
      <AiChatPanel
        key={selectionToken}
        organizationId={organizationId}
        entityType={entityType}
        initialConversationId={activeId}
        initialMessages={initialMessages}
        onConversationCreated={handleConversationCreated}
        grounding={grounding}
      />
    </div>
  );
}
