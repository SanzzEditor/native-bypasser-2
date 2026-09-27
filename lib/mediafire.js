'use strict';

/**
 * lib/mediafire.js
 * Extractor informasi file & direct download link MediaFire.
 * Mendukung tombol download berupa href langsung maupun atribut
 * data-scrambled-url (URL disamarkan dengan Base64) lewat dekoder internal.
 */

const {
  BypassError, isHttpUrl, hostOf, resolveUrl, parseAttrs, getMeta, extractTitle,
  decodeHtmlEntities, extractUrlFromBase64, safeDecodeURIComponent, ok, fail,
} = require('./utils');
const { follow, headers: headInfo } = require('./redirect');

const KEY_PATTERNS = [
  /mediafire\.com\/(?:file|file_premium|view|download)\/([a-z0-9]+)/i,
  /mediafire\.com\/\?([a-z0-9]+)/i,
];
const GONE_RE = /invalid or deleted file|has been (?:deleted|removed)|key you provided for file download was invalid/i;

function quickKey(url) {
  for (let i = 0; i < KEY_PATTERNS.length; i++) {
    const m = KEY_PATTERNS[i].exec(String(url));
    if (m) return m[1];
  }
  return null;
}

const isMediafireHost = (url) => /(^|\.)mediafire\.com$/i.test(hostOf(url));

function stripTags(s) {
  return decodeHtmlEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse HTML halaman file MediaFire (tanpa jaringan).
 * Opsi: allowedHosts (default ['mediafire.com']) - link download di luar domain ini ditolak.
 * Return { direct_link, filename, size } atau melempar BypassError.
 */
function parse(html, pageUrl, options) {
  const hosts = (options && options.allowedHosts) || ['mediafire.com'];
  const allowed = (u) => {
    const h = hostOf(u);
    return hosts.some((d) => h === d || h.endsWith(`.${d}`));
  };
  const body = String(html || '');

  // 1) tombol download: data-scrambled-url (Base64) atau href langsung
  let link = null;
  const anchors = /<a\b[^>]*>/gi;
  let m;
  while (!link && (m = anchors.exec(body))) {
    const a = parseAttrs(m[0]);
    const scrambled = a['data-scrambled-url'];
    if (!(a.id === 'downloadButton' || scrambled || /download/i.test(a['aria-label'] || ''))) continue;
    const candidates = [];
    if (scrambled) candidates.push(extractUrlFromBase64(scrambled));
    if (a.href) candidates.push(resolveUrl(pageUrl, a.href));
    link = candidates.find((u) => u && isHttpUrl(u) && allowed(u)) || null;
  }

  // 2) fallback: URL server download di mana saja pada HTML
  if (!link) {
    const raw = /https?:\/\/download[\w-]*\.mediafire\.com\/[^\s"'<>\\]+/i.exec(body);
    if (raw) link = decodeHtmlEntities(raw[0]);
  }

  if (!link) {
    if (GONE_RE.test(body)) throw new BypassError('File tidak ditemukan atau sudah dihapus', 'E_FILE_GONE');
    throw new BypassError('Link download tidak ditemukan (halaman diproteksi atau markup berubah)', 'E_NOT_FOUND');
  }

  // nama file: elemen .filename -> label tombol -> og:title -> segmen URL -> <title>
  const pick = (re) => {
    const x = re.exec(body);
    return x ? stripTags(x[1]) : '';
  };
  let filename =
    pick(/<div[^>]*class=["'][^"']*\bfilename\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ||
    pick(/class=["'][^"']*dl-btn-label[^"']*["'][^>]*title=["']([^"']+)["']/i) ||
    getMeta(body, 'og:title');
  if (!filename) filename = safeDecodeURIComponent(link.split('?')[0].split('/').pop() || '');
  if (!filename) filename = extractTitle(body).replace(/\s*[-|]\s*MediaFire.*$/i, '');

  const sizeMatch =
    /Download\s*\(\s*([\d.,]+\s*[KMGT]?B)\s*\)/i.exec(body) ||
    /File\s*size:?\s*(?:<[^>]+>\s*)*([\d.,]+\s*[KMGT]?B)/i.exec(body);

  return { direct_link: link, filename, size: sizeMatch ? sizeMatch[1].replace(/\s+/g, '') : '' };
}

/**
 * Ambil info file & direct link dari URL MediaFire.
 * Opsi: verify (false; true = HEAD ke direct link untuk ukuran/tipe asli), allowedHosts,
 *       + opsi follow()/request() seperti timeout, retries, headers.
 * Hasil: { status, title: nama file, destination: halaman file, direct_link, meta }
 */
async function resolve(input, options) {
  const o = Object.assign({ verify: false }, options);
  try {
    if (!isHttpUrl(input) || !isMediafireHost(input)) {
      throw new BypassError('Bukan URL MediaFire yang valid', 'E_INVALID_URL');
    }
    if (/mediafire\.com\/folder\//i.test(input)) {
      throw new BypassError('Link folder MediaFire belum didukung', 'E_UNSUPPORTED');
    }

    const key = quickKey(input);
    const fallbackUrls = key
      ? [
          `https://www.mediafire.com/file/${key}/file`,
          `https://mediafire.com/file/${key}/file`,
          `https://www.mediafire.com/download/${key}`,
        ]
      : [];

    const f = await follow(input, Object.assign({}, o, { method: 'GET', headersOnly: false, fallbackUrls }));
    if (f.response.statusCode === 404 || f.response.statusCode === 410) {
      throw new BypassError('File tidak ditemukan atau sudah dihapus', 'E_FILE_GONE', { chain: f.chain });
    }

    const info = parse(f.response.body, f.finalUrl, o);
    const meta = {
      quickkey: key,
      filename: info.filename,
      ext: (/\.([A-Za-z0-9]{1,8})$/.exec(info.filename) || [])[1] || '',
      size: info.size,
      hops: f.chain.length - 1,
    };

    if (o.verify) {
      const h = await headInfo(info.direct_link, { timeout: o.timeout });
      if (h.status) {
        Object.assign(meta, {
          statusCode: h.meta.statusCode,
          contentType: h.meta.contentType,
          contentLength: h.meta.contentLength,
        });
      }
    }

    return ok({ title: info.filename, destination: f.finalUrl, direct_link: info.direct_link, meta });
  } catch (err) {
    return fail(err, { meta: { chain: err.chain || [] } });
  }
}

module.exports = { resolve, parse, quickKey };
