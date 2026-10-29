'use strict';
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';

/**
 * Asistente con IA que responde a los clientes del comercio por DM/WhatsApp.
 * Solo se activa si el servidor tiene ANTHROPIC_API_KEY.
 */
function createAi(apiKey = process.env.ANTHROPIC_API_KEY) {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });

  return {
    /** @param conversation [{from: 'cliente'|'bot', text}] en orden; la última debe ser del cliente. */
    async reply({ biz, conversation, link }) {
      const messages = conversation.map((m) => ({ role: m.from === 'bot' ? 'assistant' : 'user', content: m.text }));
      while (messages.length && messages[0].role !== 'user') messages.shift();
      if (!messages.length || messages[messages.length - 1].role !== 'user') return null;

      const system = [
        `Eres el asistente de mensajería de «${biz.name}», un comercio que atiende a sus clientes por Instagram y WhatsApp.`,
        'Responde en el idioma del cliente, con tono cercano y profesional, en mensajes cortos (máximo 3 frases), como en un chat.',
        'Usa solo la información del comercio que tienes abajo. Si te preguntan algo que no está ahí (precios, disponibilidad, plazos…), no lo inventes: di que una persona del equipo le contestará en breve.',
        'Si el cliente muestra interés en comprar o reservar, pídele su nombre y lo que necesita, o invítale a dejar sus datos en el enlace.',
        '',
        `Información del comercio:\n${biz.ai_info || '(sin información adicional)'}`,
        biz.headline ? `Descripción: ${biz.headline}` : '',
        biz.offer ? `Oferta actual: ${biz.offer}` : '',
        link ? `Enlace para dejar sus datos: ${link}` : '',
      ].filter(Boolean).join('\n');

      try {
        const response = await client.beta.messages.create({
          model: MODEL,
          max_tokens: 4000,
          output_config: { effort: 'low' },
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          system,
          messages,
        });
        if (response.stop_reason === 'refusal') return null;
        const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        return text || null;
      } catch (err) {
        if (err instanceof Anthropic.RateLimitError) console.error('IA: límite de peticiones alcanzado');
        else if (err instanceof Anthropic.AuthenticationError) console.error('IA: ANTHROPIC_API_KEY no válida');
        else if (err instanceof Anthropic.APIError) console.error(`IA: error ${err.status}:`, err.message);
        else console.error('IA: error de conexión:', err.message);
        return null;
      }
    },
  };
}

module.exports = { createAi };
