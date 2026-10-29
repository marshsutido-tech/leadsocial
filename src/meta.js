'use strict';

/**
 * Envío de mensajes con las APIs de Meta.
 * - Instagram: API de Instagram con inicio de sesión de Instagram (graph.instagram.com).
 * - WhatsApp: WhatsApp Cloud API (graph.facebook.com).
 * Cada comercio guarda sus propios tokens en Automatización → Conexión con Meta.
 */
const VERSION = process.env.META_GRAPH_VERSION || 'v24.0';

async function graphPost(url, token, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Meta respondió ${res.status}: ${await res.text()}`);
  return res.json();
}

function createMessenger() {
  const ig = (biz, path, body) => {
    if (!biz.ig_access_token) throw new Error('Falta el token de Instagram');
    return graphPost(`https://graph.instagram.com/${VERSION}/${path}`, biz.ig_access_token, body);
  };

  return {
    igDm: (biz, userId, text) =>
      ig(biz, `${biz.ig_account_id}/messages`, { recipient: { id: userId }, message: { text } }),
    /** Respuesta privada (DM) a quien ha comentado. */
    igPrivateReply: (biz, commentId, text) =>
      ig(biz, `${biz.ig_account_id}/messages`, { recipient: { comment_id: commentId }, message: { text } }),
    /** Respuesta pública debajo del comentario. */
    igCommentReply: (biz, commentId, text) => ig(biz, `${commentId}/replies`, { message: text }),
    waText(biz, to, text) {
      if (!biz.wa_access_token) throw new Error('Falta el token de WhatsApp');
      return graphPost(`https://graph.facebook.com/${VERSION}/${biz.wa_phone_number_id}/messages`, biz.wa_access_token,
        { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
    },
  };
}

module.exports = { createMessenger };
