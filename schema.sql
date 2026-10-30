-- Sync engine schema (see README.md). Copy into a migration of the app,
-- then add one trigger per synced table (columns: the ones users may read):
--
--   create trigger sync_<table>
--     after insert or update or delete on public.<table>
--     for each row execute function public.record_sync_action('id', 'user_id', ...);
--
--   alter publication supabase_realtime add table public.sync_actions;
--
-- Every synced table needs `id uuid` and `user_id uuid`; a `deleted_at`
-- column (soft delete) counts as a delete.

create table public.sync_actions (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  -- The table the row belongs to.
  model text not null,
  model_id uuid not null,
  -- I = insert, U = update, D = delete (or soft delete: deleted_at set).
  action text not null check (action in ('I', 'U', 'D')),
  -- The row as the user may read it (the columns the trigger lists); null
  -- for D.
  data jsonb,
  created_at timestamptz not null default now()
);

create index sync_actions_user_id_idx on public.sync_actions (user_id, id);

alter table public.sync_actions enable row level security;
create policy "own sync actions select" on public.sync_actions
  for select to authenticated using (user_id = (select auth.uid()));

-- Appends the change of one row. The trigger arguments are the columns
-- that go into `data`: an allow-list, so columns users may not read (provider
-- internals) or that change all the time (live traces) stay out, and a new
-- column stays out until it is listed. An update that changes none of them
-- is not recorded.
--
-- A per-user lock makes the sync ids of one user commit in order: a client
-- that has seen sync id N never gets a smaller one later.
-- ponytail: serializes writes per user; per-row locks if one user writes a lot in parallel.
create function public.record_sync_action()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_data jsonb;
  prev_data jsonb;
  row_user uuid;
  row_id uuid;
  act text;
begin
  if tg_op = 'DELETE' then
    row_user := old.user_id;
    row_id := old.id;
    act := 'D';
  else
    row_user := new.user_id;
    row_id := new.id;
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into next_data
    from jsonb_each(to_jsonb(new)) where key = any(tg_argv);
    if tg_op = 'UPDATE' then
      select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) into prev_data
      from jsonb_each(to_jsonb(old)) where key = any(tg_argv);
      if next_data = prev_data
        and (to_jsonb(new) -> 'deleted_at') is not distinct from (to_jsonb(old) -> 'deleted_at')
      then
        return null;
      end if;
      act := 'U';
    else
      act := 'I';
    end if;
    -- Soft-deleted rows are hidden from the user, so for the client they
    -- are gone.
    if (to_jsonb(new) ->> 'deleted_at') is not null then
      act := 'D';
      next_data := null;
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(row_user::text, 0));
  insert into public.sync_actions (user_id, model, model_id, action, data)
  values (row_user, tg_table_name, row_id, act, next_data);
  return null;
end;
$$;

revoke execute on function public.record_sync_action() from public, anon, authenticated;
