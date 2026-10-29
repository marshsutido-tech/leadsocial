'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { openDb, repo: makeRepo, normalizeSource } = require('./db');
const { hashPassword, verifyPassword, sessions } = require('./auth');
const { mountMetaWebhooks } = require('./integrations');
const v = require('./views');

const FLASH = {
  guardado: 'Cambios guardados.',
  creado: 'Lead añadido.',
  borrado: 'Lead borrado.',
  nota: 'Nota añadida.',
  bienvenida: '¡Cuenta creada! Copia tus enlaces y ponlos en la bio de tus redes.',
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

function createApp({ db = openDb(), secret = process.env.SESSION_SECRET } = {}) {
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    if (process.env.NODE_ENV === 'production') throw new Error('Falta SESSION_SECRET');
  }
  const repo = makeRepo(db);
  const session = sessions(secret);
  const allowLead = rateLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(session.read);

  const baseUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
  const flash = (req) => FLASH[req.query.ok];
  const trim = (s, n = 500) => String(s ?? '').trim().slice(0, n);

  // ---------- Webhooks ----------
  mountMetaWebhooks(app, repo);

  // ---------- Público ----------
  app.get('/', (req, res) => (req.businessId ? res.redirect('/panel') : res.send(v.home())));

  app.get('/c/:slug', (req, res) => {
    const biz = repo.businessBySlug(req.params.slug);
    if (!biz) return res.status(404).send(v.notFound('Este comercio no existe'));
    const src = normalizeSource(req.query.src);
    const campaign = trim(req.query.campaign, 60);
    repo.recordVisit(biz.id, src, campaign);
    res.send(v.publicPage(biz, { src, campaign }));
  });

  app.post('/c/:slug', (req, res) => {
    const biz = repo.businessBySlug(req.params.slug);
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

    repo.upsertLead({ business_id: biz.id, ...values, source: src, channel: 'formulario', campaign, consent: true });
    res.send(v.thanksPage(biz, values));
  });

  // ---------- Acceso ----------
  app.get('/registro', (_req, res) => res.send(v.authPage('registro')));
  app.post('/registro', (req, res) => {
    const values = { name: trim(req.body.name, 80), email: trim(req.body.email, 120).toLowerCase(), whatsapp: trim(req.body.whatsapp, 30) };
    const password = String(req.body.password || '');
    let error;
    if (!values.name || !values.email) error = 'Completa nombre y email.';
    else if (password.length < 8) error = 'La contraseña debe tener al menos 8 caracteres.';
    else if (repo.businessByEmail(values.email)) error = 'Ya existe una cuenta con ese email.';
    if (error) return res.status(400).send(v.authPage('registro', { error, values }));

    let slug = slugify(values.name);
    for (let i = 2; repo.businessBySlug(slug); i++) slug = `${slugify(values.name)}-${i}`;
    const id = repo.createBusiness({ ...values, slug, password_hash: hashPassword(password) });
    session.issue(res, id);
    res.redirect('/panel/enlaces?ok=bienvenida');
  });

  app.get('/entrar', (_req, res) => res.send(v.authPage('entrar')));
  app.post('/entrar', (req, res) => {
    const email = trim(req.body.email, 120).toLowerCase();
    const biz = repo.businessByEmail(email);
    if (!biz || !verifyPassword(String(req.body.password || ''), biz.password_hash)) {
      return res.status(401).send(v.authPage('entrar', { error: 'Email o contraseña incorrectos.', values: { email } }));
    }
    session.issue(res, biz.id);
    res.redirect('/panel');
  });

  app.post('/salir', (_req, res) => { session.clear(res); res.redirect('/'); });

  // ---------- Panel (requiere sesión) ----------
  const panel = express.Router();
  panel.use((req, res, next) => {
    req.biz = req.businessId && repo.businessById(req.businessId);
    if (!req.biz) return res.redirect('/entrar');
    next();
  });
  const leadOr404 = (req, res) => {
    const lead = repo.leadById(req.biz.id, Number(req.params.id));
    if (!lead) res.status(404).send(v.notFound('Lead no encontrado'));
    return lead;
  };

  panel.get('/', (req, res) => {
    res.send(v.dashboard(req.biz, repo.stats(req.biz.id), repo.listLeads(req.biz.id), flash(req)));
  });

  const filtersFrom = (q) => ({ q: trim(q.q, 80), status: trim(q.status, 20), source: trim(q.source, 20) });

  panel.get('/leads', (req, res) => {
    const filters = filtersFrom(req.query);
    const leads = repo.listLeads(req.biz.id, { ...filters, search: filters.q });
    res.send(v.leadsPage(req.biz, leads, filters, flash(req)));
  });

  panel.get('/leads.csv', (req, res) => {
    const filters = filtersFrom(req.query);
    const leads = repo.listLeads(req.biz.id, { ...filters, search: filters.q });
    const cols = ['id', 'created_at', 'name', 'phone', 'email', 'handle', 'source', 'channel', 'campaign', 'status', 'interest', 'consent'];
    const cell = (x) => {
      let s = String(x ?? '');
      if (/^[=+\-@]/.test(s)) s = `'${s}`; // evita inyección de fórmulas en Excel
      return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(','), ...leads.map((l) => cols.map((c) => cell(l[c])).join(','))].join('\r\n');
    res.type('text/csv; charset=utf-8').attachment(`leads-${req.biz.slug}.csv`).send('﻿' + csv);
  });

  panel.post('/leads', (req, res) => {
    repo.upsertLead({
      business_id: req.biz.id, name: trim(req.body.name, 80), phone: trim(req.body.phone, 30),
      handle: trim(req.body.handle, 60).replace(/^@/, ''), interest: trim(req.body.interest),
      source: req.body.source, channel: 'manual',
    });
    res.redirect('/panel/leads?ok=creado');
  });

  panel.get('/leads/:id', (req, res) => {
    const lead = leadOr404(req, res);
    if (lead) res.send(v.leadDetail(req.biz, lead, repo.activities(lead.id), flash(req)));
  });

  panel.post('/leads/:id', (req, res) => {
    const lead = leadOr404(req, res);
    if (!lead) return;
    repo.updateLeadContact(req.biz.id, lead.id, {
      name: trim(req.body.name, 80), phone: trim(req.body.phone, 30),
      email: trim(req.body.email, 120), handle: trim(req.body.handle, 60).replace(/^@/, ''),
    });
    res.redirect(`/panel/leads/${lead.id}?ok=guardado`);
  });

  panel.post('/leads/:id/estado', (req, res) => {
    const lead = leadOr404(req, res);
    if (!lead) return;
    repo.setLeadStatus(req.biz.id, lead.id, req.body.status);
    res.redirect(`/panel/leads/${lead.id}`);
  });

  panel.post('/leads/:id/notas', (req, res) => {
    const lead = leadOr404(req, res);
    if (!lead) return;
    const text = trim(req.body.text, 1000);
    if (text) repo.addNote(req.biz.id, lead.id, text);
    res.redirect(`/panel/leads/${lead.id}?ok=nota`);
  });

  panel.get('/leads/:id/whatsapp', (req, res) => {
    const lead = leadOr404(req, res);
    if (!lead) return;
    const link = v.waLink(lead.phone, v.fillTemplate(req.biz.wa_template, req.biz, lead));
    if (!link) return res.redirect(`/panel/leads/${lead.id}`);
    repo.logContact(req.biz.id, lead.id, 'Mensaje de seguimiento abierto en WhatsApp');
    if (lead.status === 'nuevo') repo.setLeadStatus(req.biz.id, lead.id, 'contactado');
    res.redirect(link);
  });

  panel.post('/leads/:id/borrar', (req, res) => {
    repo.deleteLead(req.biz.id, Number(req.params.id));
    res.redirect('/panel/leads?ok=borrado');
  });

  panel.get('/enlaces', (req, res) => res.send(v.linksPage(req.biz, baseUrl(req), flash(req))));
  panel.get('/ajustes', (req, res) => res.send(v.settingsPage(req.biz, flash(req))));
  panel.post('/ajustes', (req, res) => {
    const b = req.body;
    repo.updateBusiness(req.biz.id, {
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

  app.use('/panel', panel);
  app.use((_req, res) => res.status(404).send(v.notFound()));
  app.locals.repo = repo;
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`LeadSocial escuchando en http://localhost:${port}`));
}

module.exports = { createApp, slugify };
