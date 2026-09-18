"use client";

import { useState, useTransition } from "react";
import { Bell } from "@phosphor-icons/react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { markNotificationReadAction } from "@/server/notifications/actions";
import { cn } from "@/lib/utils";
import type { Notification } from "@/server/db/repositories/notifications";

export function NotificationBell({ organizationId, initialNotifications }: { organizationId: string; initialNotifications: Notification[] }) {
  const [notifications, setNotifications] = useState(initialNotifications);
  const [, startTransition] = useTransition();
  const unreadCount = notifications.filter((n) => !n.isRead).length;

  const markRead = (id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, isRead: true } : n)));
    startTransition(() => {
      markNotificationReadAction(organizationId, id);
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="text-text-secondary hover:bg-surface-sunken relative flex size-9 items-center justify-center rounded-sm transition-colors duration-100 ease-out"
          aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"}
        >
          <Bell size={20} />
          {unreadCount > 0 && <span className="bg-negative absolute top-1.5 right-1.5 size-1.5 rounded-full" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-80 overflow-y-auto p-0">
        <div className="border-border-subtle border-b px-4 py-3">
          <p className="text-ink text-[15px] font-semibold">Notifications</p>
        </div>
        {notifications.length === 0 ? (
          <EmptyState title="You're caught up" description="Nothing needs your attention right now." className="py-8" />
        ) : (
          <ul>
            {notifications.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => markRead(n.id)}
                  className={cn(
                    "border-border-subtle hover:bg-surface-sunken flex w-full flex-col gap-0.5 border-b px-4 py-3 text-left transition-colors duration-100 ease-out last:border-0",
                    !n.isRead && "bg-accent-subtle/40",
                  )}
                >
                  <span className="text-text-primary text-[13px] font-medium">{n.title}</span>
                  {n.body && <span className="text-text-secondary text-[13px]">{n.body}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
