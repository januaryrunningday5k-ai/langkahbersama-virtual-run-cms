# Deploy ke cPanel Node.js App

Panduan ini untuk hosting cPanel yang menyediakan **Setup Node.js App** (umumnya dikelola Passenger). Aplikasi membutuhkan Node.js 20+ dan `better-sqlite3`, yang merupakan modul native. Jika cPanel Anda tidak menyediakan Node.js 20 atau instalasi modul native gagal, minta bantuan penyedia hosting atau gunakan VPS/hosting Node.js.

## 1. Siapkan cPanel

1. Arahkan domain/subdomain ke hosting dan aktifkan SSL/HTTPS terlebih dahulu.
2. Buka **Setup Node.js App** (nama menu bisa berbeda), buat aplikasi dengan Node.js **20 atau lebih baru**.
3. Gunakan application root di luar `public_html`, misalnya `langkahbersama-app`. Jangan arahkan document root web langsung ke root repository; file publik aplikasi disajikan melalui Express dari folder `public`.
4. Pilih URL domain/subdomain yang akan digunakan dan catat application root serta interpreter/virtual environment yang ditampilkan cPanel.
5. Atur startup file ke `server.js`. Jika cPanel menampilkan instruksi khusus Passenger atau perintah restart, ikuti instruksi panel tersebut.

## 2. Unggah kode dan pasang dependencies

Unggah/clone repository ke application root, lalu jalankan **Run NPM Install** dari panel atau Terminal cPanel pada folder aplikasi:

```sh
npm install --omit=dev
```

Jangan unggah `node_modules` dari komputer lokal. Bila instalasi `better-sqlite3` gagal, salin error lengkapnya untuk penyedia hosting—biasanya runtime/build tools yang dibutuhkan tidak tersedia.

## 3. Siapkan penyimpanan persisten

Buat direktori khusus yang tidak dapat diakses melalui web, di luar `public_html`, misalnya:

```text
/home/CPANEL_USER/langkahbersama-data/
```

Ganti `CPANEL_USER` dengan username cPanel Anda. Pastikan proses aplikasi berjalan sebagai pemilik direktori dan dapat menulis ke direktori tersebut. Jangan memberi izin `777`.

Di aplikasi ini database SQLite dapat diarahkan menggunakan `DB_FILE`. Atur nilainya menjadi path absolut, misalnya:

```text
/home/CPANEL_USER/langkahbersama-data/cms.db
```

Buat database belum perlu dilakukan secara manual; aplikasi membuat file dan tabel saat pertama kali berjalan. Namun, folder induknya harus sudah ada dan writable.

Folder unggahan (`uploads/`) dan file sesi SQLite (`sessions.sqlite`) saat ini berada di application root. Pastikan application root writable oleh user aplikasi dan tetap persisten ketika kode diperbarui. Jangan menaruh application root di dalam folder yang disajikan sebagai file publik.

## 4. Atur environment variables di panel

Tambahkan variabel melalui bagian **Environment variables** pada Setup Node.js App. cPanel tidak otomatis membaca `.env`; jangan mengandalkan `.env` kecuali Anda memang menambahkan mekanisme pemuatannya. Jangan commit file rahasia ke Git.

Atur minimal:

```dotenv
NODE_ENV=production
BASE_URL=https://domain-anda.com
DB_FILE=/home/CPANEL_USER/langkahbersama-data/cms.db
SESSION_SECRET=<nilai-acak-unik-minimal-32-karakter>
ADMIN_EMAIL=admin@domain-anda.com
ADMIN_PASSWORD=<kata-sandi-unik-minimal-12-karakter>
```

Ganti domain, username, dan kredensial contoh. Buat secret acak, misalnya dari Terminal:

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Jangan menetapkan `PORT` secara manual kecuali panel memintanya; cPanel/Passenger dapat menyediakan port internalnya. Aplikasi menggunakan `process.env.PORT`.

Untuk fitur tambahan, isi variabel yang sesuai di panel:

- **Pembayaran:** `STRIPE_SECRET_KEY` dan `STRIPE_WEBHOOK_SECRET`. Uji terlebih dahulu dengan kredensial Stripe test.
- **Email tiket/link akses:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, dan `MAIL_FROM`. Pastikan alamat pengirim/domain diverifikasi oleh penyedia email.
- **Integrasi Strava (opsional):** `STRAVA_CLIENT_ID` dan `STRAVA_CLIENT_SECRET`.

Simpan rahasia ini hanya di cPanel. Jangan menaruh nilai asli di commit, tiket publik, atau chat.

## 5. Jalankan dan uji

Simpan cấu hình di panel, restart aplikasi, lalu periksa log startup. Uji setidaknya:

- `https://domain-anda.com/` — halaman utama.
- `https://domain-anda.com/admin` — halaman admin.
- `https://domain-anda.com/api/events/active` — event aktif.
- Login admin dan pembuatan/pengelolaan event.
- Pendaftaran serta pembayaran Stripe dalam mode test, termasuk webhook bertanda tangan.
- Pengiriman email tiket melalui SMTP.
- Unggah bukti aktivitas dan koneksi Strava bila fitur itu digunakan.

Setelah domain HTTPS siap, daftarkan endpoint webhook Stripe berikut pada Stripe Dashboard:

```text
https://domain-anda.com/api/stripe/webhook
```

Pastikan event `checkout.session.completed` dan `checkout.session.expired` dikirimkan. Jangan beralih ke kredensial live sebelum seluruh alur test berhasil.

## 6. Backup dan batasan

Backup database dan folder `uploads/` secara berkala ke lokasi lain yang aman. SQLite ditujukan untuk satu instance aplikasi; jangan menjalankan beberapa instance bersamaan dengan database lokal yang sama. Jangan menghapus `cms.db`, `sessions.sqlite`, atau `uploads/` saat memperbarui kode.

Kalau aplikasi berhenti, periksa log cPanel untuk error runtime Node, izin tulis, path database, dan build `better-sqlite3`. Catat versi Node, error lengkap, serta langkah yang dilakukan saat meminta bantuan hosting—hapus dahulu secret/token dari log sebelum membagikannya.
