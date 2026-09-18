-- Married filing separately: whether the spouse itemizes deductions.
--
-- WHY THIS EXISTS
--
-- IRS Topic no. 551 (Standard deduction) lists, among the taxpayers who
-- "aren't entitled to the standard deduction", a married individual filing
-- as married filing separately whose spouse itemizes deductions. The federal
-- engine only ever applies the standard deduction, so for a married-filing-
-- separately return the answer to this one question decides whether the
-- computed figure can be right at all:
--
--   null   not answered   → readiness asks for review; nothing is finalizable
--   true   spouse itemizes → preparation blocks calculation; no figure is made
--   false  spouse doesn't  → the standard deduction applies as computed
--
-- It is a fact the person records, not a determination Countorra makes, and
-- it is read only for married filing separately.
--
-- Additive: one nullable column. No row is changed, no existing column,
-- constraint, policy or trigger is altered. Member access follows the
-- existing row policies on tax_preparation_cases.

alter table tax_preparation_cases
  add column spouse_itemizes_deductions boolean;

comment on column tax_preparation_cases.spouse_itemizes_deductions is
  'Married filing separately only: whether the spouse itemizes deductions (IRS Topic 551 — if so, the standard deduction is not allowed). NULL means not answered. Recorded by a person; never inferred.';
