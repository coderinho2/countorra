/**
 * Shell-free wrapper for /login, /signup, /verify-email, /forgot-password
 * and /reset-password.
 *
 * It deliberately contributes no chrome. /login and /signup are full-bleed
 * two-column screens with their own brand panel (AuthSplit); the other three
 * opt into the centered column this layout used to impose on everything
 * (AuthShell). A route-group layout cannot tell which page is rendering, so
 * the choice belongs to the page.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-full flex-1 flex-col">{children}</div>;
}
