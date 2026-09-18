-- Private Storage bucket for uploaded documents (product spec §21, §37:
-- "must never expose private financial documents through public
-- buckets"). Objects are stored at `<organization_id>/<uuid>-<filename>`
-- — the leading path segment is what the RLS policies below key on, the
-- same is_org_member()/is_org_role() pattern used everywhere else, just
-- applied to `storage.objects.name` instead of a `organization_id` column
-- (Storage's schema doesn't have one; the path prefix is the tenant key).

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

create policy documents_storage_select_member on storage.objects
  for select using (
    bucket_id = 'documents'
    and is_org_member((storage.foldername(name))[1]::uuid)
  );

create policy documents_storage_insert_member on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and is_org_role((storage.foldername(name))[1]::uuid, array['owner', 'admin', 'accountant', 'manager', 'employee']::org_role[])
  );

create policy documents_storage_delete_privileged on storage.objects
  for delete using (
    bucket_id = 'documents'
    and is_org_role((storage.foldername(name))[1]::uuid, array['owner', 'admin', 'accountant']::org_role[])
  );
