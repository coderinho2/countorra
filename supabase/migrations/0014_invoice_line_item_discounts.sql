-- Additive extension of `invoice_line_items` (Phase 2 product spec §15:
-- discounts). Discount is a rate (not a flat amount) so it composes
-- correctly with quantity/unit price without a separate "discount line"
-- hack; application code (src/domain/invoicing) computes the discounted
-- amount, this column is just storage for what rate was applied.

alter table invoice_line_items
  add column discount_rate numeric(5, 2) not null default 0 check (discount_rate >= 0 and discount_rate <= 100);
