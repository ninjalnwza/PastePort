-- =============================================================================
-- PastePort backend for Supabase (the app was first called ClipShare, hence
-- the "clipshare" schema; keep that name so existing rooms keep working)
--
-- How to install: Supabase Dashboard -> SQL Editor -> New query ->
-- paste this whole file -> Run.  It is safe to run again later (idempotent).
--
-- Design notes
--  * Tables live in the private schema "clipshare", which the public API
--    cannot read. Clients can only use the clip_* functions below.
--  * A room is identified by a 64-hex "room id" that clients derive from the
--    room code with PBKDF2. The server never sees the room code itself.
--  * Payloads and file chunks are end-to-end encrypted in the client
--    (AES-256-CBC + HMAC-SHA256), so the database only stores ciphertext.
--  * Old items are removed automatically (see clipshare.limits()).
--  * Deleting only marks an item. Its space is freed a little at a time by
--    clipshare.gc(), which every write call runs briefly first, so no call
--    comes near the API's 3-second statement timeout, however much there is
--    to free.
-- =============================================================================

create schema if not exists clipshare;
revoke all on schema clipshare from public, anon, authenticated;

create sequence if not exists clipshare.seq;

create table if not exists clipshare.items (
  id          uuid primary key default gen_random_uuid(),
  room        text        not null,
  seq         bigint,                                   -- set when visible / changed
  created_at  timestamptz not null default now(),
  sender      text        not null default '',          -- random device id
  kind        text        not null check (kind in ('text', 'blob')),
  payload     text        not null,                     -- encrypted (base64)
  size        bigint      not null default 0,           -- bytes (blob)
  chunks      int         not null default 0,
  complete    boolean     not null default false,
  deleted     boolean     not null default false
);
create index if not exists items_room_seq_idx on clipshare.items (room, seq);
create index if not exists items_created_idx  on clipshare.items (created_at);

create table if not exists clipshare.chunks (
  item_id uuid  not null references clipshare.items (id) on delete cascade,
  idx     int   not null,
  data    bytea not null,
  primary key (item_id, idx)
);

alter table clipshare.items  enable row level security;
alter table clipshare.chunks enable row level security;
revoke all on all tables    in schema clipshare from public, anon, authenticated;
revoke all on all sequences in schema clipshare from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Limits (edit and re-run to change)
-- ----------------------------------------------------------------------------
create or replace function clipshare.limits(
  out retention   interval,
  out max_text    int,
  out max_file    bigint,
  out chunk_max   int,
  out room_quota  bigint,
  out total_quota bigint)
language sql immutable
set search_path = ''
as $$
  select interval '72 hours',          -- keep items this long
         2 * 1024 * 1024,              -- max encrypted text payload (chars)
         50::bigint * 1024 * 1024,     -- max file size (bytes)
         1024 * 1024 + 4096,           -- max encrypted chunk size (bytes)
         250::bigint * 1024 * 1024,    -- storage per room (bytes)
         380::bigint * 1024 * 1024     -- storage for all rooms (free DB is 500 MB)
$$;

-- ----------------------------------------------------------------------------
-- Internal helpers
-- ----------------------------------------------------------------------------
create or replace function clipshare.check_room(p_room text)
returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_room is null or p_room !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid room id' using errcode = '22023';
  end if;
end
$$;

-- Changes in one room are serialised (the lock is held until commit), so a
-- room's sequence numbers become visible in order and clients can simply ask
-- for "everything after the highest number I have seen".
create or replace function clipshare.lock_room(p_room text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('clipshare:' || p_room, 0));
end
$$;

-- Mark an item as deleted, with a new sequence number so that clients hear
-- about it. Its data stays until gc() frees it, which keeps this quick
-- however large the item is.
create or replace function clipshare.tombstone(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update clipshare.items i
     set deleted = true, seq = nextval('clipshare.seq')
   where i.id = p_id;
end
$$;

-- Free the space of deleted items, expired items and abandoned uploads, one
-- small step at a time: a step removes one chunk (about 1 MB at most) or one
-- item. Steps repeat until p_budget has passed, with at least one step per
-- call, so however much is waiting, a call stays short. Rows that another
-- request is using are skipped; a later call frees them. Returns the number
-- of steps taken (0 = nothing left to free).
create or replace function clipshare.gc(p_budget interval)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deadline  timestamptz := clock_timestamp() + coalesce(p_budget, interval '0');
  v_expired   timestamptz := now() - (select l.retention from clipshare.limits() l);
  v_abandoned timestamptz := now() - interval '2 hours';
  v_steps     int := 0;
  v_chunk     record;
  v_item      record;
begin
  loop
    select c.item_id, c.idx into v_chunk
      from clipshare.items i
      join clipshare.chunks c on c.item_id = i.id
     where i.deleted or i.created_at < v_expired or (not i.complete and i.created_at < v_abandoned)
     limit 1
       for update of c skip locked;
    if found then
      delete from clipshare.chunks c where c.item_id = v_chunk.item_id and c.idx = v_chunk.idx;
    else
      -- No such chunks left: remove an expired item or abandoned upload, or
      -- drop the payload of a deleted item. A deleted item's row stays until
      -- it expires, so that clients which were offline hear about it too.
      select i.id, (i.created_at < v_expired or (not i.complete and i.created_at < v_abandoned)) as gone
        into v_item
        from clipshare.items i
       where (i.created_at < v_expired
              or (not i.complete and i.created_at < v_abandoned)
              or (i.deleted and i.payload <> ''))
         and not exists (select 1 from clipshare.chunks c where c.item_id = i.id)
       limit 1
         for update skip locked;
      exit when not found;
      if v_item.gone then
        delete from clipshare.items i where i.id = v_item.id;
      else
        update clipshare.items i set payload = '', size = 0 where i.id = v_item.id;
      end if;
    end if;
    v_steps := v_steps + 1;
    exit when clock_timestamp() >= v_deadline;
  end loop;
  return v_steps;
end
$$;

-- Replaced by gc(). It freed everything at once, which could take longer
-- than the API allows; the call then failed and so did every later one.
drop function if exists clipshare.cleanup();

-- Evict the oldest finished items until p_size more bytes fit in the quotas.
-- Only live items count; deleted, expired and abandoned ones are on their
-- way out (gc() frees them).
create or replace function clipshare.make_space(p_room text, p_size bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  l           record;
  v_expired   timestamptz;
  v_abandoned timestamptz := now() - interval '2 hours';
  v_used      bigint;
  v_victim    uuid;
  v_room      text;
begin
  select * into l from clipshare.limits();
  v_expired := now() - l.retention;

  loop
    select coalesce(sum(i.size), 0) into v_used
      from clipshare.items i
     where i.room = p_room and not i.deleted and i.created_at >= v_expired
       and (i.complete or i.created_at >= v_abandoned);
    exit when v_used + p_size <= l.room_quota;
    select i.id into v_victim from clipshare.items i
     where i.room = p_room and i.complete and not i.deleted and i.created_at >= v_expired
     order by i.created_at limit 1
       for update skip locked;
    if v_victim is null then
      raise exception 'room storage is full, try again later' using errcode = 'P0001';
    end if;
    perform clipshare.tombstone(v_victim);
  end loop;

  loop
    select coalesce(sum(i.size), 0) into v_used
      from clipshare.items i
     where not i.deleted and i.created_at >= v_expired
       and (i.complete or i.created_at >= v_abandoned);
    exit when v_used + p_size <= l.total_quota;
    select i.id, i.room into v_victim, v_room from clipshare.items i
     where i.complete and not i.deleted and i.created_at >= v_expired
     order by i.created_at limit 1
       for update skip locked;
    if v_victim is null then
      raise exception 'storage is full, try again later' using errcode = 'P0001';
    end if;
    if v_room = p_room then
      perform clipshare.tombstone(v_victim);
    else
      -- Another room: we don't hold its lock, so its sequence numbers must
      -- not change. The item just disappears there, as if it had expired.
      update clipshare.items i set deleted = true where i.id = v_victim;
    end if;
  end loop;
end
$$;

-- ----------------------------------------------------------------------------
-- Public API (called by the web app)
-- ----------------------------------------------------------------------------

-- p_after < 0 (default): snapshot of the newest p_limit visible items.
-- p_after >= 0: every item changed after sequence number p_after, oldest
-- first, including deletions (deleted = true). Clients load a snapshot once,
-- then keep asking for changes after the highest seq they have seen.
-- Expired items are left out even before gc() has removed them.
create or replace function public.clip_list(p_room text, p_after bigint default -1, p_limit int default 200)
returns jsonb
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_limit   int := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_expired timestamptz := now() - (select l.retention from clipshare.limits() l);
  v_result  jsonb;
begin
  perform clipshare.check_room(p_room);
  if p_after is null or p_after < 0 then
    select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]'::jsonb) into v_result
      from (select i.id, i.seq, i.created_at, i.sender, i.kind, i.payload, i.size, i.chunks, i.deleted
              from clipshare.items i
             where i.room = p_room and i.seq is not null and i.complete and not i.deleted
               and i.created_at >= v_expired
             order by i.seq desc
             limit v_limit) t;
  else
    -- A deleted item keeps its data until gc() frees it; never send it.
    select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]'::jsonb) into v_result
      from (select i.id, i.seq, i.created_at, i.sender, i.kind,
                   case when i.deleted then '' else i.payload end as payload,
                   case when i.deleted then 0 else i.size end as size,
                   i.chunks, i.deleted
              from clipshare.items i
             where i.room = p_room and i.seq is not null and i.seq > p_after
               and i.created_at >= v_expired
             order by i.seq
             limit v_limit) t;
  end if;
  return v_result;
end
$$;

-- Add a text item. Returns {id, seq, created_at}.
create or replace function public.clip_push(p_room text, p_sender text, p_payload text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max int;
  v_row record;
begin
  perform clipshare.check_room(p_room);
  select l.max_text into v_max from clipshare.limits() l;
  if p_payload is null or length(p_payload) = 0 or length(p_payload) > v_max then
    raise exception 'text is too large' using errcode = '22001';
  end if;
  perform clipshare.gc(interval '0.5 seconds');
  perform clipshare.lock_room(p_room);
  perform clipshare.make_space(p_room, length(p_payload));
  insert into clipshare.items (room, seq, sender, kind, payload, size, complete)
  values (p_room, nextval('clipshare.seq'), left(coalesce(p_sender, ''), 64), 'text', p_payload, length(p_payload), true)
  returning id, seq, created_at into v_row;
  return jsonb_build_object('id', v_row.id, 'seq', v_row.seq, 'created_at', v_row.created_at);
end
$$;

-- Start a file upload. p_size = plaintext bytes, p_chunks = number of chunks.
create or replace function public.clip_file_begin(p_room text, p_sender text, p_payload text, p_size bigint, p_chunks int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  l    record;
  v_id uuid;
begin
  perform clipshare.check_room(p_room);
  select * into l from clipshare.limits();
  if p_payload is null or length(p_payload) = 0 or length(p_payload) > 65536 then
    raise exception 'invalid file metadata' using errcode = '22023';
  end if;
  if p_size is null or p_size < 0 or p_size > l.max_file then
    raise exception 'file is too large (max % MB)', l.max_file / 1024 / 1024 using errcode = '22001';
  end if;
  if p_chunks is null or p_chunks < 1 or p_chunks > 100000 then
    raise exception 'invalid chunk count' using errcode = '22023';
  end if;
  perform clipshare.gc(interval '0.5 seconds');
  perform clipshare.lock_room(p_room);
  perform clipshare.make_space(p_room, p_size + p_chunks * 128);
  insert into clipshare.items (room, sender, kind, payload, size, chunks, complete)
  values (p_room, left(coalesce(p_sender, ''), 64), 'blob', p_payload, p_size + p_chunks * 128, p_chunks, false)
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end
$$;

-- Upload one encrypted chunk (base64).
create or replace function public.clip_file_chunk(p_room text, p_id uuid, p_idx int, p_data text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chunk_max int;
  v_item      record;
  v_bytes     bytea;
  v_stored    bigint;
begin
  perform clipshare.check_room(p_room);
  select l.chunk_max into v_chunk_max from clipshare.limits() l;
  -- Keep freeing space while files arrive (before taking the row lock, so
  -- that chunks sent in parallel do this at the same time).
  perform clipshare.gc(interval '0.1 seconds');
  -- The row lock makes chunk uploads of one file take turns, so the size
  -- check below also holds for chunks sent in parallel.
  select i.chunks, i.complete, i.deleted, i.size, i.created_at into v_item
    from clipshare.items i where i.id = p_id and i.room = p_room
    for update;
  if not found or v_item.deleted then
    raise exception 'upload not found' using errcode = 'P0001';
  end if;
  if v_item.complete then
    raise exception 'upload already finished' using errcode = '22023';
  end if;
  if v_item.created_at < now() - interval '2 hours' then
    raise exception 'upload not found' using errcode = 'P0001';  -- abandoned; gc() frees it
  end if;
  if p_idx is null or p_idx < 0 or p_idx >= v_item.chunks then
    raise exception 'invalid chunk index' using errcode = '22023';
  end if;
  v_bytes := decode(p_data, 'base64');
  if length(v_bytes) = 0 or length(v_bytes) > v_chunk_max then
    raise exception 'invalid chunk size' using errcode = '22001';
  end if;
  -- Never store more than clip_file_begin reserved in the quotas.
  select coalesce(sum(length(c.data)), 0) into v_stored
    from clipshare.chunks c where c.item_id = p_id and c.idx <> p_idx;
  if v_stored + length(v_bytes) > v_item.size then
    raise exception 'upload is larger than announced' using errcode = '22001';
  end if;
  insert into clipshare.chunks (item_id, idx, data) values (p_id, p_idx, v_bytes)
  on conflict (item_id, idx) do update set data = excluded.data;
  return jsonb_build_object('ok', true);
end
$$;

-- Finish an upload; the item becomes visible to the room.
create or replace function public.clip_file_finish(p_room text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item  record;
  v_count int;
  v_size  bigint;
  v_seq   bigint;
  v_now   timestamptz := now();
begin
  perform clipshare.check_room(p_room);
  perform clipshare.lock_room(p_room);
  select i.chunks, i.complete, i.deleted, i.seq, i.created_at into v_item
    from clipshare.items i where i.id = p_id and i.room = p_room
    for update;
  if not found or v_item.deleted then
    raise exception 'upload not found' using errcode = 'P0001';
  end if;
  if v_item.complete then
    return jsonb_build_object('id', p_id, 'seq', v_item.seq, 'created_at', v_item.created_at);
  end if;
  if v_item.created_at < now() - interval '2 hours' then
    raise exception 'upload not found' using errcode = 'P0001';  -- abandoned; gc() frees it
  end if;
  select count(*), coalesce(sum(length(c.data)), 0) into v_count, v_size
    from clipshare.chunks c where c.item_id = p_id;
  if v_count <> v_item.chunks then
    raise exception 'upload incomplete (% of % chunks)', v_count, v_item.chunks using errcode = '22023';
  end if;
  v_seq := nextval('clipshare.seq');
  update clipshare.items i
     set complete = true, size = v_size, seq = v_seq, created_at = v_now
   where i.id = p_id;
  return jsonb_build_object('id', p_id, 'seq', v_seq, 'created_at', v_now);
end
$$;

-- Download one encrypted chunk (returns base64 text).
create or replace function public.clip_file_get(p_room text, p_id uuid, p_idx int)
returns text
language plpgsql stable
security definer
set search_path = ''
as $$
declare
  v_data bytea;
begin
  perform clipshare.check_room(p_room);
  select c.data into v_data
    from clipshare.chunks c
    join clipshare.items i on i.id = c.item_id
   where c.item_id = p_id and c.idx = p_idx and i.room = p_room and i.complete and not i.deleted
     and i.created_at >= now() - (select l.retention from clipshare.limits() l);
  if not found then
    raise exception 'file not found (it may have expired)' using errcode = 'P0001';
  end if;
  return translate(encode(v_data, 'base64'), E'\n', '');
end
$$;

-- Delete one item for everyone in the room.
create or replace function public.clip_delete(p_room text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform clipshare.check_room(p_room);
  perform clipshare.gc(interval '0.5 seconds');
  perform clipshare.lock_room(p_room);
  -- Expired items and abandoned uploads are already gone (gc() removes them).
  if not exists (select 1 from clipshare.items i
                  where i.id = p_id and i.room = p_room and not i.deleted
                    and i.created_at >= now() - (select l.retention from clipshare.limits() l)
                    and (i.complete or i.created_at >= now() - interval '2 hours')) then
    return jsonb_build_object('ok', false);
  end if;
  perform clipshare.tombstone(p_id);
  return jsonb_build_object('ok', true);
end
$$;

-- Delete everything in the room.
create or replace function public.clip_clear(p_room text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_n  int := 0;
begin
  perform clipshare.check_room(p_room);
  perform clipshare.gc(interval '0.5 seconds');
  perform clipshare.lock_room(p_room);
  -- Expired items and abandoned uploads are already gone as far as clients
  -- are concerned (gc() removes them).
  for v_id in select i.id from clipshare.items i
               where i.room = p_room and not i.deleted
                 and i.created_at >= now() - (select l.retention from clipshare.limits() l)
                 and (i.complete or i.created_at >= now() - interval '2 hours') loop
    perform clipshare.tombstone(v_id);
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('cleared', v_n);
end
$$;

-- ----------------------------------------------------------------------------
-- Permissions: only the clip_* functions are callable through the API.
-- ----------------------------------------------------------------------------
revoke all on all functions in schema clipshare from public, anon, authenticated;

revoke all on function public.clip_list(text, bigint, int)                 from public, anon, authenticated;
revoke all on function public.clip_push(text, text, text)                  from public, anon, authenticated;
revoke all on function public.clip_file_begin(text, text, text, bigint, int) from public, anon, authenticated;
revoke all on function public.clip_file_chunk(text, uuid, int, text)       from public, anon, authenticated;
revoke all on function public.clip_file_finish(text, uuid)                 from public, anon, authenticated;
revoke all on function public.clip_file_get(text, uuid, int)               from public, anon, authenticated;
revoke all on function public.clip_delete(text, uuid)                      from public, anon, authenticated;
revoke all on function public.clip_clear(text)                             from public, anon, authenticated;

grant execute on function public.clip_list(text, bigint, int)                 to anon, authenticated;
grant execute on function public.clip_push(text, text, text)                  to anon, authenticated;
grant execute on function public.clip_file_begin(text, text, text, bigint, int) to anon, authenticated;
grant execute on function public.clip_file_chunk(text, uuid, int, text)       to anon, authenticated;
grant execute on function public.clip_file_finish(text, uuid)                 to anon, authenticated;
grant execute on function public.clip_file_get(text, uuid, int)               to anon, authenticated;
grant execute on function public.clip_delete(text, uuid)                      to anon, authenticated;
grant execute on function public.clip_clear(text)                             to anon, authenticated;

-- Make the API pick up the new functions immediately.
notify pgrst, 'reload schema';

-- Free space that is waiting to be freed, for a few seconds at most (the app
-- frees the rest bit by bit as it is used).
select 'PastePort backend installed' as status, clipshare.gc(interval '3 seconds') as cleanup_steps;
