/*
 * Tests supabase/setup.sql on a real PostgreSQL engine (PGlite), calling the
 * functions the way Supabase's API (PostgREST) does.
 *
 * Run: node sql-test.js
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { openDb, install, Rest } = require('./pg');

const room = () => crypto.randomBytes(32).toString('hex');
const b64 = (buf) => buf.toString('base64');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MB = 1024 * 1024;

async function main() {
  const started = Date.now();
  const db = await openDb();
  const version = (await db.query('select version() as v')).rows[0].v.split(' on ')[0];
  console.log(version + ' ready in ' + (Date.now() - started) + ' ms');
  const rest = new Rest(db);
  const results = [];

  async function test(name, fn) {
    const t = Date.now();
    try {
      await fn();
      results.push(true);
      console.log('  PASS  ' + name + ' (' + (Date.now() - t) + ' ms)');
    } catch (e) {
      results.push(false);
      console.log('  FAIL  ' + name + '\n        ' + String((e && e.stack) || e).split('\n').slice(0, 8).join('\n        '));
    }
  }

  async function rpc(fn, args) {
    const r = await rest.call(fn, args);
    if (r.status !== 200) throw new Error(fn + ' failed: ' + r.status + ' ' + JSON.stringify(r.body));
    return r.body;
  }
  async function rpcErr(fn, args, status, code, message) {
    const r = await rest.call(fn, args);
    assert.strictEqual(r.status, status, fn + ': expected HTTP ' + status + ', got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.code, code, fn + ': ' + JSON.stringify(r.body));
    if (message) assert.match(r.body.message, message);
    return r.body;
  }
  async function value(sql, params) {
    return (await db.query(sql, params)).rows[0].v;
  }
  async function sqlError(fn) {
    try {
      await db.transaction(fn);
    } catch (e) {
      return e;
    }
    throw new Error('expected an SQL error');
  }
  async function uploadFile(r, parts, announced) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const { id } = await rpc('clip_file_begin', {
      p_room: r, p_sender: 'dev', p_payload: 'meta', p_size: announced == null ? total : announced, p_chunks: parts.length,
    });
    for (let i = 0; i < parts.length; i++) await rpc('clip_file_chunk', { p_room: r, p_id: id, p_idx: i, p_data: b64(parts[i]) });
    return rpc('clip_file_finish', { p_room: r, p_id: id });
  }
  const ids = (rows) => rows.map((r) => r.id);
  const changes = (rows) => rows.map((r) => [r.id, r.deleted]);
  const chunkCount = (id) => value('select count(*)::int as v from clipshare.chunks where item_id = $1', [id]);
  const itemExists = async (id) => (await value('select count(*)::int as v from clipshare.items where id = $1', [id])) === 1;
  const row = async (id) => (await db.query('select deleted, payload, size::int as size from clipshare.items where id = $1', [id])).rows[0];
  const age = (id, interval) => db.query('update clipshare.items set created_at = now() - $2::interval where id = $1', [id, interval]);
  const gc = (budget) => value('select clipshare.gc($1::interval) as v', [budget]);
  // Stand-in for gc() that frees nothing, as when it has not got to an item yet.
  const NO_GC = `create or replace function clipshare.gc(p_budget interval) returns int
                 language sql set search_path = '' as $$ select 0 $$;`;

  await test('setup.sql installs as a non-superuser owner and can be run again', async () => {
    const r = room();
    const before = await rpc('clip_push', { p_room: r, p_sender: 'dev', p_payload: 'survives a re-run' });
    await install(db);
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: r })), [before.id]);
    const fns = (await db.query(`
      select p.proname as name, p.prosecdef as definer, pg_get_userbyid(p.proowner) as owner, p.provolatile as vol
        from pg_proc p
       where p.pronamespace = 'public'::regnamespace and p.proname like 'clip\\_%'
       order by 1`)).rows;
    assert.deepStrictEqual(fns.map((f) => f.name), [
      'clip_clear', 'clip_delete', 'clip_file_begin', 'clip_file_chunk', 'clip_file_finish', 'clip_file_get', 'clip_list', 'clip_push',
    ]);
    for (const f of fns) {
      assert.strictEqual(f.definer, true, f.name + ' should be security definer');
      assert.strictEqual(f.owner, 'app_owner', f.name);
    }
    assert.deepStrictEqual(fns.filter((f) => f.vol !== 'v').map((f) => f.name), ['clip_file_get', 'clip_list']);
    const tables = (await db.query(`select tablename, tableowner, rowsecurity from pg_tables where schemaname = 'clipshare' order by 1`)).rows;
    assert.deepStrictEqual(tables, [
      { tablename: 'chunks', tableowner: 'app_owner', rowsecurity: true },
      { tablename: 'items', tableowner: 'app_owner', rowsecurity: true },
    ]);
  });

  await test('the API roles can only call the clip_* functions', async () => {
    const api = [
      'clip_list(text,bigint,integer)', 'clip_push(text,text,text)', 'clip_file_begin(text,text,text,bigint,integer)',
      'clip_file_chunk(text,uuid,integer,text)', 'clip_file_finish(text,uuid)', 'clip_file_get(text,uuid,integer)',
      'clip_delete(text,uuid)', 'clip_clear(text)',
    ];
    const internal = [
      'limits()', 'check_room(text)', 'lock_room(text)', 'tombstone(uuid)', 'gc(interval)', 'make_space(text,bigint)',
    ];
    await db.exec('create role nobody nologin');
    const can = (sql) => value('select ' + sql + ' as v');
    for (const role of ['anon', 'authenticated']) {
      for (const f of api) assert.strictEqual(await can(`has_function_privilege('${role}', 'public.${f}', 'execute')`), true, role + ' ' + f);
      for (const f of internal) assert.strictEqual(await can(`has_function_privilege('${role}', 'clipshare.${f}', 'execute')`), false, role + ' ' + f);
      assert.strictEqual(await can(`has_schema_privilege('${role}', 'clipshare', 'usage')`), false);
      for (const t of ['clipshare.items', 'clipshare.chunks']) {
        assert.strictEqual(await can(`has_table_privilege('${role}', '${t}', 'select,insert,update,delete,truncate')`), false, role + ' ' + t);
      }
      assert.strictEqual(await can(`has_sequence_privilege('${role}', 'clipshare.seq', 'usage,select,update')`), false);
    }
    for (const f of api) assert.strictEqual(await can(`has_function_privilege('nobody', 'public.${f}', 'execute')`), false, 'PUBLIC ' + f);

    const asRole = (role, sql) => sqlError(async (tx) => { await tx.exec('set local role ' + role); await tx.query(sql); });
    assert.strictEqual((await asRole('anon', 'select count(*) from clipshare.items')).code, '42501');
    assert.strictEqual((await asRole('anon', `select clipshare.gc('1 hour')`)).code, '42501');
    assert.strictEqual((await asRole('nobody', `select public.clip_list('${room()}')`)).code, '42501');
    assert.strictEqual((await rest.call('gc', { p_budget: '1 hour' })).status, 404, 'only the public schema is exposed');
  });

  await test('PostgREST runs the readers read-only; writers would fail there', async () => {
    const e = await sqlError(async (tx) => {
      await tx.exec('set transaction read only');
      await tx.exec('set local role anon');
      await tx.query(`select public.clip_push('${room()}', 'dev', 'x')`);
    });
    assert.strictEqual(e.code, '25006');
    // clip_list and clip_file_get run read-only in every other test.
  });

  await test('text: push, snapshot, and changes after a sequence number', async () => {
    const A = room();
    const B = room();
    const p1 = await rpc('clip_push', { p_room: A, p_sender: 'dev-1', p_payload: 'payload-1' });
    assert.deepStrictEqual(Object.keys(p1).sort(), ['created_at', 'id', 'seq']);
    assert.match(p1.id, UUID_RE);
    assert.ok(Number.isSafeInteger(p1.seq) && p1.seq > 0);
    assert.ok(Math.abs(Date.parse(p1.created_at) - Date.now()) < 60000, p1.created_at);
    const p2 = await rpc('clip_push', { p_room: A, p_sender: 'x'.repeat(100), p_payload: 'payload-2' });
    const p3 = await rpc('clip_push', { p_room: B, p_sender: 'dev-2', p_payload: 'payload-3' });
    assert.ok(p1.seq < p2.seq && p2.seq < p3.seq);

    const snap = await rpc('clip_list', { p_room: A });
    assert.deepStrictEqual(ids(snap), [p1.id, p2.id]);
    assert.deepStrictEqual(snap[0], {
      id: p1.id, seq: p1.seq, created_at: p1.created_at, sender: 'dev-1', kind: 'text',
      payload: 'payload-1', size: 9, chunks: 0, deleted: false,
    });
    assert.strictEqual(snap[1].sender, 'x'.repeat(64));
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: A, p_after: -1, p_limit: 1 })), [p2.id], 'snapshot keeps the newest');
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: A, p_limit: 0 })), [p2.id], 'limit is at least 1');
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: A, p_after: p1.seq })), [p2.id]);
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: A, p_after: 0, p_limit: 1 })), [p1.id], 'changes come oldest first');
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: A, p_after: p2.seq })), []);
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: B })), [p3.id]);
    assert.deepStrictEqual(await rpc('clip_list', { p_room: room() }), []);
  });

  await test('bad input is refused with the expected error codes', async () => {
    const A = room();
    await rpcErr('clip_push', { p_room: 'abc', p_sender: '', p_payload: 'x' }, 400, '22023', /invalid room id/);
    await rpcErr('clip_push', { p_room: 'A'.repeat(64), p_sender: '', p_payload: 'x' }, 400, '22023', /invalid room id/);
    await rpcErr('clip_list', { p_room: null }, 400, '22023', /invalid room id/);
    await rpcErr('clip_push', { p_room: A, p_sender: '', p_payload: '' }, 400, '22001');
    await rpcErr('clip_push', { p_room: A, p_sender: '', p_payload: 'x'.repeat(2 * MB + 1) }, 400, '22001', /text is too large/);
    await rpc('clip_push', { p_room: A, p_sender: '', p_payload: 'x'.repeat(2 * MB) });
    await rpcErr('clip_push', { p_room: A, p_payload: 'x' }, 404, 'PGRST202');
    await rpcErr('clip_list', { p_room: A, p_bogus: 1 }, 404, 'PGRST202');
    await rpcErr('clip_delete', { p_room: A, p_id: 'not-a-uuid' }, 400, '22P02');
    const meta = { p_room: A, p_sender: '', p_payload: 'meta' };
    await rpcErr('clip_file_begin', Object.assign({}, meta, { p_size: 50 * MB + 1, p_chunks: 51 }), 400, '22001', /file is too large \(max 50 MB\)/);
    await rpcErr('clip_file_begin', Object.assign({}, meta, { p_size: -1, p_chunks: 1 }), 400, '22001');
    await rpcErr('clip_file_begin', Object.assign({}, meta, { p_size: 10, p_chunks: 0 }), 400, '22023', /invalid chunk count/);
    await rpcErr('clip_file_begin', Object.assign({}, meta, { p_payload: '', p_size: 10, p_chunks: 1 }), 400, '22023', /invalid file metadata/);
    await rpcErr('clip_file_chunk', { p_room: A, p_id: crypto.randomUUID(), p_idx: 0, p_data: 'AAAA' }, 400, 'P0001', /upload not found/);
    await rpcErr('clip_file_finish', { p_room: A, p_id: crypto.randomUUID() }, 400, 'P0001', /upload not found/);
    await rpcErr('clip_file_get', { p_room: A, p_id: crypto.randomUUID(), p_idx: 0 }, 400, 'P0001', /file not found/);
  });

  await test('files: begin, chunks (with a retry), finish, download', async () => {
    const A = room();
    const c0 = crypto.randomBytes(1600);
    const c1 = crypto.randomBytes(1464);
    const begin = await rpc('clip_file_begin', { p_room: A, p_sender: 'dev-1', p_payload: 'meta', p_size: 3000, p_chunks: 2 });
    assert.deepStrictEqual(Object.keys(begin), ['id']);
    const id = begin.id;
    assert.deepStrictEqual(await rpc('clip_list', { p_room: A }), [], 'unfinished uploads are hidden');
    assert.deepStrictEqual(await rpc('clip_list', { p_room: A, p_after: 0 }), []);
    await rpcErr('clip_file_chunk', { p_room: A, p_id: id, p_idx: 2, p_data: b64(c0) }, 400, '22023', /invalid chunk index/);
    await rpcErr('clip_file_chunk', { p_room: A, p_id: id, p_idx: -1, p_data: b64(c0) }, 400, '22023', /invalid chunk index/);
    await rpcErr('clip_file_chunk', { p_room: A, p_id: id, p_idx: 0, p_data: '' }, 400, '22001', /invalid chunk size/);
    await rpcErr('clip_file_chunk', { p_room: room(), p_id: id, p_idx: 0, p_data: b64(c0) }, 400, 'P0001', /upload not found/);
    assert.deepStrictEqual(await rpc('clip_file_chunk', { p_room: A, p_id: id, p_idx: 0, p_data: b64(c0) }), { ok: true });
    await rpcErr('clip_file_finish', { p_room: A, p_id: id }, 400, '22023', /upload incomplete \(1 of 2 chunks\)/);
    await rpc('clip_file_chunk', { p_room: A, p_id: id, p_idx: 1, p_data: b64(crypto.randomBytes(100)) });
    await rpc('clip_file_chunk', { p_room: A, p_id: id, p_idx: 1, p_data: b64(c1) });
    await rpcErr('clip_file_get', { p_room: A, p_id: id, p_idx: 0 }, 400, 'P0001', /file not found/);

    const fin = await rpc('clip_file_finish', { p_room: A, p_id: id });
    assert.strictEqual(fin.id, id);
    assert.ok(Number.isSafeInteger(fin.seq));
    assert.deepStrictEqual(await rpc('clip_file_finish', { p_room: A, p_id: id }), fin, 'finishing twice is harmless');
    assert.deepStrictEqual(await rpc('clip_list', { p_room: A }), [{
      id, seq: fin.seq, created_at: fin.created_at, sender: 'dev-1', kind: 'blob', payload: 'meta', size: 3064, chunks: 2, deleted: false,
    }]);
    assert.strictEqual(await rpc('clip_file_get', { p_room: A, p_id: id, p_idx: 0 }), b64(c0));
    assert.strictEqual(await rpc('clip_file_get', { p_room: A, p_id: id, p_idx: 1 }), b64(c1));
    await rpcErr('clip_file_get', { p_room: A, p_id: id, p_idx: 2 }, 400, 'P0001');
    await rpcErr('clip_file_get', { p_room: room(), p_id: id, p_idx: 0 }, 400, 'P0001');
    await rpcErr('clip_file_chunk', { p_room: A, p_id: id, p_idx: 0, p_data: b64(c0) }, 400, '22023', /already finished/);
  });

  await test('a full-size encrypted chunk (1 MB + 65 bytes) fits; larger ones are refused', async () => {
    const A = room();
    const enc = crypto.randomBytes(MB + 65);
    const fin = await uploadFile(A, [enc], MB);
    assert.strictEqual(await rpc('clip_file_get', { p_room: A, p_id: fin.id, p_idx: 0 }), b64(enc));
    const { id } = await rpc('clip_file_begin', { p_room: A, p_sender: '', p_payload: 'm', p_size: 2 * MB, p_chunks: 1 });
    await rpcErr('clip_file_chunk', { p_room: A, p_id: id, p_idx: 0, p_data: b64(Buffer.alloc(MB + 4097)) }, 400, '22001', /invalid chunk size/);
  });

  await test('an upload cannot store more than it announced', async () => {
    const A = room();
    const { id } = await rpc('clip_file_begin', { p_room: A, p_sender: '', p_payload: 'm', p_size: 100, p_chunks: 2 });
    // reserved: 100 bytes + 128 per chunk = 356
    await rpc('clip_file_chunk', { p_room: A, p_id: id, p_idx: 0, p_data: b64(Buffer.alloc(300, 1)) });
    await rpcErr('clip_file_chunk', { p_room: A, p_id: id, p_idx: 1, p_data: b64(Buffer.alloc(57, 1)) }, 400, '22001', /larger than announced/);
    await rpc('clip_file_chunk', { p_room: A, p_id: id, p_idx: 1, p_data: b64(Buffer.alloc(56, 1)) });
    await rpc('clip_file_chunk', { p_room: A, p_id: id, p_idx: 0, p_data: b64(Buffer.alloc(300, 2)) });
    await rpc('clip_file_finish', { p_room: A, p_id: id });
    assert.strictEqual((await rpc('clip_list', { p_room: A }))[0].size, 356);
  });

  await test('delete and clear leave tombstones for the other computer', async () => {
    const A = room();
    const B = room();
    const t1 = await rpc('clip_push', { p_room: A, p_sender: 'a', p_payload: 'one' });
    const t2 = await rpc('clip_push', { p_room: A, p_sender: 'a', p_payload: 'two' });
    const f = await uploadFile(A, [crypto.randomBytes(500)]);
    const tb = await rpc('clip_push', { p_room: B, p_sender: 'b', p_payload: 'other room' });
    const cursor = f.seq;

    assert.deepStrictEqual(await rpc('clip_delete', { p_room: B, p_id: t1.id }), { ok: false }, 'wrong room');
    assert.deepStrictEqual(await rpc('clip_delete', { p_room: A, p_id: t1.id }), { ok: true });
    assert.deepStrictEqual(await rpc('clip_delete', { p_room: A, p_id: t1.id }), { ok: false }, 'already deleted');
    const after = await rpc('clip_list', { p_room: A, p_after: cursor });
    assert.strictEqual(after.length, 1);
    assert.deepStrictEqual(
      { id: after[0].id, deleted: after[0].deleted, payload: after[0].payload, size: after[0].size },
      { id: t1.id, deleted: true, payload: '', size: 0 });
    assert.ok(after[0].seq > tb.seq, 'a tombstone gets a new sequence number');
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: A })), [t2.id, f.id]);

    assert.strictEqual(await chunkCount(f.id), 1);
    await rpc('clip_delete', { p_room: A, p_id: f.id });
    await rpcErr('clip_file_get', { p_room: A, p_id: f.id, p_idx: 0 }, 400, 'P0001');

    assert.deepStrictEqual(await rpc('clip_clear', { p_room: A }), { cleared: 1 });
    assert.strictEqual(await chunkCount(f.id), 0, 'the next write call frees a deleted file');
    assert.deepStrictEqual(await rpc('clip_list', { p_room: A }), []);
    assert.deepStrictEqual(changes(await rpc('clip_list', { p_room: A, p_after: cursor })), [[t1.id, true], [f.id, true], [t2.id, true]]);
    assert.deepStrictEqual(await rpc('clip_clear', { p_room: A }), { cleared: 0 });
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: B })), [tb.id], 'other rooms are untouched');
  });

  // Small limits so the quota code can be exercised.
  await install(db, `
    create or replace function clipshare.limits(
      out retention interval, out max_text int, out max_file bigint,
      out chunk_max int, out room_quota bigint, out total_quota bigint)
    language sql immutable set search_path = '' as
    $$ select interval '72 hours', 1000, 5000::bigint, 2000, 3000::bigint, 5000::bigint $$;`);
  const txt = (n) => 'x'.repeat(n);

  await test('room quota: the oldest finished item in the room makes way, with a tombstone', async () => {
    await rest.reset();
    const C = room();
    const c1 = await rpc('clip_push', { p_room: C, p_sender: '', p_payload: txt(800) });
    const c2 = await rpc('clip_push', { p_room: C, p_sender: '', p_payload: txt(800) });
    const cf = await uploadFile(C, [Buffer.alloc(1000, 7)]);
    const c3 = await rpc('clip_push', { p_room: C, p_sender: '', p_payload: txt(800) });
    assert.deepStrictEqual(changes(await rpc('clip_list', { p_room: C, p_after: cf.seq })), [[c1.id, true], [c3.id, false]]);
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: C })), [c2.id, cf.id, c3.id]);
    await rpcErr('clip_push', { p_room: C, p_sender: '', p_payload: txt(1001) }, 400, '22001', /text is too large/);
  });

  await test('total quota: other rooms silently lose their oldest item; the own room gets a tombstone', async () => {
    await rest.reset();
    const C = room();
    const D = room();
    const F = room();
    const cf = await uploadFile(C, [Buffer.alloc(900, 1)]);
    const c2 = await rpc('clip_push', { p_room: C, p_sender: '', p_payload: txt(900) });
    const d = [];
    for (let i = 0; i < 3; i++) d.push(await rpc('clip_push', { p_room: D, p_sender: '', p_payload: txt(1000) }));
    // 4800 bytes in use (no room above its 3000); 1000 more exceed the 5000 total
    const f1 = await rpc('clip_push', { p_room: F, p_sender: '', p_payload: txt(1000) });
    assert.deepStrictEqual(await row(cf.id), { deleted: true, payload: 'meta', size: 900 }, 'file in the other room was hidden');
    assert.deepStrictEqual(await rpc('clip_list', { p_room: C, p_after: c2.seq }), [], 'no tombstone written into a room we do not hold');
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: C })), [c2.id]);
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: D })), ids(d));
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: F })), [f1.id]);
    // Now the oldest item overall (c2) is in the room being written to.
    const c3 = await rpc('clip_push', { p_room: C, p_sender: '', p_payload: txt(900) });
    assert.deepStrictEqual(changes(await rpc('clip_list', { p_room: C, p_after: c2.seq })), [[c2.id, true], [c3.id, false]]);
    assert.strictEqual(await chunkCount(cf.id), 0, 'the next write call freed the hidden file');
    assert.deepStrictEqual(await row(cf.id), { deleted: true, payload: '', size: 0 });
  });

  await test('a full room keeps uploads in progress and refuses new items', async () => {
    await rest.reset();
    const E = room();
    const { id } = await rpc('clip_file_begin', { p_room: E, p_sender: '', p_payload: 'm', p_size: 2000, p_chunks: 1 });
    await rpcErr('clip_push', { p_room: E, p_sender: '', p_payload: txt(900) }, 400, 'P0001', /room storage is full/);
    await rpcErr('clip_file_begin', { p_room: E, p_sender: '', p_payload: 'm', p_size: 5000, p_chunks: 1 }, 400, 'P0001', /room storage is full/);
    await rpcErr('clip_file_chunk', { p_room: E, p_id: id, p_idx: 0, p_data: b64(Buffer.alloc(2001)) }, 400, '22001', /invalid chunk size/);
    await rpc('clip_file_chunk', { p_room: E, p_id: id, p_idx: 0, p_data: b64(Buffer.alloc(2000)) });
    await rpc('clip_file_finish', { p_room: E, p_id: id });
    await rpc('clip_push', { p_room: E, p_sender: '', p_payload: txt(900) });
    await rpcErr('clip_file_begin', { p_room: E, p_sender: '', p_payload: 'm', p_size: 5001, p_chunks: 1 }, 400, '22001', /file is too large/);
  });

  await test('quotas count only live items, so space gc() has yet to free never blocks or evicts', async () => {
    await rest.reset();
    await install(db, NO_GC);
    const Q = room();
    const R = room();
    const S = room();
    const q = [];
    for (let i = 0; i < 3; i++) q.push(await rpc('clip_push', { p_room: Q, p_sender: '', p_payload: txt(1000) }));
    const abandoned = await rpc('clip_file_begin', { p_room: R, p_sender: '', p_payload: 'm', p_size: 1800, p_chunks: 1 });
    await rpc('clip_delete', { p_room: Q, p_id: q[0].id });
    await age(q[1].id, '73 hours');
    await age(abandoned.id, '3 hours');
    // Q holds 3000 bytes and R 1928, but only q[2] (1000) is still live.
    await rpc('clip_file_begin', { p_room: Q, p_sender: '', p_payload: 'm', p_size: 1800, p_chunks: 1 });
    await rpc('clip_push', { p_room: S, p_sender: '', p_payload: txt(1000) });
    await rpc('clip_push', { p_room: S, p_sender: '', p_payload: txt(1000) });
    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: Q })), [q[2].id], 'nothing live was evicted');
    assert.deepStrictEqual(await row(q[0].id), { deleted: true, payload: txt(1000), size: 1000 }, 'not freed yet');
    assert.strictEqual(await itemExists(q[1].id), true, 'not freed yet');
  });

  await install(db);

  await test('re-running setup.sql restores the normal limits', async () => {
    const l = (await db.query(`select retention::text as retention, max_text, max_file::text as max_file, chunk_max,
                                      room_quota::text as room_quota, total_quota::text as total_quota from clipshare.limits()`)).rows[0];
    assert.deepStrictEqual(l, {
      retention: '72:00:00', max_text: 2 * MB, max_file: String(50 * MB), chunk_max: MB + 4096,
      room_quota: String(250 * MB), total_quota: String(380 * MB),
    });
  });

  await test('any write call frees expired items and abandoned uploads, not slow ones', async () => {
    await rest.reset();
    const G = room();
    const old = await rpc('clip_push', { p_room: G, p_sender: '', p_payload: 'old' });
    const keep = await rpc('clip_push', { p_room: G, p_sender: '', p_payload: 'keep' });
    const oldFile = await uploadFile(G, [Buffer.alloc(10, 1)]);
    const abandoned = await rpc('clip_file_begin', { p_room: G, p_sender: '', p_payload: 'm', p_size: 20, p_chunks: 2 });
    await rpc('clip_file_chunk', { p_room: G, p_id: abandoned.id, p_idx: 0, p_data: b64(Buffer.alloc(10, 1)) });
    const slow = await rpc('clip_file_begin', { p_room: G, p_sender: '', p_payload: 'm', p_size: 10, p_chunks: 1 });
    await age(old.id, '73 hours');
    await age(oldFile.id, '73 hours');
    await age(abandoned.id, '3 hours');
    await age(slow.id, '1 hour');
    await rpc('clip_push', { p_room: room(), p_sender: '', p_payload: 'any push runs gc()' });
    const left = (await db.query('select id from clipshare.items where room = $1 order by id', [G])).rows.map((r) => r.id);
    assert.deepStrictEqual(left, [keep.id, slow.id].sort());
    assert.strictEqual(await chunkCount(oldFile.id), 0);
    assert.strictEqual(await chunkCount(abandoned.id), 0);
    await rpc('clip_file_chunk', { p_room: G, p_id: slow.id, p_idx: 0, p_data: b64(Buffer.alloc(10, 1)) });
    await rpc('clip_file_finish', { p_room: G, p_id: slow.id });
  });

  await test('deleting is quick; gc() frees the data later, one step at a time', async () => {
    await rest.reset();
    const A = room();
    const t = await rpc('clip_push', { p_room: A, p_sender: '', p_payload: 'text' });
    const f = await uploadFile(A, [Buffer.alloc(10, 1), Buffer.alloc(10, 2), Buffer.alloc(10, 3)]);
    assert.deepStrictEqual(await rpc('clip_clear', { p_room: A }), { cleared: 2 });
    // clip_clear ran gc() before deleting, so the data is still there...
    assert.strictEqual(await chunkCount(f.id), 3);
    assert.deepStrictEqual(await row(t.id), { deleted: true, payload: 'text', size: 4 });
    // ...but it is never sent to clients.
    const feed = (await rpc('clip_list', { p_room: A, p_after: 0 })).map((r) => [r.id, r.deleted, r.payload, r.size]);
    assert.deepStrictEqual(feed.sort(), [[t.id, true, '', 0], [f.id, true, '', 0]].sort());
    await rpcErr('clip_file_get', { p_room: A, p_id: f.id, p_idx: 0 }, 400, 'P0001');
    // With no time budget, one step per call: three chunks, then two payloads.
    const steps = [];
    for (let i = 0; i < 6; i++) steps.push([await gc('0'), await chunkCount(f.id)]);
    assert.deepStrictEqual(steps, [[1, 2], [1, 1], [1, 0], [1, 0], [1, 0], [0, 0]]);
    assert.deepStrictEqual(await row(t.id), { deleted: true, payload: '', size: 0 });
    assert.deepStrictEqual(await row(f.id), { deleted: true, payload: '', size: 0 });
    assert.strictEqual((await rpc('clip_list', { p_room: A, p_after: 0 })).length, 2, 'the tombstones stay');
  });

  await test('gc() stops when its time is up and carries on in the next call', async () => {
    await rest.reset();
    const A = room();
    const N = 1000;
    const { id } = await rpc('clip_file_begin', { p_room: A, p_sender: '', p_payload: 'm', p_size: N, p_chunks: N });
    await db.query(`insert into clipshare.chunks (item_id, idx, data) select $1, g, '\\x01'::bytea from generate_series(0, $2::int - 1) g`, [id, N]);
    await rpc('clip_delete', { p_room: A, p_id: id });
    const t = Date.now();
    const first = await gc('5 milliseconds');
    const ms = Date.now() - t;
    assert.ok(first >= 1 && first < N, first + ' steps');
    assert.ok(ms < 1000, ms + ' ms');
    assert.strictEqual(await chunkCount(id), N - first);
    let total = first;
    for (let n = 1; n > 0; total += n) n = await gc('1 second');
    assert.strictEqual(total, N + 1, 'every chunk, then the payload');
    assert.strictEqual(await chunkCount(id), 0);
  });

  await test('expired, abandoned and deleted items are gone for clients before gc() frees them', async () => {
    await rest.reset();
    // An install made by the previous setup.sql: its cleanup() function, and
    // a tombstone the way it left them (data already removed).
    await install(db, `create or replace function clipshare.cleanup() returns void
                       language plpgsql set search_path = '' as $$ begin end $$;`);
    const A = room();
    const B = room();
    const oldTomb = await rpc('clip_push', { p_room: B, p_sender: '', p_payload: 'gone' });
    await db.query(`update clipshare.items set deleted = true, payload = '', size = 0, seq = nextval('clipshare.seq') where id = $1`, [oldTomb.id]);
    await install(db, NO_GC);
    const t = await rpc('clip_push', { p_room: A, p_sender: '', p_payload: 'expired' });
    const f = await uploadFile(A, [Buffer.alloc(10, 1)]);
    const u = await rpc('clip_file_begin', { p_room: A, p_sender: '', p_payload: 'm', p_size: 20, p_chunks: 2 });
    await rpc('clip_file_chunk', { p_room: A, p_id: u.id, p_idx: 0, p_data: b64(Buffer.alloc(10, 1)) });
    const live = await rpc('clip_push', { p_room: A, p_sender: '', p_payload: 'live' });
    const d = await rpc('clip_push', { p_room: A, p_sender: '', p_payload: 'deleted' });
    await rpc('clip_delete', { p_room: A, p_id: d.id });
    await age(t.id, '73 hours');
    await age(f.id, '73 hours');
    await age(u.id, '3 hours');

    assert.deepStrictEqual(ids(await rpc('clip_list', { p_room: A })), [live.id]);
    const feed = await rpc('clip_list', { p_room: A, p_after: 0 });
    assert.deepStrictEqual(feed.map((r) => [r.id, r.deleted, r.payload]), [[live.id, false, 'live'], [d.id, true, '']]);
    await rpcErr('clip_file_get', { p_room: A, p_id: f.id, p_idx: 0 }, 400, 'P0001', /file not found/);
    assert.deepStrictEqual(await rpc('clip_delete', { p_room: A, p_id: t.id }), { ok: false });
    await rpcErr('clip_file_chunk', { p_room: A, p_id: u.id, p_idx: 1, p_data: b64(Buffer.alloc(10, 1)) }, 400, 'P0001', /upload not found/);
    await rpcErr('clip_file_finish', { p_room: A, p_id: u.id }, 400, 'P0001', /upload not found/);
    assert.deepStrictEqual(await rpc('clip_delete', { p_room: A, p_id: u.id }), { ok: false });
    assert.deepStrictEqual(await rpc('clip_clear', { p_room: A }), { cleared: 1 });
    assert.deepStrictEqual([await chunkCount(f.id), await chunkCount(u.id)], [1, 1], 'nothing freed yet');

    // Re-running setup.sql replaces cleanup() and frees the backlog.
    await install(db);
    assert.strictEqual(await value(`select to_regprocedure('clipshare.cleanup()') is null as v`), true);
    for (const x of [t, f, u]) assert.strictEqual(await itemExists(x.id), false);
    assert.strictEqual(await value('select count(*)::int as v from clipshare.chunks'), 0);
    for (const x of [live, d, oldTomb]) assert.deepStrictEqual(await row(x.id), { deleted: true, payload: '', size: 0 });
    assert.strictEqual(await gc('1 second'), 0);
  });

  await db.close();
  const failed = results.filter((ok) => !ok).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
