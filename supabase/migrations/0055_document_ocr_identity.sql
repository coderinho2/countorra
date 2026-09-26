-- ════════════════════════════════════════════════════════════════════════════
-- 0055 — OCR document classes, and identity documents as a protected class
-- ════════════════════════════════════════════════════════════════════════════
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
--
--   Document intelligence (0046) could read digital PDFs only, and every type
--   it knew about was financial. Amazon Textract adds real OCR, which brings
--   two kinds of document the schema has no vocabulary for:
--
--     * bills, as a class distinct from an invoice
--     * identity documents — US driver's licences, US passports, Social
--       Security documents, other government ID
--
--   The second is the reason this migration is careful rather than a two-line
--   widening of a CHECK. An identity document carries government identifiers,
--   and the application is written never to store them
--   (src/domain/documents/intelligence/identity.ts). The constraints below
--   make that a property of the DATABASE, so a future change to the
--   application — or a direct write by the service role — cannot quietly
--   start persisting them.
--
-- ── WHAT IT DOES ────────────────────────────────────────────────────────────
--
--   1. document_extractions.document_type accepts the five new classes.
--   2. document_extracted_fields.section accepts 'IDENTITY'.
--   3. An IDENTITY field may hold no money. An identity document cannot
--      carry an amount into the ledger because it cannot hold one at all.
--   4. An IDENTITY field may hold at most four consecutive digits, except
--      where it is a date. Four digits is the masked tail the product shows
--      ("••••1234"); anything longer is a document number being stored, which
--      is exactly what must not happen.
--   5. operations_schema_version() → '0055'.
--
-- ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
--
--   No table is created, no row is rewritten, no policy changes. Existing
--   extractions keep their types, their fields and their RLS. The existing
--   SSN backstop from 0046 (document_extracted_fields_no_ssn) is untouched
--   and still applies to every row of every class; rule 4 sits alongside it
--   and is stricter for identity documents only.
--
-- ── DEPLOY ORDER ────────────────────────────────────────────────────────────
--
--   MIGRATE FIRST, THEN DEPLOY. The new code writes the new document types
--   and the IDENTITY section, and the old constraints would reject them. The
--   old code writes nothing this migration forbids, so running it ahead of
--   the deploy is safe and leaves no window where a read fails.
--
--   To roll back, restore the two CHECK constraints to their 0046 form and
--   drop the two added below:
--
--   alter table document_extracted_fields
--     drop constraint document_extracted_fields_identity_no_money,
--     drop constraint document_extracted_fields_identity_no_identifiers;
--   create or replace function operations_schema_version() returns text language sql immutable as $$ select '0054'::text $$;

-- ── 1. The new document classes ────────────────────────────────────────────

alter table document_extractions
  drop constraint if exists document_extractions_document_type_check;

alter table document_extractions
  add constraint document_extractions_document_type_check check (
    document_type in (
      'W2', 'FORM_1099_NEC', 'FORM_1099_MISC', 'FORM_1099_INT', 'FORM_1099_DIV', 'FORM_1099_B', 'FORM_1099_R',
      'FORM_1098', 'FORM_1098_T', 'FORM_1095_A', 'PAY_STUB', 'BANK_STATEMENT', 'INVOICE', 'RECEIPT', 'BILL',
      'OTHER_FINANCIAL',
      -- Identity. Constrained further on the fields table below.
      'DRIVER_LICENSE', 'PASSPORT', 'SSN_DOCUMENT', 'GOVERNMENT_ID',
      'UNKNOWN'
    )
  );

-- ── 2. The IDENTITY section ────────────────────────────────────────────────

alter table document_extracted_fields
  drop constraint if exists document_extracted_fields_section_check;

alter table document_extracted_fields
  add constraint document_extracted_fields_section_check check (
    section in (
      'DOCUMENT', 'PARTIES', 'INCOME', 'WITHHOLDING', 'DEDUCTIONS', 'STATE', 'LOCAL',
      'PERIOD', 'BALANCES', 'TOTALS', 'LINE_ITEMS', 'TRANSACTIONS', 'IDENTITY'
    )
  );

-- ── 3. An identity field holds no money ────────────────────────────────────
--
--   Not a formatting rule. It is what makes "an identity document cannot
--   affect your finances" true at the level where it cannot be bypassed: a
--   field with no amount has nothing to propose into a tax fact or a
--   transaction, whatever code later reads it.

alter table document_extracted_fields
  drop constraint if exists document_extracted_fields_identity_no_money;

alter table document_extracted_fields
  add constraint document_extracted_fields_identity_no_money check (
    section <> 'IDENTITY'
    or (amount_minor is null and normalized_decimal is null and currency is null)
  );

-- ── 4. An identity field holds no identifier ───────────────────────────────
--
--   At most four consecutive digits, which is the masked tail the review
--   screen shows. A date is exempt because an ISO date is four digits of
--   year followed by separators, and a date is not an identifier.
--
--   This is the database's own copy of the rule in identity.ts. Both exist on
--   purpose: the application's version produces a good error during
--   development, and this one survives the application being wrong.

alter table document_extracted_fields
  drop constraint if exists document_extracted_fields_identity_no_identifiers;

alter table document_extracted_fields
  add constraint document_extracted_fields_identity_no_identifiers check (
    section <> 'IDENTITY'
    or value_kind = 'DATE'
    or (
      (raw_value is null or raw_value !~ '[0-9]{5,}')
      and (normalized_text is null or normalized_text !~ '[0-9]{5,}')
    )
  );

-- ── 5. Schema version ──────────────────────────────────────────────────────

create or replace function operations_schema_version() returns text language sql immutable as $$ select '0055'::text $$;
