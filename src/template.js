'use strict';

/**
 * Rellena las variables de un mensaje: {nombre}, {comercio}, {oferta}, {enlace}.
 * Si no se conoce el nombre, «Hola {nombre},» queda como «Hola,».
 */
function fillTemplate(tpl, biz, lead, { link = '' } = {}) {
  const name = String(lead?.name || '').replace(/^@/, '').trim();
  return String(tpl || '')
    .replace(/ ?\{nombre\}/g, name ? ` ${name}` : '')
    .replaceAll('{comercio}', biz.name)
    .replaceAll('{oferta}', biz.offer || 'consúltanos sin compromiso')
    .replaceAll('{enlace}', link);
}

module.exports = { fillTemplate };
