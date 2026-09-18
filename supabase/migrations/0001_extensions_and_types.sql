-- Extensions
create extension if not exists "pgcrypto" with schema public;

-- Enumerated types shared across domains. Free-form event/action vocabularies
-- (audit_logs.action, security_events.event_type, documents.status transitions
-- beyond the type below) intentionally use `text`, not enums, because they grow
-- often and an enum requires a migration per new value; the types below are
-- small, stable, and central to authorization logic, so an enum's safety is
-- worth the rigidity.

create type user_entity_type as enum ('personal', 'freelancer', 'business');

create type org_role as enum ('owner', 'admin', 'accountant', 'manager', 'employee', 'viewer');

create type transaction_kind as enum ('income', 'expense', 'transfer');

create type invoice_status as enum ('draft', 'sent', 'paid', 'overdue', 'void');

create type document_kind as enum ('invoice', 'receipt', 'bill', 'bank_statement', 'other');

create type document_status as enum ('uploaded', 'processing', 'processed', 'failed', 'needs_review');

create type ai_message_role as enum ('user', 'assistant', 'system', 'tool');

-- Mirrors src/domain/ai/safety.ts OperationMode — the AI's declared intent for
-- a tool call. READ/ANALYZE/CALCULATE/SUGGEST never touch data; WRITE/DELETE
-- always require the confirmation flow in ai_actions (see 0008_ai.sql).
create type ai_operation_mode as enum ('read', 'analyze', 'calculate', 'suggest', 'write', 'delete');

create type ai_action_status as enum ('pending_confirmation', 'confirmed', 'executed', 'rejected', 'failed');

create type plan_tier as enum ('free', 'premium', 'business');

create type subscription_status as enum ('active', 'trialing', 'past_due', 'canceled', 'incomplete');

-- Shared trigger: keeps `updated_at` correct without relying on application
-- code to remember it on every write.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
