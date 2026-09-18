"use client";

import { Printer } from "@phosphor-icons/react/dist/ssr/Printer";
import { Button } from "@/components/ui/button";

/**
 * DESIGN.md §13 requires the printed invoice to be visually identical to the
 * on-screen one. The print stylesheet in globals.css does that work; this is
 * only the trigger.
 *
 * It calls the browser's own print dialog — there is no PDF service behind
 * it, and it does not claim there is. "Print" is exactly what it does, and
 * printing to PDF is something every OS already offers from that dialog.
 */
export function PrintInvoiceButton() {
  return (
    <Button variant="secondary" size="sm" onClick={() => window.print()}>
      <Printer size={14} />
      Print
    </Button>
  );
}
