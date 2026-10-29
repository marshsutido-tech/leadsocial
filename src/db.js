'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SOURCES = ['instagram', 'tiktok', 'whatsapp', 'web', 'otro'];
const STATUSES = ['nuevo', 'contactado', 'interesado', 'cliente', 'perdido'];

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'leads.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      headline TEXT DEFAULT '',
      offer TEXT DEFAULT '',
      whatsapp TEXT DEFAULT '',
      instagram TEXT DEFAULT '',
      tiktok TEXT DEFAULT '',
      wa_template TEXT DEFAULT 'Hola {nombre}, soy de {comercio}. ¡Gracias por escribirnos! Te recuerdo nuestra oferta: {oferta}. ¿Cuándo te viene bien que te cuente más?',
      keywords TEXT DEFAULT 'info,precio,quiero',
      ig_account_id TEXT DEFAULT '',
      wa_phone_number_id TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      email TEXT DEFAULT '',
      handle TEXT DEFAULT '',
      interest TEXT DEFAULT '',
      source TEXT NOT NULL DEFAULT 'web',
      channel TEXT NOT NULL DEFAULT 'formulario',
      campaign TEXT DEFAULT '',
      external_id TEXT DEFAULT NULL,
      status TEXT NOT NULL DEFAULT 'nuevo',
      consent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS leads_business ON leads(business_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS leads_external
      ON leads(business_id, source, external_id) WHERE external_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      campaign TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function normalizeSource(s) {
  s = String(s || '').toLowerCase();
  if (s === 'ig') s = 'instagram';
  if (s === 'tt') s = 'tiktok';
  if (s === 'wa') s = 'whatsapp';
  return SOURCES.includes(s) ? s : 'web';
}

function repo(db) {
  const q = (sql) => db.prepare(sql);

  function addActivity(leadId, kind, text) {
    q('INSERT INTO activities (lead_id, kind, text) VALUES (?, ?, ?)').run(leadId, kind, text);
  }

  return {
    // --- comercios ---
    createBusiness(b) {
      const r = q(`INSERT INTO businesses (name, slug, email, password_hash, whatsapp)
                   VALUES (?, ?, ?, ?, ?)`).run(b.name, b.slug, b.email, b.password_hash, b.whatsapp || '');
      return Number(r.lastInsertRowid);
    },
    businessById: (id) => q('SELECT * FROM businesses WHERE id = ?').get(id),
    businessBySlug: (slug) => q('SELECT * FROM businesses WHERE slug = ?').get(slug),
    businessByEmail: (email) => q('SELECT * FROM businesses WHERE email = ?').get(email),
    businessByIgAccount: (id) => q("SELECT * FROM businesses WHERE ig_account_id = ? AND ig_account_id <> ''").get(String(id)),
    businessByWaPhoneId: (id) => q("SELECT * FROM businesses WHERE wa_phone_number_id = ? AND wa_phone_number_id <> ''").get(String(id)),
    updateBusiness(id, f) {
      q(`UPDATE businesses SET name=?, headline=?, offer=?, whatsapp=?, instagram=?, tiktok=?,
           wa_template=?, keywords=?, ig_account_id=?, wa_phone_number_id=? WHERE id=?`)
        .run(f.name, f.headline, f.offer, f.whatsapp, f.instagram, f.tiktok,
          f.wa_template, f.keywords, f.ig_account_id, f.wa_phone_number_id, id);
    },

    // --- leads ---
    /** Crea un lead. Si trae external_id y ya existe, registra actividad y devuelve el existente. */
    upsertLead(l) {
      const source = normalizeSource(l.source);
      if (l.external_id) {
        const existing = q('SELECT * FROM leads WHERE business_id=? AND source=? AND external_id=?')
          .get(l.business_id, source, String(l.external_id));
        if (existing) {
          if (l.interest) addActivity(existing.id, 'mensaje', l.interest);
          q("UPDATE leads SET updated_at = datetime('now') WHERE id = ?").run(existing.id);
          return { id: existing.id, created: false };
        }
      }
      const r = q(`INSERT INTO leads (business_id, name, phone, email, handle, interest, source, channel, campaign, external_id, consent)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(l.business_id, l.name || '', l.phone || '', l.email || '', l.handle || '', l.interest || '',
          source, l.channel || 'formulario', l.campaign || '', l.external_id ? String(l.external_id) : null, l.consent ? 1 : 0);
      const id = Number(r.lastInsertRowid);
      addActivity(id, 'alta', `Lead captado vía ${source} (${l.channel || 'formulario'})`);
      return { id, created: true };
    },
    listLeads(businessId, { status, source, search } = {}) {
      const where = ['business_id = ?'];
      const args = [businessId];
      if (STATUSES.includes(status)) { where.push('status = ?'); args.push(status); }
      if (SOURCES.includes(source)) { where.push('source = ?'); args.push(source); }
      if (search) {
        where.push('(name LIKE ? OR phone LIKE ? OR email LIKE ? OR handle LIKE ? OR interest LIKE ?)');
        const s = `%${search}%`;
        args.push(s, s, s, s, s);
      }
      return q(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 500`).all(...args);
    },
    leadById: (businessId, id) => q('SELECT * FROM leads WHERE business_id = ? AND id = ?').get(businessId, id),
    setLeadStatus(businessId, id, status) {
      if (!STATUSES.includes(status)) return false;
      const lead = q('SELECT status FROM leads WHERE business_id=? AND id=?').get(businessId, id);
      if (!lead || lead.status === status) return false;
      q("UPDATE leads SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
      addActivity(id, 'estado', `${lead.status} → ${status}`);
      return true;
    },
    updateLeadContact(businessId, id, f) {
      q("UPDATE leads SET name=?, phone=?, email=?, handle=?, updated_at=datetime('now') WHERE business_id=? AND id=?")
        .run(f.name || '', f.phone || '', f.email || '', f.handle || '', businessId, id);
    },
    addNote(businessId, id, text) {
      if (!q('SELECT 1 FROM leads WHERE business_id=? AND id=?').get(businessId, id)) return;
      addActivity(id, 'nota', text);
      q("UPDATE leads SET updated_at=datetime('now') WHERE id=?").run(id);
    },
    logContact(businessId, id, text) {
      if (!q('SELECT 1 FROM leads WHERE business_id=? AND id=?').get(businessId, id)) return;
      addActivity(id, 'whatsapp', text);
    },
    activities: (leadId) => q('SELECT * FROM activities WHERE lead_id = ? ORDER BY id DESC').all(leadId),
    deleteLead: (businessId, id) => q('DELETE FROM leads WHERE business_id=? AND id=?').run(businessId, id),

    // --- métricas ---
    recordVisit(businessId, source, campaign) {
      q('INSERT INTO visits (business_id, source, campaign) VALUES (?, ?, ?)').run(businessId, normalizeSource(source), campaign || '');
    },
    stats(businessId, days = 30) {
      const since = `-${Number(days)} days`;
      const visits = q(`SELECT source, COUNT(*) n FROM visits WHERE business_id=? AND created_at >= datetime('now', ?) GROUP BY source`).all(businessId, since);
      const leads = q(`SELECT source, COUNT(*) n FROM leads WHERE business_id=? AND created_at >= datetime('now', ?) GROUP BY source`).all(businessId, since);
      const byStatus = q('SELECT status, COUNT(*) n FROM leads WHERE business_id=? GROUP BY status').all(businessId);
      const perDay = q(`SELECT date(created_at) d, COUNT(*) n FROM leads WHERE business_id=? AND created_at >= datetime('now', ?) GROUP BY d ORDER BY d`).all(businessId, since);
      const toMap = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.n]));
      return { visits: toMap(visits, 'source'), leads: toMap(leads, 'source'), byStatus: toMap(byStatus, 'status'), perDay };
    },
  };
}

module.exports = { openDb, repo, normalizeSource, SOURCES, STATUSES };
