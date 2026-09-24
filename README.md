# native-bypasser

Utility Link Resolver **100% native Node.js, zero dependency**. Menelusuri URL redirect, membaca header HTTP, dan mengekstrak URL tujuan dari landing page / MediaFire secara programmatic. Ringan untuk lingkungan terisolasi seperti **Termux/Android**.

- Tanpa library NPM luar. Hanya modul inti Node.js: `https`, `http`, `url`, `crypto`, `buffer` (+ `zlib` bawaan untuk dekompresi gzip/deflate).
- Parsing berbasis regex, auto-redirect tracker (301/302/303/307/308), dekoder Base64 internal.
- Resilience handler: retry + backoff + rotasi header + endpoint cadangan saat timeout/akses dibatasi.
- Output selalu berupa JSON object yang rapi. Tidak melempar exception.

## Instalasi

```bash
npm install github:SanzzEditor/native-bypasser
```

Butuh Node.js `>= 14.17`.

## Pemakaian cepat

```js
const bypasser = require('native-bypasser');

(async () => {
  // Auto-detect: MediaFire -> extractor, selain itu -> resolver landing page
  const res = await bypasser.resolve('https://www.mediafire.com/file/abc123/file.zip/file');
  console.log(JSON.stringify(res, null, 2));
})();
```

Contoh CLI cepat di Termux:

```bash
node -e "require('native-bypasser').resolve(process.argv[1]).then(r=>console.log(JSON.stringify(r,null,2)))" "https://contoh.com/link"
```

## Format output

```json
{
  "status": true,
  "title": "Nama halaman / nama file",
  "destination": "https://tujuan-yang-diekstrak",
  "direct_link": "https://link-langsung-akhir",
  "meta": {}
}
```

| Field | Arti |
|---|---|
| `status` | `true` bila berhasil, `false` bila gagal |
| `title` | Judul halaman tujuan, atau nama file (MediaFire) |
| `destination` | URL tujuan yang ditemukan (redirect: URL akhir; MediaFire: halaman file) |
| `direct_link` | URL langsung akhir setelah semua redirect (MediaFire: link download) |
| `meta` | Info tambahan: rantai redirect, header, ukuran file, dll |

Bila gagal: `{ status: false, title: '', destination: '', direct_link: '', error: 'pesan', code: 'E_...', meta }`.

## API

Semua fungsi `async` dan selalu resolve (tidak reject).

| Fungsi | Keterangan |
|---|---|
| `resolve(url, opts)` | Auto-detect. Paksa dengan `opts.type`: `'mediafire'`, `'unsub'`, `'redirect'` |
| `redirect(url, opts)` | Tracer header `Location`. `meta.chain` berisi tiap hop `{ url, status, location }` |
| `headers(url, opts)` | Info header (HEAD, otomatis fallback GET tanpa body). `meta`: `contentType`, `contentLength`, `filename`, `lastModified`, `server` |
| `unsub(url, opts)` | Resolver landing page: query/hash (plain, percent-encoded, Base64), meta refresh, `location.*`, `atob()`, anchor/tombol `download/continue/skip`, atribut `data-*` |
| `mediafire(url, opts)` | Nama file, ukuran, dan direct download link (mendukung `data-scrambled-url` Base64) |
| `utils` | Helper: `request`, `requestWithFallback`, `base64Decode`, `extractUrlFromBase64`, `parseAttrs`, dll |

```js
const { redirect, headers, unsub, mediafire } = require('native-bypasser');

await redirect('https://bit.ly/xxxx');
await headers('https://contoh.com/file.zip');
await unsub('https://landing.contoh.com/go?url=aHR0cHM6Ly9leGFtcGxlLmNvbQ==');
await mediafire('https://www.mediafire.com/file/abc123/nama.zip/file', { verify: true });
```

### Opsi

| Opsi | Default | Keterangan |
|---|---|---|
| `timeout` | `15000` | Batas waktu total per request (ms) |
| `maxBytes` | `2097152` | Batas body yang di-buffer (hemat RAM) |
| `retries` | `2` | Percobaan ulang tambahan (resilience) |
| `retryDelay` | `500` | Dasar backoff eksponensial (ms) |
| `maxRedirects` | `10` | Batas hop redirect |
| `headers` | `{}` | Header kustom (menimpa header bawaan) |
| `fallbackUrls` | `[]` | Endpoint cadangan bila endpoint utama gagal |
| `family` | - | Paksa `4` (IPv4) atau `6` |
| `allowPrivate` | `false` | Izinkan host lokal/privat (localhost, 192.168.x.x, dst) |

Khusus `unsub`: `fetch` (`true`; `false` = hanya decode query tanpa jaringan), `followFinal` (`true`), `maxDepth` (`3`), `minScore` (`50`).
Khusus `mediafire`: `verify` (`false`; `true` = HEAD ke direct link untuk ukuran/tipe asli), `allowedHosts` (`['mediafire.com']`).

## Resilience handler

`utils.requestWithFallback(url, opts)` dipakai oleh semua modul:

1. Retry otomatis saat timeout, koneksi putus, atau akses dibatasi (`403`, `408`, `429`, `5xx`).
2. Backoff eksponensial + jitter (`crypto.randomInt`), menghormati header `Retry-After`.
3. Rotasi profil header per percobaan: desktop, lalu mobile + IPv4, lalu minimal.
4. Lanjut ke `fallbackUrls` bila endpoint utama gagal total.
5. Bila hanya ada respons HTTP (mis. 403), respons terakhir dikembalikan apa adanya.

## Keamanan

- Hanya `http`/`https`. Host lokal/privat **diblokir secara default** (juga di setiap hop redirect) untuk mencegah SSRF. Cek ini hanya pada literal host, bukan pengganti firewall. Set `allowPrivate: true` bila memang perlu.
- Body dibatasi `maxBytes`, dekompresi dibatasi, TLS selalu diverifikasi.
- Hasil Base64 hanya diterima bila berupa URL `http(s)` valid. Link download MediaFire hanya diterima dari domain `mediafire.com`.
- Cookie hanya dikirim ke host asalnya selama satu penelusuran.

## Batasan

- Tidak menjalankan JavaScript, tidak menembus captcha/login. Hanya membaca respons HTTP publik.
- HTTP/1.1 saja (modul `http`/`https` bawaan).
- Struktur halaman situs pihak ketiga bisa berubah; ekstraksi bersifat best-effort. Link folder MediaFire belum didukung.
- Gunakan sesuai hukum dan ketentuan layanan situs yang diakses.

## Struktur repo

```
native-bypasser/
├── package.json
├── index.js            # entry point
├── README.md
└── lib/
    ├── utils.js        # helper HTTP native, fallback, Base64, parser HTML
    ├── redirect.js     # tracer header Location
    ├── unsub.js        # resolver landing page
    └── mediafire.js    # extractor MediaFire
```

## Lisensi

MIT License

Copyright (c) 2026 SanzzEditor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
