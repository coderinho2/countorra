-- ai_conversations had select/insert/update policies (0011_rls_policies.sql)
-- but no delete policy at all, so RLS's default-deny meant no one — not
-- even the conversation's own creator — could delete one. Adds exactly
-- one policy, matching the existing `_update_own` pattern: only the
-- conversation's creator may delete it, and only within an org they still
-- belong to. ai_messages rows cascade automatically (FK `on delete
-- cascade`, 0008_ai.sql) — a foreign-key cascade is enforced by Postgres
-- independent of RLS on the child table, so no separate policy is needed
-- there.

create policy ai_conversations_delete_own on ai_conversations
  for delete using (is_org_member(organization_id) and user_id = auth.uid());
