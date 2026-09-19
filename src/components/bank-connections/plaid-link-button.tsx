"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PLAID_END_USER_PRIVACY_POLICY_URL } from "@/domain/legal/facts";
import {
  completeBankLinkAction,
  completeBankOauthAction,
  completeBankReauthAction,
  resumeBankOauthAction,
  startBankLinkAction,
  type BankActionResult,
} from "@/server/bank-connections/actions";

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
 *   click ─▶ DISCLOSURE: what Plaid is, what it shares, what Countorra never
 *            sees — and a real choice to continue or not. Nothing is
 *            requested from the server, and Plaid's script is not loaded,
 *            until the person chooses "Continue to Plaid".
 *         ─▶ startBankLinkAction (authenticated, authorized, entitled, rate
 *            limited, server-side) ─▶ Link token, and a sealed session cookie
 *         ─▶ Plaid's dialog, in the customer's browser
 *         ─▶ public token ─▶ completeBankLinkAction ─▶ server exchanges it,
 *            encrypts the access token, creates the connection
 *
 * A bank that signs the customer in on its own website sends them to the one
 * fixed return page instead, where `PlaidOauthResume` picks up the SAME
 * session from the server — see below.
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

/**
 * What a person is told BEFORE Plaid opens, and why each sentence is here.
 *
 * Every statement is a fact about this codebase: Plaid is the provider
 * (src/server/bank-connections/providers/plaid); the only product requested
 * is `transactions`, which is what the list of shared data describes; the
 * access key is encrypted with AES-256-GCM before it is stored
 * (credential-crypto.ts); nothing is imported until the person chooses an
 * account; disconnecting removes access and keeps imported history.
 *
 * No checkbox, nothing pre-selected: continuing IS the choice, and cancelling
 * is equally prominent and changes nothing.
 */
export function BankConnectionDisclosure({ mode }: { mode: "connect" | "reauthenticate" }) {
  return (
    <div className="flex flex-col gap-3 text-[13px] leading-[1.6] text-text-secondary">
      <p>
        Countorra uses <strong className="font-medium text-text-primary">Plaid</strong> to connect to your bank.{" "}
        {mode === "reauthenticate" ? "Plaid opens next so you can sign in to your bank again." : "Plaid opens next, and you choose your bank and sign in there."}
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-5">
        <li>
          <strong className="font-medium text-text-primary">Countorra never sees or stores your bank username or password.</strong> You enter them with Plaid and your
          bank, not with Countorra.
        </li>
        <li>
          With your permission, Plaid shares your accounts&apos; names, types, last four digits and balances, and their transactions, with Countorra. Countorra stores
          the access key Plaid provides for this connection encrypted.
        </li>
        <li>Nothing enters your books until you choose which Countorra account each bank account feeds.</li>
        <li>You can disconnect at any time on this page. Transactions already imported stay in your books.</li>
      </ul>
      <p>
        Read{" "}
        <a href={PLAID_END_USER_PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
          Plaid&apos;s End User Privacy Policy
        </a>{" "}
        and{" "}
        <a href="/privacy#bank-connections" target="_blank" rel="noopener noreferrer" className="text-accent underline-offset-2 hover:underline">
          how Countorra handles bank data
        </a>
        .
      </p>
    </div>
  );
}

export function PlaidLinkButton({ organizationId, connectionId, label, variant = "primary", size = "md" }: PlaidLinkButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<BankActionResult>({});
  const [busy, setBusy] = useState(false);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const mode = connectionId ? "reauthenticate" : "connect";

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

      // Nothing is stored in the browser. If the bank signs the customer in
      // on its own site, the return page resumes this session from the
      // HttpOnly cookie the server sealed when it created the token.
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

  const proceed = useCallback(() => {
    setDisclosureOpen(false);
    void open();
  }, [open]);

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button type="button" variant={variant} size={size} onClick={() => setDisclosureOpen(true)} disabled={busy}>
        {busy ? "Opening…" : label}
      </Button>
      <Dialog open={disclosureOpen} onOpenChange={setDisclosureOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{mode === "reauthenticate" ? "Sign in to your bank again through Plaid" : "Connect a bank through Plaid"}</DialogTitle>
            <DialogDescription className="sr-only">How Countorra connects to your bank, and what is shared, before Plaid opens.</DialogDescription>
          </DialogHeader>
          <BankConnectionDisclosure mode={mode} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setDisclosureOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={proceed}>
              Continue to Plaid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Result state={state} />
    </div>
  );
}

/**
 * The return leg of an OAuth institution's sign-in, on the ONE fixed return
 * page every organization shares.
 *
 * Nothing is read from browser storage and nothing from the URL except what
 * Plaid itself needs back (`receivedRedirectUri`). The server opens the
 * session it sealed when Link started, checks it belongs to whoever is signed
 * in, and hands back the same Link token — held in memory for these few
 * seconds only — and the organization it belongs to. Completing sends only
 * the public token; the organization is the server's.
 */
export function PlaidOauthResume() {
  const router = useRouter();
  const [state, setState] = useState<BankActionResult>({ message: "Finishing the bank sign-in…" });

  useEffect(() => {
    let cancelled = false;

    const resume = async () => {
      const resumed = await resumeBankOauthAction();
      if (cancelled) return;
      if (!resumed.linkToken || !resumed.organizationId) {
        setState({ error: resumed.error ?? "There's no bank sign-in to finish here. Start again from Bank connections." });
        return;
      }
      const organizationId = resumed.organizationId;

      const plaid = await loadPlaid();
      if (!plaid || cancelled) {
        setState({ error: "The bank sign-in window couldn't be loaded. Start again from Bank connections." });
        return;
      }

      const handler = plaid.create({
        token: resumed.linkToken,
        receivedRedirectUri: window.location.href,
        onSuccess: async (publicToken: string) => {
          handler.destroy();
          const data = new FormData();
          if (resumed.mode !== "reauthenticate") data.set("publicToken", publicToken);
          const result = await completeBankOauthAction({}, data);
          setState(result);
          if (result.success) router.replace(`/app/${organizationId}/bank-connections`);
        },
        onExit: () => {
          handler.destroy();
          setState({ message: "The bank sign-in didn't finish. Nothing was changed." });
        },
      });
      handler.open();
    };

    void resume();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return <Result state={state} />;
}
