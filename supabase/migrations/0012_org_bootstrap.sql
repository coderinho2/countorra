-- Organization bootstrap: when a new organization is created, the creator
-- becomes its 'owner' member, gets a starter set of categories, and the org
-- gets a 'free' subscription row. All three must happen atomically with the
-- INSERT and bypass RLS (a brand-new org has zero memberships, so the normal
-- memberships_insert_admin policy — which requires an existing owner/admin —
-- can never fire for the very first row; SECURITY DEFINER is the deliberate
-- exception, scoped to exactly this bootstrap moment).

create or replace function bootstrap_new_organization()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into memberships (organization_id, user_id, role, invited_by)
  values (new.id, new.created_by, 'owner', new.created_by);

  insert into subscriptions (organization_id, plan_id, status)
  values (new.id, 'free', 'active');

  insert into transaction_categories (organization_id, kind, name, is_system) values
    (new.id, 'income', 'Salary', true),
    (new.id, 'income', 'Other Income', true),
    (new.id, 'expense', 'Housing', true),
    (new.id, 'expense', 'Utilities', true),
    (new.id, 'expense', 'Groceries', true),
    (new.id, 'expense', 'Transportation', true),
    (new.id, 'expense', 'Software & Subscriptions', true),
    (new.id, 'expense', 'Taxes', true),
    (new.id, 'expense', 'Other Expense', true);

  perform record_audit_event(
    new.id,
    'organization.created',
    'organization',
    new.id,
    jsonb_build_object('entity_type', new.entity_type, 'name', new.name)
  );

  return new;
end;
$$;

create trigger on_organization_created
  after insert on organizations
  for each row execute function bootstrap_new_organization();
