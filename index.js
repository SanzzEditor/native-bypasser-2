'use strict';

/**
 * native-bypasser - Utility Link Resolver 100% native Node.js (zero dependency).
 * Semua fungsi async dan TIDAK melempar exception; hasilnya selalu object:
 *   { status: true,  title, destination, direct_link, meta }
 *   { status: false, title:'', destination:'', direct_link:'', error, code, meta }
 */

const utils = require('./lib/utils');
const redirect = require('./lib/redirect');
const unsub = require('./lib/unsub');
const mediafire = require('./lib/mediafire');
const pkg = require('./package.json');

/**
 * Auto-detect: MediaFire -> extractor MediaFire, selain itu -> resolver landing page.
 * Paksa mode lewat options.type: 'mediafire' | 'unsub' | 'redirect'.
 */
async function resolve(url, options) {
  const o = options || {};
  if (!utils.isHttpUrl(url)) {
    return utils.fail(new utils.BypassError(`URL tidak valid: ${url}`, 'E_INVALID_URL'));
  }
  const type = o.type || (/(^|\.)mediafire\.com$/i.test(utils.hostOf(url)) ? 'mediafire' : 'unsub');
  if (type === 'mediafire') return mediafire.resolve(url, o);
  if (type === 'redirect') return redirect.trace(url, o);
  return unsub.resolve(url, o);
}

module.exports = {
  version: pkg.version,
  resolve, // auto-detect
  redirect: redirect.trace, // telusuri header Location (301/302/303/307/308)
  headers: redirect.headers, // info header HTTP (HEAD, fallback GET)
  unsub: unsub.resolve, // resolver landing page
  mediafire: mediafire.resolve, // extractor MediaFire
  utils, // helper: request, requestWithFallback, base64Decode, ...
};
