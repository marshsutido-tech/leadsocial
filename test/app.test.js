'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { openDb } = require('../src/db');
const { createApp } = require('../src/server');

process.env.META_VERIFY_TOKEN = 'verif';
process.env.META_APP_SECRET = 'appsecret';

let server, base, repo, app;
const sent = [];
const messenger = {
  igDm: async (b, to, text) => sent.push({ type: 'igDm', to, text }),
  igPrivateReply: async (b, commentId, text) => sent.push({ type: 'igPrivateReply', to: commentId, text }),
  igCommentReply: async (b, commentId, text) => sent.push({ type: 'igCommentReply', to: commentId, text }),
  waText: async (b, to, text) => {
    if (!b.wa_access_token) throw new Error('Falta el token de WhatsApp');
    sent.push({ type: 'waText', to, text });
  },
};
const ai = { reply: async ({ conversation }) => `IA responde a: ${conversation.at(-1).text}` };

test.before(async () => {
  app = await createApp({ db: openDb(':memory:'), secret: 'test', messenger, ai });
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
const signed = async (body) => {
  const raw = JSON.stringify(body);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'appsecret').update(raw).digest('hex');
  const res = await fetch(base + '/webhooks/meta', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
  await app.locals.drainWebhooks();
  return res;
};
const waMsg = (from, text, name = 'Cliente') => signed({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
  metadata: { phone_number_id: 'WA1' }, contacts: [{ wa_id: from, profile: { name } }],
  messages: [{ from, type: 'text', text: { body: text } }],
} }] }] });

let cookie, biz;

test('registro crea comercio y sesión', async () => {
  const res = await post('/registro', { name: 'Panadería Óscar', email: 'o@x.es', password: 'secreto123', whatsapp: '+34 600 111 222' });
  assert.equal(res.status, 302);
  cookie = res.headers.get('set-cookie').split(';')[0];
  biz = await repo.businessByEmail('o@x.es');
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
  const [lead] = await repo.listLeads(biz.id);
  assert.equal(lead.source, 'instagram');
  assert.equal(lead.campaign, 'reel1');
  const stats = await repo.stats(biz.id);
  assert.equal(stats.visits.instagram, 1);
  assert.equal(stats.leads.instagram, 1);
});

test('formulario valida consentimiento e ignora bots', async () => {
  const bad = await post('/c/panaderia-oscar', { name: 'X', phone: '600111222' });
  assert.equal(bad.status, 400);
  await post('/c/panaderia-oscar', { name: 'Bot', phone: '600111222', consent: '1', website: 'spam' });
  assert.equal((await repo.listLeads(biz.id, { search: 'Bot' })).length, 0);
});

test('seguimiento por WhatsApp marca como contactado', async () => {
  const [lead] = await repo.listLeads(biz.id);
  const res = await get(`/panel/leads/${lead.id}/whatsapp`, cookie);
  assert.equal(res.status, 302);
  const loc = res.headers.get('location');
  assert.ok(loc.startsWith('https://wa.me/34611222333?text='));
  assert.match(decodeURIComponent(loc), /Hola Ana, soy de Panadería Óscar. ¡Gracias por escribirnos!/);
  assert.equal((await repo.leadById(biz.id, lead.id)).status, 'contactado');
});

test('otro comercio no ve leads ajenos', async () => {
  const res = await post('/registro', { name: 'Otra', email: 'b@x.es', password: 'secreto123' });
  const other = res.headers.get('set-cookie').split(';')[0];
  const [lead] = await repo.listLeads(biz.id);
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
    { field: 'comments', value: { id: 'C1', from: { id: 'U7', username: 'lucia' }, text: '¿Precio?' } },
    { field: 'comments', value: { from: { id: 'U8', username: 'pepe' }, text: 'Qué bonito' } },
  ] }] });
  await signed({ object: 'instagram', entry: [{ id: 'IG1', messaging: [{ sender: { id: 'U9' }, message: { text: 'Sigo aquí' } }] }] });
  await signed({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: {
    metadata: { phone_number_id: 'WA1' }, contacts: [{ wa_id: '34622000111', profile: { name: 'Marta' } }],
    messages: [{ from: '34622000111', type: 'text', text: { body: 'Quiero encargar' } }],
  } }] }] });

  const ig = await repo.listLeads(biz.id, { source: 'instagram' });
  assert.equal(ig.filter((l) => l.channel === 'dm').length, 1, 'DM deduplicado');
  assert.ok(ig.some((l) => l.handle === 'lucia'));
  assert.ok(!ig.some((l) => l.handle === 'pepe'), 'comentario sin palabra clave ignorado');
  const [wa] = await repo.listLeads(biz.id, { source: 'whatsapp' });
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

test('comentario con palabra clave: DM privado y respuesta pública', async () => {
  const dm = sent.find((m) => m.type === 'igPrivateReply');
  assert.ok(dm, 'se envió DM privado al comentar «¿Precio?»');
  assert.match(dm.text, /\/c\/panaderia-oscar\?src=instagram&campaign=bot/);
  assert.ok(sent.some((m) => m.type === 'igCommentReply'));
  assert.ok(sent.some((m) => m.type === 'igDm' && /Gracias por escribir a Panadería Óscar/.test(m.text)), 'bienvenida por DM');
});

test('WhatsApp sin token registra el error en la ficha', async () => {
  const [wa] = await repo.listLeads(biz.id, { source: 'whatsapp' });
  const acts = await repo.activities(wa.id);
  assert.ok(acts.some((a) => a.kind === 'error' && /token/.test(a.text)));
});

test('WhatsApp: bienvenida, preguntas de cualificación y cierre', async () => {
  await post('/panel/automatizacion/meta', { ig_account_id: 'IG1', wa_phone_number_id: 'WA1', wa_access_token: 'tok' }, cookie);
  await post('/panel/automatizacion/bot', { bot_questions: '¿Qué buscas?\n¿Para cuándo?', bot_closing: 'Gracias{nombre}, te escribimos pronto.' }, cookie);
  sent.length = 0;
  await waMsg('34600999888', 'Hola', 'Rosa');
  assert.deepEqual(sent.map((m) => m.text), ['¡Hola Rosa! Gracias por escribir a Panadería Óscar. ¿En qué te podemos ayudar?', '¿Qué buscas?']);
  await waMsg('34600999888', 'Una tarta');
  await waMsg('34600999888', 'El sábado');
  assert.deepEqual(sent.slice(2).map((m) => m.text), ['¿Para cuándo?', 'Gracias Rosa, te escribimos pronto.']);
  const lead = (await repo.listLeads(biz.id, { search: 'Rosa' }))[0];
  const answers = (await repo.activities(lead.id)).filter((a) => a.kind === 'respuesta').map((a) => a.text);
  assert.deepEqual(answers.reverse(), ['¿Qué buscas? → Una tarta', '¿Para cuándo? → El sábado']);
});

test('IA responde cuando ninguna regla encaja, solo si está activada', async () => {
  sent.length = 0;
  await waMsg('34600999888', '¿Abrís el domingo?');
  assert.equal(sent.length, 0, 'IA desactivada: no responde');
  await post('/panel/automatizacion/bot', { bot_questions: '', bot_closing: 'x', ai_enabled: '1', ai_info: 'Abrimos L-S' }, cookie);
  await waMsg('34600999888', '¿Y festivos?');
  assert.deepEqual(sent.map((m) => m.text), ['IA responde a: ¿Y festivos?']);
});

test('reglas: crear, pausar y palabra clave en WhatsApp', async () => {
  await post('/panel/automatizacion/reglas', { channel: 'whatsapp', keywords: 'horario', reply: 'Abrimos de 9 a 20h' }, cookie);
  sent.length = 0;
  await waMsg('34600999888', '¿Qué horario tenéis?');
  assert.deepEqual(sent.map((m) => m.text), ['Abrimos de 9 a 20h']);
  const rule = (await repo.listAutomations(biz.id)).find((r) => r.keywords === 'horario');
  assert.equal(rule.hits, 1);
  await post(`/panel/automatizacion/reglas/${rule.id}/activar`, {}, cookie);
  sent.length = 0;
  await waMsg('34600999888', 'horario?');
  assert.deepEqual(sent.map((m) => m.text), ['IA responde a: horario?'], 'regla pausada: contesta la IA');
});

test('simulador conversa sin enviar nada ni contar como lead', async () => {
  const before = (await repo.listLeads(biz.id)).length;
  sent.length = 0;
  await post('/panel/simulador', { canal: 'ig_dm', text: 'Hola, ¿precio?' }, cookie);
  const page = await (await get('/panel/simulador?canal=ig_dm', cookie)).text();
  assert.match(page, /Gracias por escribir a Panadería Óscar/);
  const comment = await (await post('/panel/simulador', { canal: 'ig_comment', text: 'info porfa' }, cookie)).text();
  assert.match(comment, /DM privado automático/);
  assert.equal(sent.length, 0);
  assert.equal((await repo.listLeads(biz.id)).length, before);
  await post('/panel/simulador/reiniciar', { canal: 'ig_dm' }, cookie);
  assert.equal(await repo.simLead(biz.id, 'ig_dm'), undefined);
  assert.equal((await get('/panel/automatizacion', cookie)).status, 200);
});
