"use client";

import { useState, useTransition } from "react";
import { Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { PencilSimple } from "@phosphor-icons/react/dist/ssr/PencilSimple";
import { Trash } from "@phosphor-icons/react/dist/ssr/Trash";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { renameConversationAction, deleteConversationAction, type ConversationSummary } from "@/server/ai/actions";

function formatUpdatedAt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(iso));
}

/**
 * Conversation history rail (product spec §3/§8): start new, resume a
 * previous conversation, rename, delete-with-confirmation. Deliberately a
 * slim list with hairline dividers and mono metadata rather than a
 * chat-app sidebar with avatars/previews — DESIGN.md §14's "no chat
 * bubbles, no floating widget" spirit extends to this rail too.
 */
export function AiConversationList({
  conversations,
  activeId,
  onSelect,
  onNew,
  onRenamed,
  onDeleted,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRenamed: (id: string, title: string) => void;
  onDeleted: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const submitRename = () => {
    if (!renaming) return;
    const { id, title } = renaming;
    startTransition(async () => {
      const result = await renameConversationAction({ conversationId: id, title });
      if (result.ok) onRenamed(id, title);
      setRenaming(null);
    });
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const { id } = deleting;
    startTransition(async () => {
      const result = await deleteConversationAction({ conversationId: id });
      if (result.ok) onDeleted(id);
      setDeleting(null);
    });
  };

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border-subtle bg-surface md:flex">
      <div className="flex flex-col gap-2.5 border-b border-border-subtle p-3">
        <p className="px-1 text-[11px] font-semibold tracking-[0.02em] text-text-tertiary uppercase">Conversations</p>
        <Button variant="secondary" size="sm" className="w-full justify-center" onClick={onNew}>
          <Plus size={14} />
          New conversation
        </Button>
      </div>

      <nav className="flex flex-1 flex-col overflow-y-auto px-2 py-2">
        {conversations.length === 0 ? (
          <p className="px-2 py-3 text-[13px] text-text-tertiary">Nothing here yet. Your questions are saved so you can come back to an answer.</p>
        ) : (
          conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1 rounded-sm px-2 py-1.5 text-left transition-colors duration-[var(--duration-fast)] ease-out",
                c.id === activeId ? "bg-accent-subtle" : "hover:bg-surface-sunken",
              )}
            >
              <button type="button" onClick={() => onSelect(c.id)} className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                <p className={cn("truncate text-[13px]", c.id === activeId ? "font-medium text-accent" : "text-text-primary")}>{c.title || "New conversation"}</p>
                <p className="font-numeric text-[11px] text-text-tertiary">{formatUpdatedAt(c.updatedAt)}</p>
              </button>
              {/* Row actions appear on hover, but `focus-visible:opacity-100`
                  is what keeps them reachable by keyboard: an `opacity-0`
                  control still takes focus, so without it a keyboard user
                  tabs onto an invisible button and cannot tell where they
                  are. */}
              <button
                type="button"
                aria-label={`Rename ${c.title || "conversation"}`}
                onClick={() => setRenaming({ id: c.id, title: c.title ?? "" })}
                className="rounded-sm p-1 text-text-tertiary opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-hover:opacity-100 hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                <PencilSimple size={13} />
              </button>
              <button
                type="button"
                aria-label={`Delete ${c.title || "conversation"}`}
                onClick={() => setDeleting({ id: c.id, title: c.title ?? "New conversation" })}
                className="rounded-sm p-1 text-text-tertiary opacity-0 transition-opacity duration-[var(--duration-fast)] ease-out group-hover:opacity-100 hover:text-negative focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
              >
                <Trash size={13} />
              </button>
            </div>
          ))
        )}
      </nav>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
          </DialogHeader>
          <Input
            value={renaming?.title ?? ""}
            onChange={(e) => setRenaming((prev) => (prev ? { ...prev, title: e.target.value } : prev))}
            onKeyDown={(e) => e.key === "Enter" && submitRename()}
            autoFocus
            maxLength={120}
          />
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={pending || !renaming?.title.trim()} onClick={submitRename}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete conversation</DialogTitle>
            <DialogDescription>
              This permanently deletes &ldquo;{deleting?.title}&rdquo; and its messages. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive-solid" size="sm" disabled={pending} onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
