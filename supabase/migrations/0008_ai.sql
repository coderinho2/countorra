-- AI foundation: conversations, messages, usage tracking, insights, and the
-- authorization gate for tool-driven writes (DESIGN brief §13, §14).
--
-- ai_actions is the enforcement point for "AI cannot silently modify
-- financial records": any tool call classified WRITE or DELETE
-- (src/domain/ai/safety.ts) is recorded here in `pending_confirmation`
-- status and must be explicitly confirmed by a human before
-- src/domain/ai executes it. READ/ANALYZE/CALCULATE/SUGGEST tool calls
-- don't need a row here at all — they can't mutate anything.

create table ai_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id),
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ai_conversations_organization_id_idx on ai_conversations (organization_id);
create index ai_conversations_user_id_idx on ai_conversations (user_id);

create trigger ai_conversations_set_updated_at
  before update on ai_conversations
  for each row execute function set_updated_at();

-- See 0003_helper_functions.sql for the pattern this follows.
create or replace function org_id_of_conversation(target_conversation_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select c.organization_id from ai_conversations c where c.id = target_conversation_id;
$$;

create table ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references ai_conversations (id) on delete cascade,
  role ai_message_role not null,
  content text,
  tool_calls jsonb,
  tool_results jsonb,
  created_at timestamptz not null default now()
);

create index ai_messages_conversation_id_idx on ai_messages (conversation_id, created_at);

create table ai_usage (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  user_id uuid references auth.users (id),
  provider text not null,
  model text not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_minor bigint,
  created_at timestamptz not null default now()
);

create index ai_usage_organization_id_idx on ai_usage (organization_id, created_at);

create table ai_insights (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  data jsonb,
  generated_at timestamptz not null default now(),
  dismissed_at timestamptz,
  created_at timestamptz not null default now()
);

create index ai_insights_organization_id_idx on ai_insights (organization_id);

create table ai_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations (id) on delete cascade,
  conversation_id uuid references ai_conversations (id) on delete set null,
  operation_mode ai_operation_mode not null,
  tool_name text not null,
  input jsonb not null default '{}'::jsonb,
  status ai_action_status not null default 'pending_confirmation',
  confirmed_by uuid references auth.users (id),
  executed_at timestamptz,
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  -- A WRITE/DELETE action can never sit in a "done" state without a human
  -- having confirmed it — this is the database-level backstop for the
  -- rule described in DESIGN brief §14, not just an application check.
  check (
    status not in ('confirmed', 'executed')
    or operation_mode not in ('write', 'delete')
    or confirmed_by is not null
  )
);

create index ai_actions_organization_id_idx on ai_actions (organization_id, status);
