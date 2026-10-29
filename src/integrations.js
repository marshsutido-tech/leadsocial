'use strict';
const crypto = require('node:crypto');

/**
 * Webhooks de Meta (Instagram + WhatsApp Cloud API).
 *
 * - Instagram DMs (messaging)          → lead nuevo por conversación (dedupe por sender id)
 * - Instagram comentarios (changes)    → lead si el comentario contiene una palabra clave
 * - WhatsApp mensajes entrantes        → lead por número (dedupe por número)
 *
 * Cada comercio se identifica por su ig_account_id / wa_phone_number_id (configurables en Ajustes).
 */

function verifySignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return true; // sin secreto configurado (desarrollo) no se valida
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  return header.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

function matchesKeyword(text, keywords) {
  const words = String(keywords || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (!words.length) return true;
  const t = String(text || '').toLowerCase();
  return words.some((w) => t.includes(w));
}

async function processMetaPayload(repo, body) {
  const results = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  if (body?.object === 'instagram') {
    for (const entry of entries) {
      const biz = await repo.businessByIgAccount(entry.id);
      if (!biz) continue;

      for (const m of entry.messaging || []) {
        const senderId = m.sender?.id;
        if (!senderId || senderId === String(entry.id) || m.message?.is_echo) continue;
        const text = m.message?.text || '[adjunto]';
        results.push(await repo.upsertLead({
          business_id: biz.id, source: 'instagram', channel: 'dm',
          external_id: `dm:${senderId}`, interest: text,
        }));
      }

      for (const c of entry.changes || []) {
        if (c.field !== 'comments' || !c.value) continue;
        const v = c.value;
        if (!matchesKeyword(v.text, biz.keywords)) continue;
        const username = v.from?.username || '';
        results.push(await repo.upsertLead({
          business_id: biz.id, source: 'instagram', channel: 'comentario',
          external_id: `user:${v.from?.id || username}`,
          name: username ? `@${username}` : '', handle: username, interest: v.text,
        }));
      }
    }
  }

  if (body?.object === 'whatsapp_business_account') {
    for (const entry of entries) {
      for (const c of entry.changes || []) {
        const v = c.value || {};
        const biz = await repo.businessByWaPhoneId(v.metadata?.phone_number_id);
        if (!biz) continue;
        const names = Object.fromEntries((v.contacts || []).map((ct) => [ct.wa_id, ct.profile?.name]));
        for (const msg of v.messages || []) {
          const text = msg.text?.body || msg.button?.text || msg.interactive?.button_reply?.title || `[${msg.type}]`;
          results.push(await repo.upsertLead({
            business_id: biz.id, source: 'whatsapp', channel: 'mensaje',
            external_id: msg.from, phone: `+${msg.from}`, name: names[msg.from] || '', interest: text,
          }));
        }
      }
    }
  }
  return results;
}

function mountMetaWebhooks(app, repo) {
  app.get('/webhooks/meta', (req, res) => {
    const token = process.env.META_VERIFY_TOKEN;
    if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
      return res.type('text').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });

  app.post('/webhooks/meta', async (req, res) => {
    if (!verifySignature(req)) return res.sendStatus(401);
    try {
      await processMetaPayload(repo, req.body);
    } catch (err) {
      console.error('Error procesando webhook de Meta:', err);
    }
    res.sendStatus(200); // Meta reintenta si no recibe 200
  });
}

module.exports = { mountMetaWebhooks, processMetaPayload, matchesKeyword };
