'use strict';
const crypto = require('node:crypto');

const SESSION_DAYS = 14;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function sessions(secret) {
  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  return {
    issue(res, businessId) {
      const payload = `${businessId}.${Date.now() + SESSION_DAYS * 864e5}`;
      res.cookie('sid', `${payload}.${sign(payload)}`, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: SESSION_DAYS * 864e5,
      });
    },
    clear(res) {
      res.clearCookie('sid');
    },
    /** Middleware: carga req.businessId si la cookie es válida. */
    read(req, _res, next) {
      const raw = parseCookies(req.headers.cookie).sid;
      if (raw) {
        const [id, exp, sig] = raw.split('.');
        const payload = `${id}.${exp}`;
        const good = sig && sign(payload);
        if (good && sig.length === good.length &&
            crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) && Number(exp) > Date.now()) {
          req.businessId = Number(id);
        }
      }
      next();
    },
  };
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, sessions };
