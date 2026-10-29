'use strict';
const { SOURCES, STATUSES } = require('./db');
const { fillTemplate } = require('./template');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SOURCE_LABEL = { instagram: 'Instagram', tiktok: 'TikTok', whatsapp: 'WhatsApp', web: 'Web', otro: 'Otro' };
const STATUS_LABEL = { nuevo: 'Nuevo', contactado: 'Contactado', interesado: 'Interesado', cliente: 'Cliente', perdido: 'Perdido' };

const digits = (phone) => String(phone || '').replace(/\D/g, '');


function waLink(phone, text) {
  const n = digits(phone);
  if (!n) return '';
  return `https://wa.me/${n}?text=${encodeURIComponent(text || '')}`;
}

function layout(title, body, { biz, flash } = {}) {
  const nav = biz ? `
    <header class="top">
      <a class="brand" href="/panel">LeadSocial</a>
      <nav>
        <a href="/panel">Resumen</a>
        <a href="/panel/leads">Leads</a>
        <a href="/panel/automatizacion">Automatización</a>
        <a href="/panel/simulador">Probar bot</a>
        <a href="/panel/enlaces">Enlaces</a>
        <a href="/panel/ajustes">Ajustes</a>
        <form method="post" action="/salir"><button class="link">Salir</button></form>
      </nav>
    </header>` : '';
  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
</head><body>
${nav}
<main class="${biz ? 'wrap' : 'wrap narrow'}">
${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
${body}
</main>
</body></html>`;
}

// ---------- Público ----------

function publicPage(biz, { src, campaign, error, values = {} }) {
  const social = [
    biz.instagram && `<a class="pill ig" href="https://instagram.com/${esc(biz.instagram.replace(/^@/, ''))}" target="_blank" rel="noopener">Instagram</a>`,
    biz.tiktok && `<a class="pill tt" href="https://www.tiktok.com/@${esc(biz.tiktok.replace(/^@/, ''))}" target="_blank" rel="noopener">TikTok</a>`,
    biz.whatsapp && `<a class="pill wa" href="${esc(waLink(biz.whatsapp, `Hola ${biz.name}, vengo de ${SOURCE_LABEL[src] || 'vuestra web'}.`))}" target="_blank" rel="noopener">WhatsApp</a>`,
  ].filter(Boolean).join('');

  return layout(biz.name, `
  <section class="card hero">
    <h1>${esc(biz.name)}</h1>
    ${biz.headline ? `<p class="muted">${esc(biz.headline)}</p>` : ''}
    ${biz.offer ? `<p class="offer">${esc(biz.offer)}</p>` : ''}
    <div class="pills">${social}</div>
  </section>
  <section class="card">
    <h2>Déjanos tus datos y te escribimos</h2>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form method="post" action="/c/${esc(biz.slug)}" class="stack">
      <input type="hidden" name="src" value="${esc(src)}">
      <input type="hidden" name="campaign" value="${esc(campaign)}">
      <label>Nombre<input name="name" required maxlength="80" value="${esc(values.name)}"></label>
      <label>WhatsApp / teléfono<input name="phone" type="tel" required maxlength="30" value="${esc(values.phone)}" placeholder="+34 600 000 000"></label>
      <label>Email (opcional)<input name="email" type="email" maxlength="120" value="${esc(values.email)}"></label>
      <label>¿Qué te interesa?<textarea name="interest" maxlength="500" rows="3">${esc(values.interest)}</textarea></label>
      <label class="hp" aria-hidden="true">Web<input name="website" tabindex="-1" autocomplete="off"></label>
      <label class="check"><input type="checkbox" name="consent" value="1" required>
        Acepto que ${esc(biz.name)} me contacte por WhatsApp, teléfono o email sobre mi consulta.</label>
      <button class="btn">Quiero información</button>
    </form>
  </section>`);
}

function thanksPage(biz, lead) {
  const link = waLink(biz.whatsapp, `Hola ${biz.name}, soy ${lead.name}. Acabo de dejar mis datos: ${lead.interest || 'quiero información'}.`);
  return layout(`Gracias · ${biz.name}`, `
  <section class="card hero">
    <h1>¡Gracias, ${esc(lead.name)}!</h1>
    <p>Hemos recibido tus datos. ${esc(biz.name)} te contactará muy pronto.</p>
    ${link ? `<p><a class="btn wa" href="${esc(link)}" target="_blank" rel="noopener">Escribir ahora por WhatsApp</a></p>` : ''}
  </section>`);
}

// ---------- Acceso ----------

function authPage(mode, { error, values = {} } = {}) {
  const reg = mode === 'registro';
  return layout(reg ? 'Crear cuenta' : 'Entrar', `
  <section class="card">
    <h1>${reg ? 'Crea la cuenta de tu comercio' : 'Entrar en LeadSocial'}</h1>
    ${error ? `<p class="error">${esc(error)}</p>` : ''}
    <form method="post" action="/${reg ? 'registro' : 'entrar'}" class="stack">
      ${reg ? `<label>Nombre del comercio<input name="name" required maxlength="80" value="${esc(values.name)}"></label>
      <label>WhatsApp del comercio<input name="whatsapp" type="tel" maxlength="30" value="${esc(values.whatsapp)}" placeholder="+34 600 000 000"></label>` : ''}
      <label>Email<input name="email" type="email" required value="${esc(values.email)}"></label>
      <label>Contraseña<input name="password" type="password" required minlength="8"></label>
      <button class="btn">${reg ? 'Crear cuenta' : 'Entrar'}</button>
    </form>
    <p class="muted">${reg ? '¿Ya tienes cuenta? <a href="/entrar">Entra</a>' : '¿Nuevo? <a href="/registro">Crea una cuenta</a>'}</p>
  </section>`);
}

// ---------- Panel ----------

function dashboard(biz, stats, recent, flash) {
  const rows = SOURCES.map((s) => {
    const v = stats.visits[s] || 0;
    const l = stats.leads[s] || 0;
    const conv = v ? `${Math.round((l / v) * 100)}%` : '—';
    return (v || l) ? `<tr><td>${SOURCE_LABEL[s]}</td><td>${v}</td><td>${l}</td><td>${conv}</td></tr>` : '';
  }).join('') || '<tr><td colspan="4" class="muted">Aún no hay datos. Comparte tus enlaces en las redes.</td></tr>';

  const totalLeads = Object.values(stats.leads).reduce((a, b) => a + b, 0);
  const pending = stats.byStatus.nuevo || 0;
  const clients = stats.byStatus.cliente || 0;
  const perDay = Object.fromEntries(stats.perDay.map((d) => [d.d, d.n]));
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 864e5).toISOString().slice(0, 10));
  const max = Math.max(1, ...stats.perDay.map((d) => d.n));
  const bars = stats.perDay.length ? days.map((d) =>
    `<div class="bar" style="height:${Math.round(((perDay[d] || 0) / max) * 100)}%" title="${d}: ${perDay[d] || 0}"></div>`).join('') : '';

  return layout('Resumen', `
  <h1>Hola, ${esc(biz.name)}</h1>
  <div class="tiles">
    <div class="tile"><span>Leads (30 días)</span><strong>${totalLeads}</strong></div>
    <div class="tile ${pending ? 'warn' : ''}"><span>Sin contactar</span><strong>${pending}</strong></div>
    <div class="tile"><span>Clientes</span><strong>${clients}</strong></div>
  </div>
  <section class="card">
    <h2>Leads por día</h2>
    ${bars ? `<div class="bars">${bars}</div>` : '<p class="muted">Sin leads en los últimos 30 días.</p>'}
  </section>
  <section class="card">
    <h2>Rendimiento por red (30 días)</h2>
    <table><thead><tr><th>Red</th><th>Visitas</th><th>Leads</th><th>Conversión</th></tr></thead><tbody>${rows}</tbody></table>
  </section>
  <section class="card">
    <h2>Últimos leads</h2>
    ${leadTable(recent.slice(0, 8), biz)}
    <p><a href="/panel/leads">Ver todos →</a></p>
  </section>`, { biz, flash });
}

function leadTable(leads, biz) {
  if (!leads.length) return '<p class="muted">No hay leads todavía.</p>';
  return `<table class="leads"><thead><tr><th>Nombre</th><th>Red</th><th>Interés</th><th>Estado</th><th></th></tr></thead><tbody>
  ${leads.map((l) => {
    const msg = fillTemplate(biz.wa_template, biz, l);
    const wa = waLink(l.phone, msg);
    return `<tr>
      <td><a href="/panel/leads/${l.id}">${esc(l.name || l.handle || l.phone || 'Sin nombre')}</a><br><small class="muted">${esc(l.created_at)}</small></td>
      <td><span class="tag ${esc(l.source)}">${SOURCE_LABEL[l.source]}</span><br><small class="muted">${esc(l.channel)}</small></td>
      <td class="clip">${esc(l.interest)}</td>
      <td><span class="status ${esc(l.status)}">${STATUS_LABEL[l.status]}</span></td>
      <td>${wa ? `<a class="btn small wa" href="/panel/leads/${l.id}/whatsapp" target="_blank" rel="noopener">WhatsApp</a>` : ''}</td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function leadsPage(biz, leads, filters, flash) {
  const opt = (list, labels, cur) => list.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${labels[v]}</option>`).join('');
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  return layout('Leads', `
  <div class="row between"><h1>Leads</h1>
    <div class="row"><a class="btn ghost" href="/panel/leads.csv${qs ? `?${qs}` : ''}">Exportar CSV</a>
    <a class="btn" href="#nuevo">+ Añadir lead</a></div></div>
  <form class="row filters" method="get">
    <input name="q" placeholder="Buscar nombre, teléfono, @usuario…" value="${esc(filters.q)}">
    <select name="status"><option value="">Todos los estados</option>${opt(STATUSES, STATUS_LABEL, filters.status)}</select>
    <select name="source"><option value="">Todas las redes</option>${opt(SOURCES, SOURCE_LABEL, filters.source)}</select>
    <button class="btn ghost">Filtrar</button>
  </form>
  <section class="card">${leadTable(leads, biz)}</section>
  <section class="card" id="nuevo">
    <h2>Añadir lead manualmente</h2>
    <p class="muted">Para contactos que llegan por DM de TikTok, llamadas o en tienda.</p>
    <form method="post" action="/panel/leads" class="grid2">
      <label>Nombre<input name="name" required></label>
      <label>Teléfono<input name="phone" type="tel"></label>
      <label>@usuario<input name="handle"></label>
      <label>Red<select name="source">${opt(SOURCES, SOURCE_LABEL, 'tiktok')}</select></label>
      <label class="full">Interés<input name="interest"></label>
      <button class="btn">Guardar</button>
    </form>
  </section>`, { biz, flash });
}

function leadDetail(biz, lead, activities, flash) {
  const msg = fillTemplate(biz.wa_template, biz, lead);
  const statusButtons = STATUSES.map((s) => `
    <button name="status" value="${s}" class="status ${s} ${lead.status === s ? 'active' : ''}">${STATUS_LABEL[s]}</button>`).join('');
  const kindLabel = { alta: 'Alta', estado: 'Estado', nota: 'Nota', mensaje: 'Mensaje del cliente', whatsapp: 'WhatsApp', bot: 'Respuesta automática', respuesta: 'Respuesta a pregunta', error: 'Error' };
  return layout(lead.name || 'Lead', `
  <p><a href="/panel/leads">← Volver</a></p>
  <div class="row between"><h1>${esc(lead.name || lead.handle || 'Sin nombre')}</h1>
    <span class="tag ${esc(lead.source)}">${SOURCE_LABEL[lead.source]} · ${esc(lead.channel)}</span></div>
  <section class="card">
    <form method="post" action="/panel/leads/${lead.id}/estado" class="row wrapbtns">${statusButtons}</form>
  </section>
  <div class="cols">
    <section class="card">
      <h2>Contacto</h2>
      <form method="post" action="/panel/leads/${lead.id}" class="stack">
        <label>Nombre<input name="name" value="${esc(lead.name)}"></label>
        <label>Teléfono<input name="phone" value="${esc(lead.phone)}"></label>
        <label>Email<input name="email" value="${esc(lead.email)}"></label>
        <label>@usuario<input name="handle" value="${esc(lead.handle)}"></label>
        <button class="btn ghost">Guardar cambios</button>
      </form>
      <p class="muted">Interés: ${esc(lead.interest) || '—'}</p>
      ${lead.campaign ? `<p class="muted">Campaña: ${esc(lead.campaign)}</p>` : ''}
      <p class="muted">Consentimiento: ${lead.consent ? 'sí' : 'no registrado'}</p>
    </section>
    <section class="card">
      <h2>Seguimiento por WhatsApp</h2>
      ${lead.phone ? `<pre class="msg">${esc(msg)}</pre>
        <a class="btn wa" href="/panel/leads/${lead.id}/whatsapp" target="_blank" rel="noopener">Abrir WhatsApp con este mensaje</a>
        <p class="muted small">Al abrirlo se registra el contacto y, si el lead era «Nuevo», pasa a «Contactado».</p>`
        : `<p class="muted">Añade un teléfono para poder escribirle.${lead.handle ? ` Mientras, contáctalo por DM: @${esc(lead.handle)}` : ''}</p>`}
      <h2>Notas</h2>
      <form method="post" action="/panel/leads/${lead.id}/notas" class="stack">
        <textarea name="text" rows="2" required placeholder="Ej.: llamar el jueves, quiere presupuesto…"></textarea>
        <button class="btn ghost">Añadir nota</button>
      </form>
      <ul class="timeline">${activities.map((a) =>
        `<li><small class="muted">${esc(a.created_at)} · ${kindLabel[a.kind] || esc(a.kind)}</small><br>${esc(a.text)}</li>`).join('')}</ul>
    </section>
  </div>
  <form method="post" action="/panel/leads/${lead.id}/borrar" onsubmit="return confirm('¿Borrar este lead?')">
    <button class="link danger">Borrar lead</button></form>`, { biz, flash });
}

function linksPage(biz, baseUrl, flash) {
  const url = (src) => `${baseUrl}/c/${biz.slug}?src=${src}`;
  const card = (title, src, tip) => `
    <div class="card">
      <h2>${title}</h2>
      <div class="copy"><input readonly value="${esc(url(src))}" onclick="this.select()">
        <button type="button" class="btn ghost" onclick="navigator.clipboard.writeText(this.previousElementSibling.value);this.textContent='¡Copiado!'">Copiar</button></div>
      <p class="muted small">${tip}</p>
    </div>`;
  return layout('Enlaces', `
  <h1>Tus enlaces de captación</h1>
  <p class="muted">Cada red tiene su enlace para saber de dónde vienen los leads. Añade <code>&amp;campaign=nombre</code> para medir campañas concretas (p. ej. un reel o un sorteo).</p>
  <div class="cols">
    ${card('Instagram', 'instagram', 'Ponlo en el enlace de la bio, en historias con sticker de enlace y en respuestas a DMs.')}
    ${card('TikTok', 'tiktok', 'Ponlo en el enlace de la bio. Menciona «link en bio» en tus vídeos.')}
    ${card('WhatsApp', 'whatsapp', 'Compártelo en tu estado de WhatsApp o en el mensaje de bienvenida de WhatsApp Business.')}
    ${card('Otros (web, QR en tienda)', 'web', 'Úsalo en tu web, Google Business o en un QR en el mostrador.')}
  </div>
  <section class="card">
    <h2>Captura automática desde Instagram y WhatsApp</h2>
    <p>Conecta la app de Meta para crear leads automáticamente cuando alguien te escribe un DM, comenta con una palabra clave (${esc(biz.keywords) || 'cualquier comentario'}) o te escribe por WhatsApp Business.</p>
    <ol class="small">
      <li>URL del webhook: <code>${esc(baseUrl)}/webhooks/meta</code></li>
      <li>Token de verificación: el valor de <code>META_VERIFY_TOKEN</code> del servidor.</li>
      <li>Suscríbete a <code>messages</code> y <code>comments</code> (Instagram) y <code>messages</code> (WhatsApp).</li>
      <li>Guarda tu ID de cuenta de Instagram y tu Phone Number ID de WhatsApp en <a href="/panel/ajustes">Ajustes</a>.</li>
    </ol>
  </section>`, { biz, flash });
}

function settingsPage(biz, flash) {
  const f = (name, label, extra = '') => `<label>${label}<input name="${name}" value="${esc(biz[name])}" ${extra}></label>`;
  return layout('Ajustes', `
  <h1>Ajustes</h1>
  <form method="post" action="/panel/ajustes" class="cols">
    <section class="card stack">
      <h2>Tu página pública</h2>
      ${f('name', 'Nombre del comercio', 'required')}
      ${f('headline', 'Frase corta', 'placeholder="Panadería artesanal en el centro"')}
      ${f('offer', 'Oferta / gancho', 'placeholder="10% en tu primera compra"')}
      ${f('whatsapp', 'WhatsApp del comercio', 'placeholder="+34 600 000 000"')}
      ${f('instagram', 'Usuario de Instagram', 'placeholder="@micomercio"')}
      ${f('tiktok', 'Usuario de TikTok', 'placeholder="@micomercio"')}
      <p class="muted small">Tu página: <a href="/c/${esc(biz.slug)}" target="_blank">/c/${esc(biz.slug)}</a></p>
    </section>
    <section class="card stack">
      <h2>Seguimiento</h2>
      <label>Mensaje de WhatsApp
        <textarea name="wa_template" rows="4">${esc(biz.wa_template)}</textarea></label>
      <p class="muted small">Variables: {nombre}, {comercio}, {oferta}</p>
      <h2>Automatización (Meta)</h2>
      ${f('keywords', 'Palabras clave en comentarios (separadas por comas)')}
      ${f('ig_account_id', 'ID de cuenta de Instagram (profesional)')}
      ${f('wa_phone_number_id', 'Phone Number ID de WhatsApp Cloud API')}
      <button class="btn">Guardar</button>
    </section>
  </form>`, { biz, flash });
}

// ---------- Automatización ----------

const CHANNEL_LABEL = { ig_comment: 'Comentario de Instagram', ig_dm: 'DM de Instagram', whatsapp: 'WhatsApp' };

function automationPage(biz, rules, { aiAvailable, baseUrl }, flash) {
  const ruleRows = rules.map((r) => `
    <tr class="${r.active ? '' : 'off'}">
      <td><span class="tag ${r.channel === 'whatsapp' ? 'whatsapp' : 'instagram'}">${CHANNEL_LABEL[r.channel]}</span></td>
      <td>${r.keywords ? esc(r.keywords) : `<span class="muted">${r.channel === 'ig_comment' ? 'cualquier comentario' : 'primer mensaje'}</span>`}</td>
      <td class="wrapcell">${esc(r.reply)}${r.public_reply ? `<br><small class="muted">Pública: ${esc(r.public_reply)}</small>` : ''}</td>
      <td>${r.hits}</td>
      <td><div class="row">
        <form method="post" action="/panel/automatizacion/reglas/${r.id}/activar"><button class="btn small ghost">${r.active ? 'Pausar' : 'Activar'}</button></form>
        <form method="post" action="/panel/automatizacion/reglas/${r.id}/borrar" onsubmit="return confirm('¿Borrar esta regla?')"><button class="link danger">Borrar</button></form>
      </div></td>
    </tr>`).join('');

  const connected = (ok) => (ok ? '<span class="status cliente">Conectado</span>' : '<span class="status perdido">Sin conectar</span>');

  return layout('Automatización', `
  <div class="row between"><h1>Respuestas automáticas</h1><a class="btn" href="/panel/simulador">Probar el bot</a></div>
  <p class="muted">El bot contesta solo en Instagram y WhatsApp, guarda a cada persona como lead y te avisa en el panel. Puedes probarlo en el simulador sin conectar nada.</p>

  <section class="card">
    <h2>1. Reglas por palabra clave</h2>
    ${rules.length ? `<div class="tablewrap"><table><thead><tr><th>Dónde</th><th>Palabras clave</th><th>Respuesta</th><th>Usos</th><th></th></tr></thead><tbody>${ruleRows}</tbody></table></div>`
      : `<p class="muted">No tienes reglas.</p><form method="post" action="/panel/automatizacion/recomendadas"><button class="btn ghost">Añadir reglas recomendadas</button></form>`}
    <h3>Nueva regla</h3>
    <form method="post" action="/panel/automatizacion/reglas" class="grid2">
      <label>Dónde<select name="channel">
        <option value="ig_comment">Comentario de Instagram → DM privado</option>
        <option value="ig_dm">DM de Instagram</option>
        <option value="whatsapp">WhatsApp</option></select></label>
      <label>Palabras clave (separadas por comas)<input name="keywords" placeholder="precio, info, quiero"></label>
      <label class="full">Respuesta<textarea name="reply" rows="2" required placeholder="¡Hola{nombre}! Aquí tienes toda la info 👉 {enlace}"></textarea></label>
      <label class="full">Respuesta pública en el comentario (solo comentarios, opcional)<input name="public_reply" placeholder="¡Te hemos enviado un mensaje privado! 📩"></label>
      <button class="btn">Añadir regla</button>
    </form>
    <p class="muted small">Sin palabras clave: en DMs y WhatsApp responde al <b>primer mensaje</b> (bienvenida); en comentarios, a <b>cualquier</b> comentario.
      Variables: {nombre}, {comercio}, {oferta}, {enlace} (tu página de captación).</p>
  </section>

  <form method="post" action="/panel/automatizacion/bot" class="cols">
    <section class="card stack">
      <h2>2. Preguntas de cualificación</h2>
      <p class="muted small">Cuando alguien escribe por primera vez por DM o WhatsApp, el bot le hace estas preguntas una a una y guarda las respuestas en su ficha.</p>
      <label>Una pregunta por línea<textarea name="bot_questions" rows="4" placeholder="¿Cómo te llamas?\n¿Qué estás buscando?\n¿Para cuándo lo necesitas?">${esc(biz.bot_questions)}</textarea></label>
      <label>Mensaje final<textarea name="bot_closing" rows="2">${esc(biz.bot_closing)}</textarea></label>
      <button class="btn">Guardar</button>
    </section>
    <section class="card stack">
      <h2>3. Asistente con IA</h2>
      ${aiAvailable ? '' : '<p class="error small">El servidor no tiene configurada la clave de IA (ANTHROPIC_API_KEY). Puedes dejar la información preparada.</p>'}
      <label class="check"><input type="checkbox" name="ai_enabled" value="1" ${biz.ai_enabled ? 'checked' : ''}>
        Responder con IA cuando ninguna regla encaje (solo a leads en estado «Nuevo»)</label>
      <label>Información del negocio para la IA
        <textarea name="ai_info" rows="7" placeholder="Horario: L-V 10:00-20:00, S 10:00-14:00&#10;Dirección: Calle Mayor 5, Valencia&#10;Servicios y precios: ramo básico desde 25 €…&#10;Envíos: en el día dentro de Valencia">${esc(biz.ai_info)}</textarea></label>
      <p class="muted small">La IA solo usa esta información. Si le preguntan algo que no está aquí, dirá que una persona contestará en breve.</p>
      <button class="btn">Guardar</button>
    </section>
  </form>

  <section class="card">
    <h2>4. Conexión con Meta</h2>
    <p>Instagram ${connected(biz.ig_account_id && biz.ig_access_token)} &nbsp; WhatsApp ${connected(biz.wa_phone_number_id && biz.wa_access_token)}</p>
    <form method="post" action="/panel/automatizacion/meta" class="grid2">
      <label>ID de cuenta de Instagram<input name="ig_account_id" value="${esc(biz.ig_account_id)}"></label>
      <label>Token de acceso de Instagram<input name="ig_access_token" type="password" autocomplete="off" placeholder="${biz.ig_access_token ? '•••••• guardado (déjalo vacío para mantenerlo)' : 'IGAA…'}"></label>
      <label>Phone Number ID de WhatsApp<input name="wa_phone_number_id" value="${esc(biz.wa_phone_number_id)}"></label>
      <label>Token de acceso de WhatsApp<input name="wa_access_token" type="password" autocomplete="off" placeholder="${biz.wa_access_token ? '•••••• guardado (déjalo vacío para mantenerlo)' : 'EAA…'}"></label>
      <button class="btn">Guardar conexión</button>
    </form>
    <p class="muted small">Webhook para tu app de Meta: <code>${esc(baseUrl)}/webhooks/meta</code></p>
  </section>`, { biz, flash });
}

function simulatorPage(biz, channel, messages, { aiAvailable, comment }, flash) {
  const tabs = ['whatsapp', 'ig_dm', 'ig_comment'].map((c) =>
    `<a class="btn small ${c === channel ? '' : 'ghost'}" href="/panel/simulador?canal=${c}">${CHANNEL_LABEL[c]}</a>`).join('');
  let chat;
  if (channel === 'ig_comment') {
    chat = comment ? `
      <div class="bubble cliente"><small>Comentario</small>${esc(comment.text)}</div>
      ${comment.dm ? `<div class="bubble bot"><small>DM privado automático</small>${esc(comment.dm)}</div>` : '<p class="muted">Ninguna regla de comentarios coincide: no se respondería.</p>'}
      ${comment.publicReply ? `<div class="bubble bot"><small>Respuesta pública</small>${esc(comment.publicReply)}</div>` : ''}`
      : '<p class="muted">Escribe un comentario como si fueras un seguidor (por ejemplo «¿precio?»).</p>';
  } else {
    chat = messages.length ? messages.map((m) => `<div class="bubble ${m.from}">${esc(m.text)}</div>`).join('')
      : '<p class="muted">Escribe un mensaje como si fueras un cliente.</p>';
  }
  return layout('Probar bot', `
  <h1>Probar el bot</h1>
  <p class="muted">Simula lo que vería un cliente. No se envía nada de verdad ni se guarda como lead.${aiAvailable ? '' : ' (La IA no está disponible en este servidor.)'}</p>
  <div class="row">${tabs}</div>
  <section class="card chat">${chat}</section>
  <form method="post" action="/panel/simulador" class="row">
    <input type="hidden" name="canal" value="${esc(channel)}">
    <input name="text" required autofocus autocomplete="off" placeholder="${channel === 'ig_comment' ? 'Escribe un comentario…' : 'Escribe un mensaje…'}" style="flex:1">
    <button class="btn">Enviar</button>
  </form>
  ${channel === 'ig_comment' ? '' : `<form method="post" action="/panel/simulador/reiniciar"><input type="hidden" name="canal" value="${esc(channel)}"><button class="link">Empezar de nuevo</button></form>`}
  <p class="muted small">¿No responde lo que esperas? Ajusta las reglas en <a href="/panel/automatizacion">Automatización</a>.</p>`, { biz, flash });
}

function notFound(msg = 'Página no encontrada') {
  return layout('No encontrado', `<section class="card"><h1>${esc(msg)}</h1><p><a href="/">Inicio</a></p></section>`);
}

function home() {
  return layout('LeadSocial', `
  <section class="card hero">
    <h1>Convierte seguidores en clientes</h1>
    <p>Un enlace para la bio de Instagram y TikTok, captura automática de DMs, comentarios y WhatsApp, y un panel para hacer seguimiento.</p>
    <p class="row"><a class="btn" href="/registro">Crear cuenta gratis</a> <a class="btn ghost" href="/entrar">Entrar</a></p>
  </section>`);
}

module.exports = {
  esc, fillTemplate, waLink, publicPage, thanksPage, authPage, dashboard,
  leadsPage, leadDetail, linksPage, settingsPage, notFound, home, layout, automationPage, simulatorPage,
};
