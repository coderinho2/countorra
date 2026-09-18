-- Makes `pending` the default and gives the cleanup sweep an index.
-- Separate from 0030 only because Postgres forbids using an enum value in the
-- transaction that added it; see that file's header.

-- FAIL SAFE, NOT FAIL OPEN.
--
-- The default was 'uploaded', which meant any insert that forgot to set a
-- status produced a row the product would immediately show and hand out a
-- signed download URL for — before anything had confirmed a file was there.
-- `pending` inverts that: an incomplete insert is invisible until a server
-- promotes it. Application code still sets the status explicitly; this is the
-- backstop for the path that doesn't.
--
-- Existing rows are left alone deliberately. Every one of them was written by
-- the old single-request action, which wrote the row only after the bytes
-- landed, so 'uploaded' is accurate for all of them. Rewriting them to
-- 'pending' would hide real documents from their owners.
alter table documents alter column status set default 'pending';

comment on column documents.status is
  'Upload lifecycle. pending -> uploaded on a server-verified object; pending -> rejected when verification fails. Only ''uploaded'' rows are visible to product reads (src/server/db/repositories/documents.ts).';

-- The cleanup sweep asks one question: which non-terminal or rejected rows are
-- older than the TTL. Without this it is a sequential scan over every document
-- in the table to find the handful that were abandoned.
create index documents_incomplete_created_idx
  on documents (created_at)
  where status in ('pending', 'rejected');
