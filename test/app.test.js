'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');

process.env.META_VERIFY_TOKEN = 'verif';
process.env.META_APP_SECRET = 'appsecret';

let server, base, repo;

test.before(async () => {
  const app = createApp({ db: openDb(':memory:'), secret: 'test' });
  repo = app.locals.repo;
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const form = (obj) => new URLSearchParams(obj).toString();
const post = (path, body, cookie) => fetch(base + path, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie && { cookie }) },
  body: form(body),
});
const get = (path, cookie) => fetch(base + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
const signed = (body) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(raw).digest('hex');
  return fetch(base + '/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
};

let cookie, biz;

test('registro crea comercio y sesión', async () => {
  const res = await post('/registro', { name: 'Panadería Óscar', email: 'o@x.es', password: 'secreto123', whatsapp: '+34 600 111 222' });
  assert.equal(res.status, 302);
  cookie = res.headers.get('set-cookie').split(';')[0];
  biz = repo.businessByEmail('o@x.es');
  assert.equal(biz.slug, 'panaderia-oscar');
  assert.equal((await get('/panel', cookie)).status, 200);
  assert.equal((await get('/panel')).status, 302, 'sin sesión redirige');
});

test('formulario público capta lead con origen y campaña', async () => {
  const page = await get('/c/panaderia-oscar?src=ig&campaign=reel1');
  assert.equal(page.status, 200);
  const res = await post('/c/panaderia-oscar', { src: 'instagram', campaign: 'reel1', name: 'Ana', phone: '+34 611 222 333', interest: 'Tartas', consent: '1' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Gracias, Ana/);
  const [lead] = repo.listLeads(biz.id);
  assert.equal(lead.source, 'instagram');
  assert.equal(lead.campaign, 'reel1');
  const stats = repo.stats(biz.id);
  assert.equal(stats.visits.instagram, 1);
  assert.equal(stats.leads.instagram, 1);
});

test('formulario valida consentimiento e ignora bots', async () => {
  const bad = await post('/c/panaderia-oscar', { name: 'X', phone: '600111222' });
  assert.equal(bad.status, 400);
  await post('/c/panaderia-oscar', { name: 'Bot', phone: '600111222', consent: '1', website: 'spam' });
  assert.equal(repo.listLeads(biz.id, { search: 'Bot' }).length, 0);
});

test('seguimiento por WhatsApp marca como contactado', async () => {
  const [lead] = repo.listLeads(biz.id);
  const res = await get(`/panel/leads/${lead.id}/whatsapp`, cookie);
  assert.equal(res.status, 302);
  const loc = res.headers.get('location');
  assert.ok(loc.startsWith('https://wa.me/34611222333?text='));
  assert.match(decodeURIComponent(loc), /Hola Ana, soy de Panadería Óscar. ¡Gracias por escribirnos!/);
  assert.equal(repo.leadById(biz.id, lead.id).status, 'contactado');
});

test('otro comercio no ve leads ajenos', async () => {
  const res = await post('/registro', { name: 'Otra', email: 'b@x.es', password: 'secreto123' });
  const other = res.headers.get('set-cookie').split(';')[0];
  const [lead] = repo.listLeads(biz.id);
  assert.equal((await get(`/panel/leads/${lead.id}`, other)).status, 404);
});

test('webhook de Meta: verificación, firma, DMs, comentarios y WhatsApp', async () => {
  const ok = await get('/webhooks/meta?hub.mode=subscribe&hub.verify_token=verif&hub.challenge=42');
  assert.equal(await ok.text(), '42');
  assert.equal((await get('/webhooks/meta?hub.mode=subscribe&hub.verify_token=no&hub.challenge=1')).status, 403);

  await post('/panel/ajustes', { name: 'Panadería Óscar', keywords: 'precio, info', ig_account_id: 'IG1', wa_phone_number_id: 'WA1' }, cookie);

  const unsigned = await fetch(base + '/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unsigned.status, 401);

  await signed({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'U9' }, message: { text: 'Hola!' } }], changes: [
    { field: 'comments', value: { from: { id: 'U7', username: 'lucia' }, text: '¿Precio?' } },
    { field: 'comments', value: { from: { id: 'U8', username: 'pepe' }, text: 'Qué bonito' } },
  ] }] });
  await signed({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'U9' }, message: { text: 'Sigo aquí' } }] }] });
  await signed({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    metadata: { phone_number_id: 'WA1' }, contacts: [{ wa_id: '34622000111', profile: { name: 'Marta' } }],
    messages: [{ from: '34622000111', type: 'text', text: { body: 'Quiero encargar' } }],
  } }] }] });

  const ig = repo.listLeads(biz.id, { source: 'instagram' });
  assert.equal(ig.filter((l) => l.channel === 'dm').length, 1, 'DM deduplicado');
  assert.ok(ig.some((l) => l.handle === 'lucia'));
  assert.ok(!ig.some((l) => l.handle === 'pepe'), 'comentario sin palabra clave ignorado');
  const [wa] = repo.listLeads(biz.id, { source: 'whatsapp' });
  assert.equal(wa.name, 'Marta');
  assert.equal(wa.phone, '+34622000111');
});

test('exporta CSV sin inyección de fórmulas', async () => {
  await post('/panel/leads', { name: '=HYPERLINK("x")', source: 'tiktok' }, cookie);
  const res = await get('/panel/leads.csv', cookie);
  const csv = await res.text();
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
});
