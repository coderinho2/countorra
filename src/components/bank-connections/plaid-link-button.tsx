"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { completeBankLinkAction, completeBankReauthAction, startBankLinkAction, type BankActionResult } from "@/server/bank-connections/actions";

/**
 * THE PROVIDER'S OWN BROWSER COMPONENT.
 *
 * What this component may hold is deliberately almost nothing: a Link token
 * the server created seconds earlier, and the public token the bank dialog
 * hands back. No client id, no secret, no access token, no institution list
 * — and it never tells the server what was connected. The server asks the
 * provider.
 *
 * The flow:
 *
 *   click ─▶ startBankLinkAction (authenticated, authorized, entitled, rate
 *            limited, server-side) ─▶ Link token
 *         ─▶ Plaid's dialog, in the customer's browser
 *         ─▶ public token ─▶ completeBankLinkAction ─▶ server exchanges it,
 *            encrypts the access token, creates the connection
 *
 * Nothing here decides anything: if the dialog is closed, no connection
 * exists; if the server refuses, the reason is shown as written; and
 * re-authentication sends only ids, because the server verifies the repair
 * with the provider rather than believing the browser.
 *
 * The script is loaded from Plaid's CDN on demand — never bundled, never on a
 * page that does not need it, and never when no provider is configured
 * (the server does not render this component at all in that case).
 */

const PLAID_SCRIPT_URL = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";
/** Only the short-lived Link token, and only to survive an OAuth redirect. */
const RESUME_KEY = "countorra.bank.link-token";

interface PlaidHandler {
  open: () => void;
  exit: (options?: { force?: boolean }) => void;
  destroy: () => void;
}

interface PlaidFactory {
  create: (config: Record<string, unknown>) => PlaidHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidFactory;
  }
}

let scriptLoad: Promise<PlaidFactory | null> | null = null;

function loadPlaid(): Promise<PlaidFactory | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (window.Plaid) return Promise.resolve(window.Plaid);
  scriptLoad ??= new Promise<PlaidFactory | null>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${PLAID_SCRIPT_URL}"]`);
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(window.Plaid ?? null), { once: true });
    script.addEventListener("error", () => resolve(null), { once: true });
    if (!existing) {
      script.src = PLAID_SCRIPT_URL;
      script.async = true;
      document.head.appendChild(script);
    }
  });
  return scriptLoad;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function Result({ state }: { state: BankActionResult }) {
  if (state.error) {
    return (
      <p role="alert" className="max-w-[60ch] text-[13px] text-negative">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p role="status" className="max-w-[60ch] text-[13px] text-text-secondary">
        {state.message}
      </p>
    );
  }
  return null;
}

export interface PlaidLinkButtonProps {
  organizationId: string;
  /** Present when repairing an existing connection (Plaid's update mode). */
  connectionId?: string;
  label: string;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
}

export function PlaidLinkButton({ organizationId, connectionId, label, variant = "primary", size = "md" }: PlaidLinkButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<BankActionResult>({});
  const [busy, setBusy] = useState(false);

  const finish = useCallback(
    async (publicToken: string | null) => {
      setBusy(true);
      try {
        const result = connectionId
          ? await completeBankReauthAction({}, form({ organizationId, connectionId }))
          : publicToken
            ? await completeBankLinkAction({}, form({ organizationId, publicToken }))
            : { error: "The bank didn't return anything to complete. Nothing was connected." };
        setState(result);
        if (result.success) router.refresh();
      } finally {
        setBusy(false);
      }
    },
    [connectionId, organizationId, router],
  );

  const open = useCallback(async () => {
    setBusy(true);
    setState({});
    try {
      const started = await startBankLinkAction({}, form({ organizationId, ...(connectionId ? { connectionId } : {}) }));
      if (!started.linkToken) {
        setState({ error: started.error ?? "The bank connection couldn't be started." });
        return;
      }
      const plaid = await loadPlaid();
      if (!plaid) {
        setState({ error: "The bank sign-in window couldn't be loaded. Check your connection and try again." });
        return;
      }

      // Kept only so an OAuth institution's redirect can resume this session.
      try {
        window.sessionStorage.setItem(RESUME_KEY, JSON.stringify({ token: started.linkToken, connectionId: connectionId ?? null }));
      } catch {
        // A browser with storage disabled simply cannot resume an OAuth flow.
      }

      const handler = plaid.create({
        token: started.linkToken,
        onSuccess: (publicToken: string) => {
          void finish(connectionId ? null : publicToken);
          handler.destroy();
        },
        onExit: (error: { display_message?: string } | null) => {
          handler.destroy();
          // A person closing the dialog is not an error worth shouting about.
          setState(error ? { message: "The bank sign-in didn't finish. Nothing was changed." } : {});
        },
      });
      handler.open();
    } catch {
      setState({ error: "The bank sign-in couldn't be opened. Please try again." });
    } finally {
      setBusy(false);
    }
  }, [connectionId, finish, organizationId]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button type="button" variant={variant} size={size} onClick={open} disabled={busy}>
        {busy ? "Opening…" : label}
      </Button>
      <Result state={state} />
    </div>
  );
}

/**
 * The return leg of an OAuth institution's sign-in.
 *
 * Plaid sends the customer to the bank's own site and back to
 * PLAID_REDIRECT_URI. Link is then re-created with the SAME token it started
 * with and the URL it came back to, which is what lets the dialog carry on
 * where it left off. Nothing else is read from that URL.
 */
export function PlaidOauthResume({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [state, setState] = useState<BankActionResult>({ message: "Finishing the bank sign-in…" });

  useEffect(() => {
    let cancelled = false;

    const resume = async () => {
      let stored: { token: string; connectionId: string | null } | null = null;
      try {
        const raw = window.sessionStorage.getItem(RESUME_KEY);
        stored = raw ? (JSON.parse(raw) as { token: string; connectionId: string | null }) : null;
      } catch {
        stored = null;
      }
      if (!stored?.token) {
        setState({ error: "There's no bank sign-in to finish here. Start again from Bank connections." });
        return;
      }

      const plaid = await loadPlaid();
      if (!plaid || cancelled) {
        setState({ error: "The bank sign-in window couldn't be loaded. Start again from Bank connections." });
        return;
      }

      const handler = plaid.create({
        token: stored.token,
        receivedRedirectUri: window.location.href,
        onSuccess: async (publicToken: string) => {
          handler.destroy();
          window.sessionStorage.removeItem(RESUME_KEY);
          const result = stored.connectionId
            ? await completeBankReauthAction({}, form({ organizationId, connectionId: stored.connectionId }))
            : await completeBankLinkAction({}, form({ organizationId, publicToken }));
          setState(result);
          if (result.success) router.replace(`/app/${organizationId}/bank-connections`);
        },
        onExit: () => {
          handler.destroy();
          window.sessionStorage.removeItem(RESUME_KEY);
          setState({ message: "The bank sign-in didn't finish. Nothing was changed." });
        },
      });
      handler.open();
    };

    void resume();
    return () => {
      cancelled = true;
    };
  }, [organizationId, router]);

  return <Result state={state} />;
}
