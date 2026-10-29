'use strict';
const { fillTemplate } = require('./template');

/**
 * Motor de respuestas automáticas. Decide qué contestar; no envía nada (eso lo hace quien lo llama).
 *
 * Orden en una conversación (DM de Instagram o WhatsApp):
 *  1. Si el lead está respondiendo a las preguntas de cualificación → guarda la respuesta y hace la siguiente.
 *  2. Regla con palabra clave que coincida → su respuesta.
 *     Regla sin palabras clave → solo en el primer mensaje (bienvenida).
 *  3. Primer mensaje y hay preguntas configuradas → empieza el cuestionario.
 *  4. Si nada de lo anterior respondió y la IA está activada (y el lead sigue «Nuevo») → responde la IA.
 */

function keywordList(keywords) {
  return String(keywords || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
}

function matchRule(rules, text, { firstMessage }) {
  const t = String(text || '').toLowerCase();
  return rules.find((r) => keywordList(r.keywords).some((k) => t.includes(k))) ||
    (firstMessage ? rules.find((r) => !keywordList(r.keywords).length) : undefined);
}

function questionList(biz) {
  return String(biz.bot_questions || '').split('\n').map((q) => q.trim()).filter(Boolean);
}

function createBot({ repo, ai }) {
  const activeRules = async (biz, channel) =>
    (await repo.listAutomations(biz.id)).filter((r) => r.active && r.channel === channel);

  return {
    /** Comentario en Instagram → { rule, dm, publicReply } o null si ninguna regla aplica. */
    async onComment({ biz, text, link }) {
      const rule = matchRule(await activeRules(biz, 'ig_comment'), text, { firstMessage: true });
      if (!rule) return null;
      await repo.countAutomationHit(rule.id);
      return { rule, dm: fillTemplate(rule.reply, biz, null, { link }), publicReply: fillTemplate(rule.public_reply, biz, null, { link }) };
    },

    /** Mensaje en una conversación → lista de textos a enviar (puede estar vacía). */
    async onMessage({ biz, lead, created, channel, text, link }) {
      const replies = [];
      const questions = questionList(biz);
      const step = Number(lead.bot_step) || 0;

      if (step > 0) {
        const asked = questions[step - 1];
        if (asked) await repo.addActivity(lead.id, 'respuesta', `${asked} → ${text}`);
        if (step < questions.length) {
          replies.push(questions[step]);
          await repo.setBotStep(lead.id, step + 1);
        } else {
          replies.push(fillTemplate(biz.bot_closing, biz, lead, { link }));
          await repo.setBotStep(lead.id, -1);
        }
      } else {
        const rule = matchRule(await activeRules(biz, channel), text, { firstMessage: created });
        if (rule) {
          replies.push(fillTemplate(rule.reply, biz, lead, { link }));
          await repo.countAutomationHit(rule.id);
        }
        if (created && questions.length) {
          replies.push(questions[0]);
          await repo.setBotStep(lead.id, 1);
        } else if (!rule && ai && biz.ai_enabled && lead.status === 'nuevo') {
          const answer = await ai.reply({ biz, conversation: await repo.conversation(lead), link });
          if (answer) replies.push(answer);
        }
      }

      for (const r of replies) await repo.addActivity(lead.id, 'bot', r);
      return replies;
    },
  };
}

module.exports = { createBot, matchRule, keywordList };
