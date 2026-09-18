"use client";

import { useMemo, useState } from "react";
import { Trash } from "@phosphor-icons/react/dist/ssr/Trash";
import { Plus } from "@phosphor-icons/react/dist/ssr/Plus";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { calculateInvoiceTotals } from "@/domain/invoicing/invoice-calculations";
import { format } from "@/domain/money/money";
import { isSupportedCurrency, type CurrencyCode } from "@/domain/money/currency";

interface DraftLineItem {
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
}

const EMPTY_ITEM: DraftLineItem = { description: "", quantity: "1", unitPrice: "", taxRate: "0" };

/** Feeds a hidden JSON field (`lineItems`) that the server action parses —
 *  totals shown here are a live preview computed with the same
 *  src/domain/invoicing math the server will use, so what the user sees
 *  while editing matches what actually gets saved. */
export function InvoiceLineItemsEditor({ currency }: { currency: string }) {
  const [items, setItems] = useState<DraftLineItem[]>([{ ...EMPTY_ITEM }]);
  const safeCurrency: CurrencyCode = isSupportedCurrency(currency) ? currency : "USD";

  const totals = useMemo(() => {
    const valid = items
      .filter((i) => i.description.trim() && i.unitPrice)
      .map((i) => ({ quantity: parseFloat(i.quantity) || 0, unitPriceMinor: Math.round(parseFloat(i.unitPrice) * 100) || 0, taxRate: parseFloat(i.taxRate) || 0, discountRate: 0 }));
    return calculateInvoiceTotals(valid, safeCurrency);
  }, [items, safeCurrency]);

  const update = (index: number, field: keyof DraftLineItem, value: string) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)));
  };

  const jsonPayload = JSON.stringify(
    items
      .filter((i) => i.description.trim() && i.unitPrice)
      .map((i) => ({ description: i.description, quantity: parseFloat(i.quantity) || 1, unitPrice: i.unitPrice, taxRate: parseFloat(i.taxRate) || 0 })),
  );

  return (
    <div className="flex flex-col gap-3">
      <input type="hidden" name="lineItems" value={jsonPayload} />

      <div className="flex flex-col gap-2">
        {items.map((item, i) => (
          <div key={i} className="grid grid-cols-[1fr_80px_100px_70px_28px] items-center gap-2">
            <Input placeholder="Description" value={item.description} onChange={(e) => update(i, "description", e.target.value)} />
            <Input placeholder="Qty" numeric inputMode="decimal" value={item.quantity} onChange={(e) => update(i, "quantity", e.target.value)} />
            <Input placeholder="Unit price" numeric inputMode="decimal" value={item.unitPrice} onChange={(e) => update(i, "unitPrice", e.target.value)} />
            <Input placeholder="Tax %" numeric inputMode="decimal" value={item.taxRate} onChange={(e) => update(i, "taxRate", e.target.value)} />
            <button
              type="button"
              onClick={() => setItems((prev) => prev.filter((_, idx) => idx !== i))}
              disabled={items.length === 1}
              className="flex size-7 items-center justify-center rounded-sm text-text-tertiary hover:text-negative disabled:opacity-30"
              aria-label="Remove line item"
            >
              <Trash size={16} />
            </button>
          </div>
        ))}
      </div>

      <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}>
        <Plus size={14} />
        Add line
      </Button>

      <div className="ml-auto flex w-56 flex-col gap-1 border-t border-border pt-3">
        <div className="flex justify-between text-[13px] text-text-secondary">
          <span>Subtotal</span>
          <span className="font-numeric">{format(totals.subtotal)}</span>
        </div>
        <div className="flex justify-between text-[13px] text-text-secondary">
          <span>Tax</span>
          <span className="font-numeric">{format(totals.tax)}</span>
        </div>
        <div className="flex justify-between text-[15px] font-medium text-ink">
          <span>Total</span>
          <span className="font-numeric">{format(totals.total)}</span>
        </div>
      </div>
    </div>
  );
}
