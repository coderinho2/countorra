-- A stored calculation must record BOTH the year it is about and the year
-- whose rules produced it.
--
-- WHY THIS IS NOT COSMETIC
--
-- California 2026 is answered with the 2025 rules FTB has actually published,
-- because the 2026 schedules do not exist yet. That is disclosed on every
-- result — but a stored row that recorded only one year would lose the
-- distinction the moment it was written, and a row saying "2026" would later
-- be read as an authoritative 2026 calculation. `rule_set_version` alone is
-- not enough: it is a bare string, and reading the year out of it means
-- parsing it.
--
-- So: `tax_year` keeps its existing meaning (the rules that ran, which
-- `rule_set_version` pins), and the two new columns say what was asked and
-- whether the answer used the requested year's own published rules.
alter table tax_calculations add column requested_tax_year int;
alter table tax_calculations add column calculation_status text;

-- Existing rows are all US_FEDERAL, where no substitution has ever been
-- possible: the requested year IS the rule-set year. Backfilling from
-- `tax_year` restates a fact rather than inventing one.
update tax_calculations
  set requested_tax_year = tax_year,
      calculation_status = 'PUBLISHED_RULES'
  where requested_tax_year is null;

alter table tax_calculations alter column requested_tax_year set not null;
alter table tax_calculations alter column calculation_status set not null;

alter table tax_calculations add constraint tax_calculations_requested_tax_year_range
  check (requested_tax_year between 1900 and 2200);

-- Constrained rather than free text: an unrecognised status would be read as
-- "probably fine" by anyone querying this table.
alter table tax_calculations add constraint tax_calculations_calculation_status_known
  check (calculation_status in ('PUBLISHED_RULES', 'ESTIMATE_USING_LATEST_PUBLISHED_RULES'));

comment on column tax_calculations.requested_tax_year is
  'The tax year the user asked about. Differs from tax_year only when the requested year''s rules were not fully published and a disclosed fallback was used.';

comment on column tax_calculations.calculation_status is
  'PUBLISHED_RULES when tax_year is the requested year''s own published rules. ESTIMATE_USING_LATEST_PUBLISHED_RULES when an older, fully published rule set was used and disclosed. Never present such a row as an authoritative calculation for requested_tax_year.';

-- Queries are "show me this year's calculations", which means the year the
-- user asked about.
create index tax_calculations_requested_year_idx
  on tax_calculations (organization_id, requested_tax_year, created_at desc);
