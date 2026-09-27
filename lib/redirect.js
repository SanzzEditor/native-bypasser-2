'use strict';

/**
 * lib/redirect.js
 * HTTP Location header tracer: mengikuti 301/302/303/307/308 secara manual,
 * mendeteksi loop, membawa cookie per-host, dan mengembalikan info header.
 */

const { URL } = require('url');
const {
  BypassError, REDIRECT_CODES, requestWithFallback, resolveUrl, isHttpUrl,
  hostOf, lowerKeys, parseHeaderInfo, extractTitle, ok, fail,
} = require('./utils');

const HEAD_FALLBACK = new Set([400, 403, 405, 501]);

function parseSetCookie(list) {
  const out = {};
  [].concat(list || []).forEach((line) => {
    const pair = String(line).split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  });
  return out;
}

/**
 * Level rendah: telusuri redirect sampai respons final.
 * Opsi: maxRedirects (10), method ('GET'|'HEAD'), fallbackUrls (hop pertama),
 *       headers, + semua opsi request().
 * Return: { chain: [{url,status,location}], response, finalUrl }
 */
async function follow(startUrl, options) {
  const o = Object.assign({ maxRedirects: 10, method: 'GET' }, options);
  const userHeaders = lowerKeys(o.headers);
  const jar = {}; // host -> { nama: nilai }
  const seen = new Set();
  const chain = [];
  let current;
  try {
    current = new URL(startUrl).href;
  } catch (e) {
    current = String(startUrl);
  }

  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    const stored = jar[hostOf(current)] || {};
    const cookie = [userHeaders.cookie]
      .concat(Object.keys(stored).map((k) => `${k}=${stored[k]}`))
      .filter(Boolean)
      .join('; ');

    // loop = URL sama dengan kondisi cookie sama (redirect pemasang cookie tetap diizinkan)
    const signature = `${current}|${cookie}`;
    if (seen.has(signature)) {
      throw new BypassError(`Redirect loop terdeteksi: ${current}`, 'E_REDIRECT_LOOP', { chain });
    }
    seen.add(signature);

    const reqOpts = Object.assign({}, o, {
      headers: Object.assign({}, userHeaders, cookie ? { cookie } : {}),
      fallbackUrls: hop === 0 ? o.fallbackUrls : undefined,
    });

    let res = await requestWithFallback(current, reqOpts);
    if (o.method === 'HEAD' && HEAD_FALLBACK.has(res.statusCode)) {
      res = await requestWithFallback(
        current,
        Object.assign({}, reqOpts, { method: 'GET', headersOnly: true })
      );
    }

    const host = hostOf(res.url);
    const fresh = parseSetCookie(res.headers['set-cookie']);
    if (Object.keys(fresh).length) jar[host] = Object.assign({}, jar[host], fresh);

    const location = res.headers.location;
    chain.push({ url: res.url, status: res.statusCode, location: location || null });

    if (REDIRECT_CODES.has(res.statusCode) && location) {
      const next = resolveUrl(res.url, location);
      if (!next || !isHttpUrl(next)) {
        throw new BypassError(`Header Location tidak valid: ${location}`, 'E_BAD_LOCATION', { chain });
      }
      current = next;
      continue;
    }
    return { chain, response: res, finalUrl: res.url };
  }
  throw new BypassError(`Terlalu banyak redirect (maks ${o.maxRedirects})`, 'E_MAX_REDIRECTS', { chain });
}

/** Telusuri redirect & kembalikan { status, title, destination, direct_link, meta }. */
async function trace(url, options) {
  try {
    const { chain, response, finalUrl } = await follow(url, options);
    const info = parseHeaderInfo(response.headers);
    return ok({
      title: extractTitle(response.body) || info.filename,
      destination: finalUrl,
      direct_link: finalUrl,
      meta: Object.assign({ hops: chain.length - 1, statusCode: response.statusCode }, info, { chain }),
    });
  } catch (err) {
    return fail(err, { meta: { chain: err.chain || [] } });
  }
}

/** Ambil info header saja (HEAD, otomatis fallback ke GET tanpa body bila HEAD ditolak). */
function headers(url, options) {
  return trace(url, Object.assign({ method: 'HEAD', headersOnly: true }, options));
}

module.exports = { follow, trace, headers };
