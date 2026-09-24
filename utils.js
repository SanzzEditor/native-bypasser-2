'use strict';

/**
 * lib/utils.js
 * Helper HTTP request 100% native. Hanya modul inti Node.js:
 * http, https, url, crypto, buffer (+ zlib bawaan untuk dekompresi gzip/deflate).
 */

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');
const { Buffer } = require('buffer');

/* ------------------------------------------------------------------ */
/* Konstanta                                                          */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  timeout: 15000, // batas waktu total per request (ms)
  maxBytes: 2 * 1024 * 1024, // batas body yang di-buffer (hemat RAM)
  retries: 2, // percobaan ulang tambahan pada requestWithFallback
  retryDelay: 500, // dasar backoff eksponensial (ms)
};

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const RETRY_STATUS = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const RETRY_ERRORS = new Set([
  'E_TIMEOUT', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EPIPE', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH',
]);
const TEXT_TYPE = /text|json|xml|javascript|html|svg|x-www-form-urlencoded/;
const HTML_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

const UA_DESKTOP = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0',
];
const UA_MOBILE =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const UA_MINIMAL = 'curl/8.9.1';

class BypassError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.name = 'BypassError';
    this.code = code || 'E_BYPASS';
    if (extra) Object.assign(this, extra);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* URL helpers                                                        */
/* ------------------------------------------------------------------ */

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return String(str);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (e) {
    return '';
  }
}

function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return false;
  const s = value.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    return new URL(s).hostname.length > 0;
  } catch (e) {
    return false;
  }
}

function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return null;
  }
}

/** Blokir host lokal/privat (cegah SSRF lewat redirect). Hanya cek literal host. */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || /\.(localhost|local|internal)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(':')) {
    return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  }
  return false;
}

function lowerKeys(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    if (obj[k] !== undefined && obj[k] !== null) out[k.toLowerCase()] = String(obj[k]);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* HTTP request native                                                */
/* ------------------------------------------------------------------ */

/** Profil header untuk rotasi saat fallback (desktop -> mobile/IPv4 -> minimal). */
function profileFor(attempt) {
  const n = Math.abs(attempt) % 3;
  if (n === 0) {
    return {
      headers: {
        'user-agent': UA_DESKTOP[crypto.randomInt(UA_DESKTOP.length)],
        accept: HTML_ACCEPT,
        'accept-language': 'en-US,en;q=0.9,id;q=0.8',
      },
    };
  }
  if (n === 1) {
    return {
      family: 4,
      headers: { 'user-agent': UA_MOBILE, accept: HTML_ACCEPT, 'accept-language': 'id-ID,id;q=0.9,en;q=0.8' },
    };
  }
  return { headers: { 'user-agent': UA_MINIMAL, accept: '*/*' } };
}

function charsetOf(contentType) {
  const m = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  const cs = m ? m[1].toLowerCase() : 'utf-8';
  return /^(iso-8859-1|latin1|windows-1252|us-ascii|ascii)$/.test(cs) ? 'latin1' : 'utf8';
}

function inflate(buffer, encoding, limit) {
  const enc = String(encoding || '').toLowerCase();
  if (enc !== 'gzip' && enc !== 'x-gzip' && enc !== 'deflate') return buffer;
  const opts = { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength: limit };
  if (enc === 'deflate') {
    try {
      return zlib.inflateSync(buffer, opts);
    } catch (e) {
      return zlib.inflateRawSync(buffer, opts);
    }
  }
  return zlib.gunzipSync(buffer, opts);
}

/**
 * Satu request HTTP(S) tanpa mengikuti redirect.
 * Opsi: method, headers, body, timeout, maxBytes, headersOnly, textOnly (default true),
 *       family (4|6), allowPrivate (default false), agent.
 * Resolve: { url, statusCode, statusMessage, headers, body, truncated, elapsed }
 */
function request(target, options) {
  const o = Object.assign({}, DEFAULTS, options);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req = null;
    let timer = null;
    const started = Date.now();

    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        if (req) req.destroy();
        reject(err);
      } else {
        resolve(value);
      }
    };

    let url;
    try {
      url = new URL(target);
    } catch (e) {
      return done(new BypassError(`URL tidak valid: ${target}`, 'E_INVALID_URL'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return done(new BypassError(`Protokol tidak didukung: ${url.protocol}`, 'E_PROTOCOL'));
    }
    if (!o.allowPrivate && isPrivateHost(url.hostname)) {
      return done(new BypassError(`Host lokal/privat diblokir: ${url.hostname}`, 'E_PRIVATE_HOST'));
    }

    const method = String(o.method || 'GET').toUpperCase();
    const profile = o.profile || profileFor(0);
    const headers = Object.assign(
      { 'accept-encoding': 'gzip, deflate', connection: 'close' },
      profile.headers,
      lowerKeys(o.headers)
    );

    let payload = null;
    if (o.body !== undefined && o.body !== null && method !== 'GET' && method !== 'HEAD') {
      payload = Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body));
      headers['content-length'] = String(payload.length);
    }

    const reqOptions = {
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      agent: o.agent !== undefined ? o.agent : false,
    };
    const family = o.family || profile.family;
    if (family) reqOptions.family = family;

    timer = setTimeout(
      () => done(new BypassError(`Timeout ${o.timeout}ms: ${url.href}`, 'E_TIMEOUT')),
      o.timeout
    );

    const transport = url.protocol === 'https:' ? https : http;
    req = transport.request(reqOptions, (res) => {
      const status = res.statusCode;
      const hdrs = res.headers;
      const type = String(hdrs['content-type'] || '').toLowerCase();
      const disposition = String(hdrs['content-disposition'] || '').toLowerCase();
      const redirecting = REDIRECT_CODES.has(status) && !!hdrs.location;
      const textual = !type || TEXT_TYPE.test(type);
      const skipBody =
        method === 'HEAD' ||
        !!o.headersOnly ||
        redirecting ||
        (o.textOnly !== false && (!textual || disposition.includes('attachment')));

      const finish = (raw, truncated) => {
        let body = '';
        if (raw.length) {
          try {
            body = inflate(raw, hdrs['content-encoding'], o.maxBytes * 4).toString(charsetOf(type));
          } catch (e) {
            return done(new BypassError(`Gagal dekompresi body: ${e.message}`, 'E_DECODE'));
          }
        }
        return done(null, {
          url: url.href,
          statusCode: status,
          statusMessage: res.statusMessage || '',
          headers: hdrs,
          body,
          truncated,
          elapsed: Date.now() - started,
        });
      };

      res.on('error', (err) => done(err));
      res.on('close', () => {
        if (!res.complete) done(new BypassError('Koneksi terputus sebelum respons selesai', 'ECONNRESET'));
      });

      if (skipBody) {
        finish(Buffer.alloc(0), false);
        res.destroy();
        return;
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > o.maxBytes) {
          chunks.push(chunk.slice(0, chunk.length - (size - o.maxBytes)));
          finish(Buffer.concat(chunks), true);
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(Buffer.concat(chunks), false));
    });

    req.on('error', (err) => done(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function backoff(attempt, base, res) {
  let ms = base * Math.pow(2, attempt) + crypto.randomInt(0, 250);
  const retryAfter = res && res.headers ? parseInt(res.headers['retry-after'], 10) : 0;
  if (retryAfter > 0) ms = Math.max(ms, retryAfter * 1000);
  return Math.min(ms, 8000);
}

/**
 * Resilience handler: request dengan retry + backoff + rotasi profil header
 * (desktop -> mobile/IPv4 -> minimal) saat timeout, koneksi putus, atau akses dibatasi
 * (403/429/5xx). Opsi `fallbackUrls` = endpoint cadangan yang dicoba bila endpoint utama gagal.
 * Bila hanya ada respons HTTP (mis. 403), respons terakhir dikembalikan apa adanya.
 */
async function requestWithFallback(target, options) {
  const o = Object.assign({}, DEFAULTS, options);
  const targets = [target].concat(o.fallbackUrls || []);
  let lastRes = null;
  let lastErr = null;

  for (let i = 0; i < targets.length; i++) {
    const attempts = i === 0 ? o.retries + 1 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await request(targets[i], Object.assign({}, o, { profile: profileFor(attempt + i) }));
        if (!RETRY_STATUS.has(res.statusCode)) return res;
        lastRes = res;
      } catch (err) {
        lastErr = err;
        if (!RETRY_ERRORS.has(err.code)) break; // error permanen: lanjut ke endpoint cadangan
      }
      if (attempt < attempts - 1) await sleep(backoff(attempt, o.retryDelay, lastRes));
    }
  }
  if (lastRes) return lastRes;
  throw lastErr || new BypassError('Semua percobaan request gagal', 'E_FALLBACK_EXHAUSTED');
}

/* ------------------------------------------------------------------ */
/* Base64 decoder internal                                            */
/* ------------------------------------------------------------------ */

/** Decode Base64 / Base64URL (padding opsional). Return null bila bukan teks valid. */
function base64Decode(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (s.length < 4 || s.length % 4 === 1 || !/^[A-Za-z0-9+/]+$/.test(s)) return null;
  s += '='.repeat((4 - (s.length % 4)) % 4);
  const text = Buffer.from(s, 'base64').toString('utf8');
  if (!text || text.includes('\uFFFD') || /[\u0000-\u0008\u000E-\u001F]/.test(text)) return null;
  return text;
}

/** Decode Base64 (bisa berlapis, maks `maxDepth`) sampai ditemukan URL http(s) yang valid. */
function extractUrlFromBase64(input, maxDepth) {
  let current = String(input || '').trim();
  for (let i = 0; i < (maxDepth || 3); i++) {
    const decoded = base64Decode(safeDecodeURIComponent(current));
    if (!decoded) return null;
    const text = decoded.trim();
    if (isHttpUrl(text)) return text;
    const embedded = /https?:\/\/[^\s"'<>\\]+/i.exec(text);
    if (embedded && isHttpUrl(embedded[0])) return embedded[0];
    current = text;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Parser HTML berbasis regex                                         */
/* ------------------------------------------------------------------ */

function decodeHtmlEntities(str) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(str || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = named[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function unescapeJs(str) {
  return String(str || '')
    .replace(/\\u([0-9a-f]{4})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/');
}

/** Parse atribut dari satu tag HTML, mis. '<a href="x" id=y>' -> { href:'x', id:'y' }. */
function parseAttrs(tag) {
  const attrs = {};
  const inner = String(tag || '').replace(/^<\s*[a-z0-9:-]+/i, '').replace(/\/?>$/, '');
  const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const key = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    if (!(key in attrs)) attrs[key] = decodeHtmlEntities(val);
  }
  return attrs;
}

function getMeta(html, name) {
  const re = /<meta\b[^>]*>/gi;
  const src = String(html || '');
  let m;
  while ((m = re.exec(src))) {
    const a = parseAttrs(m[0]);
    if ((a.property === name || a.name === name) && a.content) return a.content.trim();
  }
  return '';
}

function extractTitle(html) {
  if (!html) return '';
  const m = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const text = m ? decodeHtmlEntities(m[1]) : getMeta(html, 'og:title');
  return text.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Info header & format hasil                                         */
/* ------------------------------------------------------------------ */

function parseHeaderInfo(headers) {
  const h = headers || {};
  const cd = String(h['content-disposition'] || '');
  let filename = '';
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(cd);
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(cd) || /filename\s*=\s*([^;]+)/i.exec(cd);
  if (star) filename = safeDecodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
  else if (plain) filename = plain[1].trim();
  const len = parseInt(h['content-length'], 10);
  return {
    contentType: String(h['content-type'] || '').split(';')[0].trim().toLowerCase(),
    contentLength: Number.isFinite(len) ? len : null,
    filename,
    lastModified: h['last-modified'] || null,
    server: h.server || null,
    acceptRanges: h['accept-ranges'] || null,
  };
}

/** Format sukses: { status: true, title, destination, direct_link, ...extra } */
function ok(data) {
  return Object.assign({ status: true, title: '', destination: '', direct_link: '' }, data);
}

/** Format gagal: status false + error/code (tidak melempar exception). */
function fail(err, extra) {
  return Object.assign(
    {
      status: false,
      title: '',
      destination: '',
      direct_link: '',
      error: err && err.message ? err.message : String(err),
      code: (err && err.code) || 'E_UNKNOWN',
    },
    extra
  );
}

module.exports = {
  DEFAULTS,
  REDIRECT_CODES,
  BypassError,
  sleep,
  lowerKeys,
  request,
  requestWithFallback,
  isHttpUrl,
  isPrivateHost,
  resolveUrl,
  hostOf,
  safeDecodeURIComponent,
  base64Decode,
  extractUrlFromBase64,
  decodeHtmlEntities,
  unescapeJs,
  parseAttrs,
  getMeta,
  extractTitle,
  parseHeaderInfo,
  ok,
  fail,
};
