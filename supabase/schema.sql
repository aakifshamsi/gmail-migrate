-- Gmail Migrate — Supabase schema
-- Phase 2 will wire this up; for now the workflow uses git JSON state files.

create table if not exists migration_runs (
  id            bigserial primary key,
  run_number    integer not null,
  dest_id       text not null,             -- 'dest1' | 'dest2'
  strategy      text not null,
  dry_run       boolean not null default false,
  status        text not null default 'pending',  -- pending | running | completed | dry-run | failed
  emails_copied integer not null default 0,
  bytes_copied  bigint  not null default 0,
  errors        integer not null default 0,
  folders_done  text[]  not null default '{}',
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists folder_progress (
  id            bigserial primary key,
  run_id        bigint references migration_runs(id) on delete cascade,
  folder_name   text not null,
  emails_copied integer not null default 0,
  bytes_copied  bigint  not null default 0,
  emails_skipped integer not null default 0,
  completed     boolean not null default false,
  last_msg_id   text,
  updated_at    timestamptz not null default now()
);

create index if not exists idx_migration_runs_dest   on migration_runs(dest_id);
create index if not exists idx_migration_runs_status on migration_runs(status);
create index if not exists idx_folder_progress_run   on folder_progress(run_id);
