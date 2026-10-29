'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createClient } = require('@libsql/client');

const SOURCES = ['instagram', 'tiktok', 'whatsapp', 'web', 'otro'];
const STATUSES = ['nuevo', 'contactado', 'interesado', 'cliente', 'perdido'];

const SCHEMA = `
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
`;

/**
 * Abre la base de datos.
 * - Con TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) usa una base de datos remota de Turso (plan gratuito).
 * - Si no, usa un archivo SQLite local (DB_FILE, por defecto ./data/leads.db).
 */
function openDb(url) {
  if (!url) {
    if (process.env.TURSO_DATABASE_URL) {
      url = process.env.TURSO_DATABASE_URL;
    } else {
      const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'leads.db');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      url = `file:${file}`;
    }
  }
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

async function migrate(db) {
  await db.executeMultiple(SCHEMA);
}

function normalizeSource(s) {
  s = String(s || '').toLowerCase();
  if (s === 'ig') s = 'instagram';
  if (s === 'tt') s = 'tiktok';
  if (s === 'wa') s = 'whatsapp';
  return SOURCES.includes(s) ? s : 'web';
}

function repo(db) {
  const run = (sql, ...args) => db.execute({ sql, args });
  const get = async (sql, ...args) => (await run(sql, ...args)).rows[0];
  const all = async (sql, ...args) => (await run(sql, ...args)).rows;

  const addActivity = (leadId, kind, text) =>
    run('INSERT INTO activities (lead_id, kind, text) VALUES (?, ?, ?)', leadId, kind, text);

  return {
    // --- comercios ---
    async createBusiness(b) {
      const r = await run(`INSERT INTO businesses (name, slug, email, password_hash, whatsapp)
                           VALUES (?, ?, ?, ?, ?)`, b.name, b.slug, b.email, b.password_hash, b.whatsapp || '');
      return Number(r.lastInsertRowid);
    },
    businessById: (id) => get('SELECT * FROM businesses WHERE id = ?', id),
    businessBySlug: (slug) => get('SELECT * FROM businesses WHERE slug = ?', slug),
    businessByEmail: (email) => get('SELECT * FROM businesses WHERE email = ?', email),
    businessByIgAccount: (id) => get("SELECT * FROM businesses WHERE ig_account_id = ? AND ig_account_id <> ''", String(id)),
    businessByWaPhoneId: (id) => get("SELECT * FROM businesses WHERE wa_phone_number_id = ? AND wa_phone_number_id <> ''", String(id)),
    async updateBusiness(id, f) {
      await run(`UPDATE businesses SET name=?, headline=?, offer=?, whatsapp=?, instagram=?, tiktok=?,
                   wa_template=?, keywords=?, ig_account_id=?, wa_phone_number_id=? WHERE id=?`,
        f.name, f.headline, f.offer, f.whatsapp, f.instagram, f.tiktok,
        f.wa_template, f.keywords, f.ig_account_id, f.wa_phone_number_id, id);
    },

    // --- leads ---
    /** Crea un lead. Si trae external_id y ya existe, registra actividad y devuelve el existente. */
    async upsertLead(l) {
      const source = normalizeSource(l.source);
      if (l.external_id) {
        const existing = await get('SELECT * FROM leads WHERE business_id=? AND source=? AND external_id=?',
          l.business_id, source, String(l.external_id));
        if (existing) {
          if (l.interest) await addActivity(existing.id, 'mensaje', l.interest);
          await run("UPDATE leads SET updated_at = datetime('now') WHERE id = ?", existing.id);
          return { id: existing.id, created: false };
        }
      }
      const r = await run(`INSERT INTO leads (business_id, name, phone, email, handle, interest, source, channel, campaign, external_id, consent)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        l.business_id, l.name || '', l.phone || '', l.email || '', l.handle || '', l.interest || '',
        source, l.channel || 'formulario', l.campaign || '', l.external_id ? String(l.external_id) : null, l.consent ? 1 : 0);
      const id = Number(r.lastInsertRowid);
      await addActivity(id, 'alta', `Lead captado vía ${source} (${l.channel || 'formulario'})`);
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
      return all(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 500`, ...args);
    },
    leadById: (businessId, id) => get('SELECT * FROM leads WHERE business_id = ? AND id = ?', businessId, id),
    async setLeadStatus(businessId, id, status) {
      if (!STATUSES.includes(status)) return false;
      const lead = await get('SELECT status FROM leads WHERE business_id=? AND id=?', businessId, id);
      if (!lead || lead.status === status) return false;
      await run("UPDATE leads SET status=?, updated_at=datetime('now') WHERE id=?", status, id);
      await addActivity(id, 'estado', `${lead.status} → ${status}`);
      return true;
    },
    async updateLeadContact(businessId, id, f) {
      await run("UPDATE leads SET name=?, phone=?, email=?, handle=?, updated_at=datetime('now') WHERE business_id=? AND id=?",
        f.name || '', f.phone || '', f.email || '', f.handle || '', businessId, id);
    },
    async addNote(businessId, id, text) {
      if (!await get('SELECT 1 FROM leads WHERE business_id=? AND id=?', businessId, id)) return;
      await addActivity(id, 'nota', text);
      await run("UPDATE leads SET updated_at=datetime('now') WHERE id=?", id);
    },
    async logContact(businessId, id, text) {
      if (!await get('SELECT 1 FROM leads WHERE business_id=? AND id=?', businessId, id)) return;
      await addActivity(id, 'whatsapp', text);
    },
    activities: (leadId) => all('SELECT * FROM activities WHERE lead_id = ? ORDER BY id DESC', leadId),
    async deleteLead(businessId, id) {
      if (!await get('SELECT 1 FROM leads WHERE business_id=? AND id=?', businessId, id)) return;
      await run('DELETE FROM activities WHERE lead_id=?', id);
      await run('DELETE FROM leads WHERE id=?', id);
    },

    // --- métricas ---
    recordVisit: (businessId, source, campaign) =>
      run('INSERT INTO visits (business_id, source, campaign) VALUES (?, ?, ?)', businessId, normalizeSource(source), campaign || ''),
    async stats(businessId, days = 30) {
      const since = `-${Number(days)} days`;
      const [visits, leads, byStatus, perDay] = await Promise.all([
        all(`SELECT source, COUNT(*) n FROM visits WHERE business_id=? AND created_at >= datetime('now', ?) GROUP BY source`, businessId, since),
        all(`SELECT source, COUNT(*) n FROM leads WHERE business_id=? AND created_at >= datetime('now', ?) GROUP BY source`, businessId, since),
        all('SELECT status, COUNT(*) n FROM leads WHERE business_id=? GROUP BY status', businessId),
        all(`SELECT date(created_at) d, COUNT(*) n FROM leads WHERE business_id=? AND created_at >= datetime('now', ?) GROUP BY d ORDER BY d`, businessId, since),
      ]);
      const toMap = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], Number(r.n)]));
      return {
        visits: toMap(visits, 'source'), leads: toMap(leads, 'source'), byStatus: toMap(byStatus, 'status'),
        perDay: perDay.map((r) => ({ d: r.d, n: Number(r.n) })),
      };
    },
  };
}

module.exports = { openDb, migrate, repo, normalizeSource, SOURCES, STATUSES };
