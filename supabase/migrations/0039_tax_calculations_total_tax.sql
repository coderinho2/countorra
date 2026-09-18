-- The denormalised total column was named for the only jurisdiction that
-- existed when 0038 was written.
--
-- California is now implemented, and a California figure sitting in a column
-- called `total_federal_tax_minor` is misleading in the one place where
-- being misled is most expensive: someone reading the table directly, or
-- writing a report off it, would reasonably read every row as federal.
--
-- The table was always designed for more than one jurisdiction — `jurisdiction`
-- is text precisely so a new one needs no migration — so this corrects an
-- oversight rather than changing the design. A rename preserves every row,
-- the index, and the RLS policies, which all reference the table rather than
-- this column.
alter table tax_calculations rename column total_federal_tax_minor to total_tax_minor;

comment on column tax_calculations.total_tax_minor is
  'Total tax for the stamped jurisdiction — federal tax on a US_FEDERAL row, California tax on a US_CA row. Denormalised out of `totals` for sorting and display. Never sum across jurisdictions without grouping by `jurisdiction`: a federal and a state row for the same year are two different liabilities, not two halves of one.';
