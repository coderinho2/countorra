import { createRoot } from "react-dom/client";
import { DeleteAccountDialog } from "@/components/settings/delete-account-dialog";

/**
 * TEST-ONLY. Renders the REAL delete-account dialog with its Server Action
 * replaced by a recorder (account-actions-stub.ts).
 */

window.__deleteSubmissions = [];
window.__deleteResult = {};
window.__deleteDelay = 50;

createRoot(document.getElementById("root")!).render(
  <main className="p-10">
    <h1 className="text-lg font-semibold text-ink">Delete account harness</h1>
    <DeleteAccountDialog />
  </main>,
);
