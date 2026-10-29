'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDb, migrate, repo: makeRepo, normalizeSource } = require('./db');
const { hashPassword, verifyPassword, sessions } = require('./auth');
const { mountMetaWebhooks } = require('./integrations');
const { createBot } = require('./bot');
const { createAi } = require('./ai');
const { createMessenger } = require('./meta');
const { fillTemplate } = require('./template');
const v = require('./views');

const FLASH = {
  guardado: 'Cambios guardados.',
  creado: 'Lead añadido.',
  borrado: 'Lead borrado.',
  nota: 'Nota añadida.',
  bienvenida: '¡Cuenta creada! Copia tus enlaces y ponlos en la bio de tus redes.',
  regla: 'Regla guardada.',
  conexion: 'Conexión guardada.',
  reiniciado: 'Conversación de prueba reiniciada.',
};

function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'comercio';
}

/** Limitador muy simple en memoria para el formulario público. */
function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 10000) hits.clear();
    return arr.length <= max;
  };
}

async function createApp({
  db = openDb(), secret = process.env.SESSION_SECRET, ai = createAi(), messenger = createMessenger(),
} = {}) {
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    if (process.env.NODE_ENV === 'production') throw new Error('Falta SESSION_SECRET');
  }
  await migrate(db);
  const repo = makeRepo(db);
  const bot = createBot({ repo, ai });
  const session = sessions(secret);
  const allowLead = rateLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(session.read);

  const baseUrl = (req) => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
  const flash = (req) => FLASH[req.query.ok];
  const trim = (s, n = 500) => String(s ?? '').trim().slice(0, n);

  // ---------- Webhooks ----------
  mountMetaWebhooks(app, repo, { bot, messenger, baseUrl });

  // ---------- Público ----------
  app.get('/', (req, res) => (req.businessId ? res.redirect('/panel') : res.send(v.home())));

  app.get('/c/:slug', async (req, res) => {
    const biz = await repo.businessBySlug(req.params.slug);
    if (!biz) return res.status(404).send(v.notFound('Este comercio no existe'));
    const src = normalizeSource(req.query.src);
    const campaign = trim(req.query.campaign, 60);
    await repo.recordVisit(biz.id, src, campaign);
    res.send(v.publicPage(biz, { src, campaign }));
  });

  app.post('/c/:slug', async (req, res) => {
    const biz = await repo.businessBySlug(req.params.slug);
    if (!biz) return res.status(404).send(v.notFound('Este comercio no existe'));
    const src = normalizeSource(req.body.src);
    const values = {
      name: trim(req.body.name, 80),
      phone: trim(req.body.phone, 30),
      email: trim(req.body.email, 120),
      interest: trim(req.body.interest, 500),
    };
    const campaign = trim(req.body.campaign, 60);
    if (req.body.website) return res.send(v.thanksPage(biz, values)); // honeypot: bot, se descarta en silencio
    if (!allowLead(`${req.ip}:${biz.id}`)) {
      return res.status(429).send(v.publicPage(biz, { src, campaign, values, error: 'Demasiados envíos. Inténtalo en unos minutos.' }));
    }
    const phoneDigits = values.phone.replace(/\D/g, '');
    let error;
    if (!values.name) error = 'Indica tu nombre.';
    else if (phoneDigits.length < 7) error = 'Indica un teléfono válido.';
    else if (!req.body.consent) error = 'Necesitamos tu consentimiento para contactarte.';
    if (error) return res.status(400).send(v.publicPage(biz, { src, campaign, values, error }));

    await repo.upsertLead({ business_id: biz.id, ...values, source: src, channel: 'formulario', campaign, consent: true });
    res.send(v.thanksPage(biz, values));
  });

  // ---------- Acceso ----------
  app.get('/registro', (_req, res) => res.send(v.authPage('registro')));
  app.post('/registro', async (req, res) => {
    const values = { name: trim(req.body.name, 80), email: trim(req.body.email, 120).toLowerCase(), whatsapp: trim(req.body.whatsapp, 30) };
    const password = String(req.body.password || '');
    let error;
    if (!values.name || !values.email) error = 'Completa nombre y email.';
    else if (password.length < 8) error = 'La contraseña debe tener al menos 8 caracteres.';
    else if (await repo.businessByEmail(values.email)) error = 'Ya existe una cuenta con ese email.';
    if (error) return res.status(400).send(v.authPage('registro', { error, values }));

    let slug = slugify(values.name);
    for (let i = 2; await repo.businessBySlug(slug); i++) slug = `${slugify(values.name)}-${i}`;
    const id = await repo.createBusiness({ ...values, slug, password_hash: hashPassword(password) });
    await repo.createDefaultAutomations(id);
    session.issue(res, id);
    res.redirect('/panel/enlaces?ok=bienvenida');
  });

  app.get('/entrar', (_req, res) => res.send(v.authPage('entrar')));
  app.post('/entrar', async (req, res) => {
    const email = trim(req.body.email, 120).toLowerCase();
    const biz = await repo.businessByEmail(email);
    if (!biz || !verifyPassword(String(req.body.password || ''), biz.password_hash)) {
      return res.status(401).send(v.authPage('entrar', { error: 'Email o contraseña incorrectos.', values: { email } }));
    }
    session.issue(res, biz.id);
    res.redirect('/panel');
  });

  app.post('/salir', (_req, res) => { session.clear(res); res.redirect('/'); });

  // ---------- Panel (requiere sesión) ----------
  const panel = express.Router();
  panel.use(async (req, res, next) => {
    req.biz = req.businessId && await repo.businessById(req.businessId);
    if (!req.biz) return res.redirect('/entrar');
    next();
  });
  const leadOr404 = async (req, res) => {
    const lead = await repo.leadById(req.biz.id, Number(req.params.id));
    if (!lead) res.status(404).send(v.notFound('Lead no encontrado'));
    return lead;
  };

  panel.get('/', async (req, res) => {
    res.send(v.dashboard(req.biz, await repo.stats(req.biz.id), await repo.listLeads(req.biz.id), flash(req)));
  });

  const filtersFrom = (q) => ({ q: trim(q.q, 80), status: trim(q.status, 20), source: trim(q.source, 20) });

  panel.get('/leads', async (req, res) => {
    const filters = filtersFrom(req.query);
    const leads = await repo.listLeads(req.biz.id, { ...filters, search: filters.q });
    res.send(v.leadsPage(req.biz, leads, filters, flash(req)));
  });

  panel.get('/leads.csv', async (req, res) => {
    const filters = filtersFrom(req.query);
    const leads = await repo.listLeads(req.biz.id, { ...filters, search: filters.q });
    const cols = ['id', 'created_at', 'name', 'phone', 'email', 'handle', 'source', 'channel', 'campaign', 'status', 'interest', 'consent'];
    const cell = (x) => {
      let s = String(x ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en Excel
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(','), ...leads.map((l) => cols.map((c) => cell(l[c])).join(','))].join('\r\n');
    res.type('text/csv; charset=utf-8').attachment(`leads-${req.biz.slug}.csv`).send('﻿' + csv);
  });

  panel.post('/leads', async (req, res) => {
    await repo.upsertLead({
      business_id: req.biz.id, name: trim(req.body.name, 80), phone: trim(req.body.phone, 30),
      handle: trim(req.body.handle, 60).replace(/^@/, ''), interest: trim(req.body.interest),
      source: req.body.source, channel: 'manual',
    });
    res.redirect('/panel/leads?ok=creado');
  });

  panel.get('/leads/:id', async (req, res) => {
    const lead = await leadOr404(req, res);
    if (lead) res.send(v.leadDetail(req.biz, lead, await repo.activities(lead.id), flash(req)));
  });

  panel.post('/leads/:id', async (req, res) => {
    const lead = await leadOr404(req, res);
    if (!lead) return;
    await repo.updateLeadContact(req.biz.id, lead.id, {
      name: trim(req.body.name, 80), phone: trim(req.body.phone, 30),
      email: trim(req.body.email, 120), handle: trim(req.body.handle, 60).replace(/^@/, ''),
    });
    res.redirect(`/panel/leads/${lead.id}?ok=guardado`);
  });

  panel.post('/leads/:id/estado', async (req, res) => {
    const lead = await leadOr404(req, res);
    if (!lead) return;
    await repo.setLeadStatus(req.biz.id, lead.id, req.body.status);
    res.redirect(`/panel/leads/${lead.id}`);
  });

  panel.post('/leads/:id/notas', async (req, res) => {
    const lead = await leadOr404(req, res);
    if (!lead) return;
    const text = trim(req.body.text, 1000);
    if (text) await repo.addNote(req.biz.id, lead.id, text);
    res.redirect(`/panel/leads/${lead.id}?ok=nota`);
  });

  panel.get('/leads/:id/whatsapp', async (req, res) => {
    const lead = await leadOr404(req, res);
    if (!lead) return;
    const link = v.waLink(lead.phone, fillTemplate(req.biz.wa_template, req.biz, lead));
    if (!link) return res.redirect(`/panel/leads/${lead.id}`);
    await repo.logContact(req.biz.id, lead.id, 'Mensaje de seguimiento abierto en WhatsApp');
    if (lead.status === 'nuevo') await repo.setLeadStatus(req.biz.id, lead.id, 'contactado');
    res.redirect(link);
  });

  panel.post('/leads/:id/borrar', async (req, res) => {
    await repo.deleteLead(req.biz.id, Number(req.params.id));
    res.redirect('/panel/leads?ok=borrado');
  });

  panel.get('/enlaces', (req, res) => res.send(v.linksPage(req.biz, baseUrl(req), flash(req))));
  panel.get('/ajustes', (req, res) => res.send(v.settingsPage(req.biz, flash(req))));
  panel.post('/ajustes', async (req, res) => {
    const b = req.body;
    await repo.updateBusiness(req.biz.id, {
      name: trim(b.name, 80) || req.biz.name,
      headline: trim(b.headline, 140), offer: trim(b.offer, 140),
      whatsapp: trim(b.whatsapp, 30),
      instagram: trim(b.instagram, 60).replace(/^@/, ''), tiktok: trim(b.tiktok, 60).replace(/^@/, ''),
      wa_template: trim(b.wa_template, 1000) || req.biz.wa_template,
      keywords: trim(b.keywords, 300),
      ig_account_id: trim(b.ig_account_id, 40), wa_phone_number_id: trim(b.wa_phone_number_id, 40),
    });
    res.redirect('/panel/ajustes?ok=guardado');
  });

  // ---------- Automatización ----------
  panel.get('/automatizacion', async (req, res) => {
    res.send(v.automationPage(req.biz, await repo.listAutomations(req.biz.id), { aiAvailable: !!ai, baseUrl: baseUrl(req) }, flash(req)));
  });

  panel.post('/automatizacion/reglas', async (req, res) => {
    await repo.createAutomation(req.biz.id, {
      channel: trim(req.body.channel, 20), keywords: trim(req.body.keywords, 300),
      reply: trim(req.body.reply, 1000), public_reply: trim(req.body.public_reply, 300),
    });
    res.redirect('/panel/automatizacion?ok=regla');
  });

  panel.post('/automatizacion/recomendadas', async (req, res) => {
    await repo.createDefaultAutomations(req.biz.id);
    res.redirect('/panel/automatizacion?ok=regla');
  });

  panel.post('/automatizacion/reglas/:id/activar', async (req, res) => {
    await repo.toggleAutomation(req.biz.id, Number(req.params.id));
    res.redirect('/panel/automatizacion');
  });

  panel.post('/automatizacion/reglas/:id/borrar', async (req, res) => {
    await repo.deleteAutomation(req.biz.id, Number(req.params.id));
    res.redirect('/panel/automatizacion');
  });

  panel.post('/automatizacion/bot', async (req, res) => {
    await repo.updateBot(req.biz.id, {
      bot_questions: trim(req.body.bot_questions, 2000), bot_closing: trim(req.body.bot_closing, 1000),
      ai_enabled: req.body.ai_enabled === '1', ai_info: trim(req.body.ai_info, 6000),
    });
    res.redirect('/panel/automatizacion?ok=guardado');
  });

  panel.post('/automatizacion/meta', async (req, res) => {
    await repo.updateBusiness(req.biz.id, {
      ...req.biz,
      ig_account_id: trim(req.body.ig_account_id, 40), wa_phone_number_id: trim(req.body.wa_phone_number_id, 40),
    });
    await repo.updateTokens(req.biz.id, {
      ig_access_token: trim(req.body.ig_access_token, 1000), wa_access_token: trim(req.body.wa_access_token, 1000),
    });
    res.redirect('/panel/automatizacion?ok=conexion');
  });

  // ---------- Simulador: prueba el bot sin conectar Meta ----------
  const SIM_SOURCE = { whatsapp: 'whatsapp', ig_dm: 'instagram', ig_comment: 'instagram' };
  const simChannel = (c) => (SIM_SOURCE[c] ? c : 'whatsapp');

  async function renderSim(req, res, channel, extra = {}) {
    const lead = channel === 'ig_comment' ? null : await repo.simLead(req.biz.id, channel);
    const messages = lead ? await repo.conversation(lead) : [];
    res.send(v.simulatorPage(req.biz, channel, messages, { aiAvailable: !!ai, ...extra }, flash(req)));
  }

  panel.get('/simulador', async (req, res) => renderSim(req, res, simChannel(req.query.canal)));

  panel.post('/simulador', async (req, res) => {
    const channel = simChannel(req.body.canal);
    const text = trim(req.body.text, 1000);
    if (!text) return res.redirect(`/panel/simulador?canal=${channel}`);
    const link = `${baseUrl(req)}/c/${req.biz.slug}?src=${SIM_SOURCE[channel]}&campaign=bot`;

    if (channel === 'ig_comment') {
      const auto = await bot.onComment({ biz: req.biz, text, link });
      return renderSim(req, res, channel, { comment: { text, dm: auto?.dm, publicReply: auto?.publicReply } });
    }
    const r = await repo.upsertLead({
      business_id: req.biz.id, source: SIM_SOURCE[channel], channel: 'simulador',
      external_id: `sim:${channel}`, name: 'Cliente de prueba', interest: text,
    });
    const lead = await repo.leadById(req.biz.id, r.id);
    await bot.onMessage({ biz: req.biz, lead, created: r.created, channel, text, link });
    res.redirect(`/panel/simulador?canal=${channel}`);
  });

  panel.post('/simulador/reiniciar', async (req, res) => {
    await repo.deleteSimLeads(req.biz.id);
    res.redirect(`/panel/simulador?canal=${simChannel(req.body.canal)}&ok=reiniciado`);
  });

  app.use('/panel', panel);
  app.use((_req, res) => res.status(404).send(v.notFound()));
  app.locals.repo = repo;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp()
    .then((app) => app.listen(port, () => console.log(`LeadSocial escuchando en http://localhost:${port}`)))
    .catch((err) => { console.error('No se pudo arrancar LeadSocial:', err); process.exit(1); });
}

module.exports = { createApp, slugify };
