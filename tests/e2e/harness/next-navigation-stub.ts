/**
 * TEST-ONLY: `next/navigation` outside a Next app.
 *
 * The bank-connection client components refresh the server-rendered page after
 * a successful action. In the harness there is no server to refresh, so the
 * calls are recorded instead — a test can then assert that a success refreshes
 * and a failure does not.
 */

declare global {
  interface Window {
    __routerCalls: string[];
  }
}

function record(call: string): void {
  window.__routerCalls = window.__routerCalls ?? [];
  window.__routerCalls.push(call);
}

export function useRouter() {
  return {
    refresh: () => record("refresh"),
    push: (href: string) => record(`push:${href}`),
    replace: (href: string) => record(`replace:${href}`),
    back: () => record("back"),
    forward: () => record("forward"),
    prefetch: () => {},
  };
}

export function usePathname(): string {
  return window.location.pathname;
}

export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}
