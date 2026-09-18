-- State/province, so a US organization can be routed to a STATE tax engine.
--
-- WHY THIS IS NEEDED AND WHY IT IS NULLABLE
--
-- Jurisdiction is derived server-side from the organization, never from a
-- model argument or a client claim — that is the rule that stops a request
-- asking to be taxed somewhere cheaper. Until now `country` was the only
-- thing to derive from, which was enough while only US_FEDERAL existed.
-- California is a state, so there has to be a state to read.
--
-- Nullable because it genuinely is unknown for every existing organization,
-- and because nine states levy no individual income tax at all. A null means
-- "no state engine applies" — which is the correct, safe answer, and is what
-- `stateJurisdictionFor` returns for it. Backfilling a guess would silently
-- put workspaces into a state tax regime they may not be in.
alter table organizations add column state_region char(2);

-- Two uppercase letters, matching the USPS abbreviation, or nothing. A
-- lowercase or free-text value would silently fail jurisdiction matching and
-- look like "California isn't supported".
alter table organizations add constraint organizations_state_region_format
  check (state_region is null or state_region ~ '^[A-Z]{2}$');

comment on column organizations.state_region is
  'USPS two-letter state code for US organizations, used to select a state tax engine. Null means no state engine applies. Never inferred — only what the organization set.';
