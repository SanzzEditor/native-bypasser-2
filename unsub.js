'use strict';

/**
 * lib/unsub.js
 * Resolver landing page: membongkar URL tujuan dari
 *   (1) parameter query/hash (teks biasa, percent-encoded, atau Base64),
 *   (2) <meta http-equiv="refresh">, (3) redirect JavaScript (location.*, atob),
 *   (4) tombol/anchor & atribut data-* bertanda "download/continue/skip/...".
 * Semua berbasis regex (tanpa menjalankan JavaScript halaman).
 */

const { URL } = require('url');
const { follow } = require('./redirect');
const {
  BypassError, isHttpUrl, resolveUrl, hostOf, safeDecodeURIComponent, extractUrlFromBase64,
  decodeHtmlEntities, unescapeJs, parseAttrs, extractTitle, ok, fail,
} = require('./utils');

const KEYS = [
  'url', 'u', 'link', 'l', 'target', 'to', 'goto', 'go', 'dest', 'destination', 'redirect',
  'redirect_url', 'redirect_uri', 'redir', 'r', 'next', 'continue', 'out', 'href', 'data',
  'd', 'k', 'key', 'token', 't',
];
const HINT_RE = /download|continue|skip|get[\s_-]*link|go[\s_-]*to|proceed|unduh|lanjut|tujuan|buka|klik|redirect|destination|target|next/i;
const DATA_ATTRS = ['data-href', 'data-url', 'data-link', 'data-target', 'data-redirect', 'data-destination'];
const NOISE_HOST = /(^|\.)(w3\.org|schema\.org|google-analytics\.com|googletagmanager\.com|googleapis\.com|gstatic\.com|doubleclick\.net|jquery\.com|cloudflare\.com|cdnjs\.com|bootstrapcdn\.com)$/i;

/* ------------------------------ query / hash ------------------------------ */

function parsePairs(raw) {
  return String(raw || '')
    .replace(/^[?#]/, '')
    .split('&')
    .filter(Boolean)
    .map((pair) => {
      const i = pair.indexOf('=');
      return i < 0
        ? ['', pair]
        : [safeDecodeURIComponent(pair.slice(0, i)).toLowerCase(), pair.slice(i + 1)];
    });
}

function candidateFromValue(raw) {
  const once = safeDecodeURIComponent(raw);
  if (isHttpUrl(once)) return { url: once, base64: false };
  const twice = safeDecodeURIComponent(once);
  if (twice !== once && isHttpUrl(twice)) return { url: twice, base64: false };
  const b64 = extractUrlFromBase64(once);
  return b64 ? { url: b64, base64: true } : null;
}

/** Ekstrak URL tujuan dari query/hash tanpa request jaringan. Return { url, via } | null. */
function fromQuery(input) {
  let u;
  try {
    u = new URL(input);
  } catch (e) {
    return null;
  }
  const pairs = parsePairs(u.search).concat(parsePairs(u.hash));
  if (u.hash.length > 8) pairs.push(['', u.hash.slice(1)]);
  const rank = (k) => {
    const i = KEYS.indexOf(k);
    return i === -1 ? 999 : i;
  };
  pairs.sort((a, b) => rank(a[0]) - rank(b[0]));

  const own = u.hostname.toLowerCase();
  for (let i = 0; i < pairs.length; i++) {
    const key = pairs[i][0];
    const hit = pairs[i][1] ? candidateFromValue(pairs[i][1]) : null;
    if (hit && hostOf(hit.url) !== own) {
      return { url: hit.url, via: `query:${key || 'hash'}${hit.base64 ? '+base64' : ''}` };
    }
  }
  return null;
}

/* ------------------------------ parser HTML ------------------------------ */

function normalizeCandidate(raw, baseUrl) {
  const s = unescapeJs(decodeHtmlEntities(String(raw || ''))).trim();
  if (!s || /^(#|javascript:|mailto:|tel:|data:|about:|blob:)/i.test(s)) return null;
  const abs = resolveUrl(baseUrl, s);
  return abs && isHttpUrl(abs) && abs !== baseUrl ? abs : null;
}

/**
 * Kembalikan kandidat URL tujuan [{ url, via, score }] terurut dari skor tertinggi.
 * 100 meta-refresh | 95 js-location/atob | 90 literal Base64 | 75 data-* | 60 anchor berpetunjuk | 20 anchor lain
 */
function parseHtml(html, baseUrl) {
  const found = [];
  const src = String(html || '');
  if (!src) return found;
  const baseHost = hostOf(baseUrl);

  const add = (raw, via, score, external) => {
    const url = normalizeCandidate(raw, baseUrl);
    if (!url) return;
    const host = hostOf(url);
    if (score < 90 && NOISE_HOST.test(host)) return;
    if (external && host === baseHost) return;
    found.push({ url, via, score });
  };

  let m;

  // 1) <meta http-equiv="refresh" content="0; url=...">
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(src))) {
    const a = parseAttrs(m[0]);
    if (/^refresh$/i.test(a['http-equiv'] || '')) {
      const u = /url\s*=\s*['"]?\s*([^'";\s][^'";]*)/i.exec(a.content || '');
      if (u) add(u[1], 'meta-refresh', 100);
    }
  }

  // 2) location.href = "..." | location.replace("...") | location.assign("...")
  const locRe = /\blocation(?:\s*\.\s*(?:href|replace|assign))?\s*(?:=(?!=)|\()\s*["'`]([^"'`\s]{4,})["'`]/gi;
  while ((m = locRe.exec(src))) add(m[1], 'js-location', 95);

  // 3) atob("...") dan literal Base64 yang diawali "aHR0c" (= "http")
  const atobRe = /atob\(\s*["'`]([A-Za-z0-9+/_=-]{8,})["'`]\s*\)/gi;
  while ((m = atobRe.exec(src))) {
    const u = extractUrlFromBase64(m[1]);
    if (u) add(u, 'js-atob', 95);
  }
  const b64Re = /["'`](aHR0c[A-Za-z0-9+/_=-]{6,})["'`]/g;
  while ((m = b64Re.exec(src))) {
    const u = extractUrlFromBase64(m[1]);
    if (u) add(u, 'base64-literal', 90);
  }

  // 4) anchor (+ petunjuk id/class/teks) dan atribut data-*
  const anchorRe = /<a\b[^>]*>/gi;
  while ((m = anchorRe.exec(src))) {
    const a = parseAttrs(m[0]);
    const label = src
      .slice(anchorRe.lastIndex, anchorRe.lastIndex + 300)
      .split(/<\/a>/i)[0]
      .replace(/<[^>]*>/g, ' ');
    const hint = [a.id, a.class, a.rel, a.title, a['aria-label'], label].join(' ');
    if (a.href) add(a.href, 'anchor', HINT_RE.test(hint) ? 60 : 20, true);
    DATA_ATTRS.forEach((k) => {
      if (a[k]) add(a[k], `attr:${k}`, 75, false);
    });
  }
  const dataRe = /<(?!a\b)[a-z][a-z0-9]*\b[^>]*\sdata-(?:href|url|link|redirect|destination)\s*=[^>]*>/gi;
  while ((m = dataRe.exec(src))) {
    const a = parseAttrs(m[0]);
    DATA_ATTRS.forEach((k) => {
      if (a[k]) add(a[k], `attr:${k}`, 75, false);
    });
  }

  found.sort((x, y) => y.score - x.score);
  const seen = new Set();
  return found.filter((c) => (seen.has(c.url) ? false : seen.add(c.url)));
}

/* -------------------------------- resolver -------------------------------- */

/**
 * Bongkar landing page/redirect berlapis sampai URL tujuan akhir.
 * Opsi: fetch (true; false = hanya decode query offline), followFinal (true),
 *       maxDepth (3), minScore (50), + opsi follow()/request().
 * destination = URL tujuan yang diekstrak; direct_link = URL akhir setelah redirect.
 */
async function resolve(input, options) {
  const o = Object.assign({ fetch: true, followFinal: true, maxDepth: 3, minScore: 50 }, options);
  const fetchOpts = Object.assign({}, o, { method: 'GET', headersOnly: false });
  const steps = [];
  const visited = new Set();
  let chain = [];
  let title = '';
  let lastStatus = 0;
  let current = input;
  let destination = null;
  let settled = false; // true bila `current` sudah melewati follow()

  try {
    if (!isHttpUrl(input)) throw new BypassError(`URL tidak valid: ${input}`, 'E_INVALID_URL');

    for (let depth = 0; depth < o.maxDepth; depth++) {
      visited.add(current);
      settled = false;
      let hit = fromQuery(current);

      if (!hit && o.fetch) {
        const f = await follow(current, fetchOpts);
        chain = chain.concat(f.chain);
        lastStatus = f.response.statusCode;
        title = extractTitle(f.response.body) || title;
        settled = true;
        if (f.finalUrl !== current) {
          steps.push({ via: 'redirect', from: current, to: f.finalUrl });
          current = f.finalUrl;
          visited.add(current);
          hit = fromQuery(current);
        }
        if (!hit) {
          const min = depth === 0 ? o.minScore : Math.max(o.minScore, 80);
          hit = parseHtml(f.response.body, current).find((c) => c.score >= min && !visited.has(c.url)) || null;
        }
      }

      if (!hit || visited.has(hit.url)) break;
      steps.push({ via: hit.via, from: current, to: hit.url });
      destination = hit.url;
      current = hit.url;
      settled = false;
    }

    if (!destination && steps.length === 0) {
      const why = lastStatus >= 400 ? ` (HTTP ${lastStatus})` : '';
      throw new BypassError(`Tidak ada URL tujuan yang dapat diekstrak${why}`, 'E_NOT_FOUND');
    }

    let direct = current;
    if (o.fetch && o.followFinal && !settled) {
      const f = await follow(current, Object.assign({}, fetchOpts, { maxBytes: 256 * 1024 }));
      chain = chain.concat(f.chain);
      title = extractTitle(f.response.body) || title;
      direct = f.finalUrl;
    }

    return ok({
      title,
      destination: destination || current,
      direct_link: direct,
      meta: { steps, chain },
    });
  } catch (err) {
    return fail(err, { meta: { steps, chain: chain.concat(err.chain || []) } });
  }
}

module.exports = { resolve, parseHtml, fromQuery };
