create extension if not exists pgcrypto;

create table if not exists public.cloud_folders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  parent_id uuid references public.cloud_folders(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_folders_name_length check (char_length(trim(name)) between 1 and 80),
  constraint cloud_folders_name_no_slash check (name !~ '[\\/]')
);

create table if not exists public.cloud_files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  folder_id uuid references public.cloud_folders(id) on delete set null,
  name text not null,
  mime_type text not null default 'application/octet-stream',
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  storage_bucket text not null default 'cloud-files',
  storage_path text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cloud_files_name_length check (char_length(trim(name)) between 1 and 180),
  constraint cloud_files_name_no_slash check (name !~ '[\\/]')
);

create unique index if not exists cloud_folders_unique_root_name
  on public.cloud_folders (owner_id, lower(name))
  where parent_id is null;

create unique index if not exists cloud_folders_unique_child_name
  on public.cloud_folders (owner_id, parent_id, lower(name))
  where parent_id is not null;

create unique index if not exists cloud_files_unique_root_name
  on public.cloud_files (owner_id, lower(name))
  where folder_id is null;

create unique index if not exists cloud_files_unique_child_name
  on public.cloud_files (owner_id, folder_id, lower(name))
  where folder_id is not null;

create index if not exists cloud_folders_parent_idx
  on public.cloud_folders (owner_id, parent_id, name);

create index if not exists cloud_files_folder_idx
  on public.cloud_files (owner_id, folder_id, name);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_cloud_folders_updated_at on public.cloud_folders;
create trigger set_cloud_folders_updated_at
before update on public.cloud_folders
for each row execute function public.set_updated_at();

drop trigger if exists set_cloud_files_updated_at on public.cloud_files;
create trigger set_cloud_files_updated_at
before update on public.cloud_files
for each row execute function public.set_updated_at();

create or replace function public.enforce_cloud_folder_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_owner uuid;
begin
  if new.owner_id is null then
    new.owner_id = auth.uid();
  end if;

  if new.parent_id is not null then
    select owner_id into parent_owner
    from public.cloud_folders
    where id = new.parent_id;

    if parent_owner is null then
      raise exception 'Parent folder does not exist';
    end if;

    if parent_owner <> new.owner_id then
      raise exception 'Parent folder belongs to another user';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_cloud_folder_owner on public.cloud_folders;
create trigger enforce_cloud_folder_owner
before insert or update of owner_id, parent_id on public.cloud_folders
for each row execute function public.enforce_cloud_folder_owner();

create or replace function public.enforce_cloud_file_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  folder_owner uuid;
begin
  if new.owner_id is null then
    new.owner_id = auth.uid();
  end if;

  if new.folder_id is not null then
    select owner_id into folder_owner
    from public.cloud_folders
    where id = new.folder_id;

    if folder_owner is null then
      raise exception 'Folder does not exist';
    end if;

    if folder_owner <> new.owner_id then
      raise exception 'Folder belongs to another user';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_cloud_file_owner on public.cloud_files;
create trigger enforce_cloud_file_owner
before insert or update of owner_id, folder_id on public.cloud_files
for each row execute function public.enforce_cloud_file_owner();

alter table public.cloud_folders enable row level security;
alter table public.cloud_files enable row level security;

drop policy if exists "Cloud folders are owner readable" on public.cloud_folders;
create policy "Cloud folders are owner readable"
on public.cloud_folders for select
using (owner_id = auth.uid());

drop policy if exists "Cloud folders are owner insertable" on public.cloud_folders;
create policy "Cloud folders are owner insertable"
on public.cloud_folders for insert
with check (owner_id = auth.uid());

drop policy if exists "Cloud folders are owner editable" on public.cloud_folders;
create policy "Cloud folders are owner editable"
on public.cloud_folders for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Cloud folders are owner deletable" on public.cloud_folders;
create policy "Cloud folders are owner deletable"
on public.cloud_folders for delete
using (owner_id = auth.uid());

drop policy if exists "Cloud files are owner readable" on public.cloud_files;
create policy "Cloud files are owner readable"
on public.cloud_files for select
using (owner_id = auth.uid());

drop policy if exists "Cloud files are owner insertable" on public.cloud_files;
create policy "Cloud files are owner insertable"
on public.cloud_files for insert
with check (owner_id = auth.uid());

drop policy if exists "Cloud files are owner editable" on public.cloud_files;
create policy "Cloud files are owner editable"
on public.cloud_files for update
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

drop policy if exists "Cloud files are owner deletable" on public.cloud_files;
create policy "Cloud files are owner deletable"
on public.cloud_files for delete
using (owner_id = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit)
values ('cloud-files', 'cloud-files', false, 104857600)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "Cloud storage objects are owner readable" on storage.objects;
create policy "Cloud storage objects are owner readable"
on storage.objects for select
using (
  bucket_id = 'cloud-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Cloud storage objects are owner insertable" on storage.objects;
create policy "Cloud storage objects are owner insertable"
on storage.objects for insert
with check (
  bucket_id = 'cloud-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Cloud storage objects are owner editable" on storage.objects;
create policy "Cloud storage objects are owner editable"
on storage.objects for update
using (
  bucket_id = 'cloud-files'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'cloud-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "Cloud storage objects are owner deletable" on storage.objects;
create policy "Cloud storage objects are owner deletable"
on storage.objects for delete
using (
  bucket_id = 'cloud-files'
  and (storage.foldername(name))[1] = auth.uid()::text
);
