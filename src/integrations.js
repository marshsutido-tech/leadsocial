'use strict';
const crypto = require('node:crypto');
const { keywordList } = require('./bot');

/**
 * Webhooks de Meta (Instagram + WhatsApp Cloud API).
 *
 * - Instagram DMs (messaging)          → lead por conversación (dedupe por sender id) + respuesta automática
 * - Instagram comentarios (changes)    → lead si hay palabra clave o regla; DM privado + respuesta pública
 * - WhatsApp mensajes entrantes        → lead por número (dedupe por número) + respuesta automática
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
  const words = keywordList(keywords);
  if (!words.length) return true;
  const t = String(text || '').toLowerCase();
  return words.some((w) => t.includes(w));
}

/** Envía cada respuesta y deja constancia si falla (p. ej. falta el token). */
async function sendAll(repo, leadId, replies, send) {
  for (const text of replies) {
    try {
      await send(text);
    } catch (err) {
      console.error('No se pudo enviar la respuesta automática:', err.message);
      await repo.addActivity(leadId, 'error', `No se pudo enviar: ${err.message.slice(0, 200)}`);
      return;
    }
  }
}

async function processMetaPayload(repo, body, { bot, messenger, baseUrl = '' } = {}) {
  const results = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  const linkFor = (biz, src) => (baseUrl ? `${baseUrl}/c/${biz.slug}?src=${src}&campaign=bot` : '');

  // Crea o actualiza el lead, recarga su estado y deja que el bot conteste.
  async function conversation(biz, channel, lead, send) {
    const r = await repo.upsertLead(lead);
    results.push(r);
    if (!bot) return;
    const fresh = await repo.leadById(biz.id, r.id);
    const replies = await bot.onMessage({
      biz, lead: fresh, created: r.created, channel, text: lead.interest,
      link: linkFor(biz, lead.source),
    });
    await sendAll(repo, r.id, replies, send);
  }

  if (body?.object === 'instagram') {
    for (const entry of entries) {
      const biz = await repo.businessByIgAccount(entry.id);
      if (!biz) continue;

      for (const m of entry.messaging || []) {
        const senderId = m.sender?.id;
        if (!senderId || senderId === String(entry.id) || m.message?.is_echo || !m.message) continue;
        await conversation(biz, 'ig_dm', {
          business_id: biz.id, source: 'instagram', channel: 'dm',
          external_id: `dm:${senderId}`, interest: m.message.text || '[adjunto]',
        }, (text) => messenger.igDm(biz, senderId, text));
      }

      for (const c of entry.changes || []) {
        if (c.field !== 'comments' || !c.value) continue;
        const v = c.value;
        if (v.from?.id && String(v.from.id) === String(entry.id)) continue; // comentario del propio comercio
        const auto = bot ? await bot.onComment({ biz, text: v.text, link: linkFor(biz, 'instagram') }) : null;
        if (!auto && !matchesKeyword(v.text, biz.keywords)) continue;
        const username = v.from?.username || '';
        const r = await repo.upsertLead({
          business_id: biz.id, source: 'instagram', channel: 'comentario',
          external_id: `user:${v.from?.id || username}`,
          name: username ? `@${username}` : '', handle: username, interest: v.text,
        });
        results.push(r);
        if (auto && v.id) {
          const replies = [auto.dm].filter(Boolean);
          for (const t of replies) await repo.addActivity(r.id, 'bot', t);
          await sendAll(repo, r.id, replies, (t) => messenger.igPrivateReply(biz, v.id, t));
          if (auto.publicReply) await sendAll(repo, r.id, [auto.publicReply], (t) => messenger.igCommentReply(biz, v.id, t));
        }
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
          await conversation(biz, 'whatsapp', {
            business_id: biz.id, source: 'whatsapp', channel: 'mensaje',
            external_id: msg.from, phone: `+${msg.from}`, name: names[msg.from] || '', interest: text,
          }, (t) => messenger.waText(biz, msg.from, t));
        }
      }
    }
  }
  return results;
}

function mountMetaWebhooks(app, repo, { bot, messenger, baseUrl }) {
  const pending = new Set();
  app.locals.drainWebhooks = () => Promise.all(pending);

  app.get('/webhooks/meta', (req, res) => {
    const token = process.env.META_VERIFY_TOKEN;
    if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
      return res.type('text').send(String(req.query['hub.challenge'] ?? ''));
    }
    res.sendStatus(403);
  });

  app.post('/webhooks/meta', (req, res) => {
    if (!verifySignature(req)) return res.sendStatus(401);
    // Meta exige respuesta rápida: se contesta 200 y se procesa (IA incluida) en segundo plano.
    res.sendStatus(200);
    const job = processMetaPayload(repo, req.body, { bot, messenger, baseUrl: baseUrl(req) })
      .catch((err) => console.error('Error procesando webhook de Meta:', err))
      .finally(() => pending.delete(job));
    pending.add(job);
  });
}

module.exports = { mountMetaWebhooks, processMetaPayload, matchesKeyword };
