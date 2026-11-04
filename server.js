const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set to a unique random value of at least 32 characters.');
  process.exit(1);
}
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) {
  console.error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');
  process.exit(1);
}

const db = new Database(process.env.DB_FILE || path.join(ROOT, 'cms.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    start_date TEXT NOT NULL, end_date TEXT NOT NULL, registration_deadline TEXT NOT NULL,
    distances_json TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id), code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, distance TEXT NOT NULL, shirt TEXT NOT NULL,
    address TEXT NOT NULL, amount INTEGER NOT NULL, promo TEXT, status TEXT NOT NULL DEFAULT 'pending',
    stripe_session_id TEXT UNIQUE, ticket_sent_at TEXT, strava_athlete_id TEXT, strava_access_token TEXT,
    strava_refresh_token TEXT, strava_expires_at INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, registration_id INTEGER NOT NULL REFERENCES registrations(id),
    source TEXT NOT NULL, external_id TEXT, distance_m REAL, moving_time_s INTEGER, activity_date TEXT,
    proof_path TEXT, status TEXT NOT NULL DEFAULT 'submitted', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(registration_id, source, external_id)
  );
  CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, registration_id INTEGER NOT NULL REFERENCES registrations(id), expires_at INTEGER NOT NULL);
`);

const adminEmail = process.env.ADMIN_EMAIL.toLowerCase();
const adminExists = db.prepare('SELECT id FROM admins WHERE email = ?').get(adminEmail);
if (!adminExists) {
  db.prepare('INSERT INTO admins (email, password_hash) VALUES (?, ?)').run(adminEmail, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12));
}
if (!db.prepare('SELECT id FROM events LIMIT 1').get()) {
  db.prepare(`INSERT INTO events (slug,name,description,start_date,end_date,registration_deadline,distances_json,active)
    VALUES (?,?,?,?,?,?,?,1)`).run('langkah-bersama-virtual-run', 'LangkahBersama Virtual Run',
    'Berlari dari mana saja. Pilih tantangan, bergerak bersama, dan kirim aktivitas larimu.',
    '2026-07-12', '2026-07-18', '2026-06-30', JSON.stringify({'3K':99000,'5K':139000,'10K':179000}));
}

const StripeStore = SQLiteStoreFactory(session);
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(session({
  store: new StripeStore({ db: 'sessions.sqlite', dir: ROOT }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: 'draft-7', legacyHeaders: false });
app.use('/api/', apiLimiter);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true', auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Silakan masuk sebagai admin.' });
  next();
}
function text(value, max = 250) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function makeCode() { return `LB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; }
function eventView(row) { return { ...row, distances: JSON.parse(row.distances_json), active: !!row.active }; }
function safeSlug(value) {
  return text(value, 100).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }

// Stripe requires the unmodified request body to verify webhook signatures.
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch (err) { console.warn('Invalid Stripe webhook signature:', err.message); return res.sendStatus(400); }

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const checkout = event.data.object;
    if (checkout.payment_status === 'paid') {
      const registration = db.prepare('SELECT * FROM registrations WHERE id = ?').get(Number(checkout.metadata?.registration_id));
      if (registration && registration.status !== 'paid') {
        db.prepare("UPDATE registrations SET status='paid', stripe_session_id=? WHERE id=?").run(checkout.id, registration.id);
        try { await sendTicket(registration.code); }
        catch (err) { console.error('Ticket email failed; admin can retry by contacting the participant:', err); }
      }
    }
  }
  if (event.type === 'checkout.session.async_payment_failed') {
    const checkout = event.data.object;
    db.prepare("UPDATE registrations SET status='payment_failed' WHERE id=? AND status='pending'").run(Number(checkout.metadata?.registration_id));
  }
  res.json({ received: true });
});
app.use(express.json({ limit: '30kb' }));

async function ticketBuffer(registration) {
  const event = db.prepare('SELECT name,start_date,end_date FROM events WHERE id=?').get(registration.event_id);
  const qr = await QRCode.toBuffer(`${BASE_URL}/track/${registration.code}`, { type: 'png', width: 180, margin: 1 });
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 36 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.rect(0, 0, 600, 150).fill('#10251d');
    doc.fillColor('#c9f36a').fontSize(11).text('VIRTUAL RUN EVENT', 36, 34);
    doc.fillColor('#fff').fontSize(23).text(event.name, 36, 57, { width: 310 });
    doc.fillColor('#d4ddd6').fontSize(10).text(`${event.start_date} — ${event.end_date}`, 36, 116);
    doc.fillColor('#10251d').fontSize(10).text('NAMA PESERTA', 36, 174);
    doc.fontSize(17).text(registration.name, 36, 191, { width: 300 });
    doc.fontSize(10).text('KODE TIKET', 36, 235);
    doc.fontSize(16).text(registration.code, 36, 252);
    doc.fontSize(10).text('KATEGORI', 36, 291);
    doc.fontSize(15).text(registration.distance, 36, 308);
    doc.image(qr, 345, 178, { width: 115 });
    doc.fillColor('#46621d').fontSize(10).text('PEMBAYARAN TERKONFIRMASI', 36, 360);
    doc.fillColor('#6d756e').fontSize(9).text('Tunjukkan QR/kode tiket kepada panitia. Gunakan halaman pelacakan untuk mengirim aktivitas.', 36, 382, { width: 390 });
    doc.end();
  });
}
async function sendTicket(code) {
  const registration = db.prepare("SELECT * FROM registrations WHERE code=? AND status='paid'").get(code);
  if (!registration) throw new Error('Registration is not paid.');
  const pdf = await ticketBuffer(registration);
  if (mailer) {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: registration.email,
      subject: `Tiket virtual run ${registration.code}`,
      text: `Halo ${registration.name}, pembayaran sudah terkonfirmasi. Tiket terlampir. Kode tiket: ${registration.code}. Pantau aktivitas: ${BASE_URL}/track/${registration.code}`,
      attachments: [{ filename: `tiket-${registration.code}.pdf`, content: pdf, contentType: 'application/pdf' }]
    });
    db.prepare('UPDATE registrations SET ticket_sent_at=CURRENT_TIMESTAMP WHERE id=?').run(registration.id);
  } else {
    console.warn(`SMTP not configured: paid ticket ${code} generated but could not be emailed.`);
  }
  return pdf;
}

app.get('/api/events/active', (req, res) => {
  const event = db.prepare('SELECT * FROM events WHERE active=1 ORDER BY id DESC LIMIT 1').get();
  if (!event) return res.status(404).json({ error: 'Belum ada event aktif.' });
  res.json(eventView(event));
});
app.post('/api/registrations', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Pembayaran online belum dikonfigurasi. Admin perlu memasang Stripe.' });
  const eventId = Number(req.body.event_id);
  const event = db.prepare('SELECT * FROM events WHERE id=? AND active=1').get(eventId);
  if (!event) return res.status(400).json({ error: 'Event tidak aktif atau tidak ditemukan.' });
  if (event.registration_deadline < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Pendaftaran event sudah ditutup.' });
  const name = text(req.body.name, 100), email = text(req.body.email, 160).toLowerCase();
  const phone = text(req.body.phone, 30), address = text(req.body.address, 300);
  const distance = text(req.body.distance, 12), shirt = text(req.body.shirt, 5);
  const promo = text(req.body.promo, 30).toUpperCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !phone || !address) return res.status(400).json({ error: 'Periksa kembali data wajib dan format email.' });
  if (!['S','M','L','XL','XXL'].includes(shirt)) return res.status(400).json({ error: 'Ukuran kaos tidak valid.' });
  const distances = JSON.parse(event.distances_json);
  if (!Object.hasOwn(distances, distance) || !Number.isSafeInteger(distances[distance]) || distances[distance] < 1000) return res.status(400).json({ error: 'Kategori jarak tidak valid.' });
  if (promo && promo !== 'LARI10') return res.status(400).json({ error: 'Kode promo tidak valid.' });
  const amount = promo === 'LARI10' ? Math.round(distances[distance] * 0.9) : distances[distance];
  const code = makeCode();
  const result = db.prepare(`INSERT INTO registrations(event_id,code,name,email,phone,distance,shirt,address,amount,promo)
    VALUES(@event_id,@code,@name,@email,@phone,@distance,@shirt,@address,@amount,@promo)`).run({ event_id:event.id,code,name,email,phone,distance,shirt,address,amount,promo:promo || null });
  try {
    const checkout = await stripe.checkout.sessions.create({
      mode: 'payment', customer_email: email,
      line_items: [{ quantity: 1, price_data: { currency: 'idr', unit_amount: amount, product_data: { name: `${event.name} — ${distance}`, description: `Pendaftaran ${code}` } } }],
      metadata: { registration_id: String(result.lastInsertRowid), registration_code: code },
      success_url: `${BASE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?payment=cancelled`
    });
    db.prepare('UPDATE registrations SET stripe_session_id=? WHERE id=?').run(checkout.id, result.lastInsertRowid);
    res.status(201).json({ checkoutUrl: checkout.url, code });
  } catch (err) {
    db.prepare("UPDATE registrations SET status='checkout_error' WHERE id=?").run(result.lastInsertRowid);
    console.error('Stripe checkout creation failed:', err.message);
    res.status(502).json({ error: 'Tidak dapat memulai pembayaran. Silakan coba kembali.' });
  }
});
app.get('/api/payment-status', async (req, res) => {
  if (!stripe || !req.query.session_id) return res.status(400).json({ error: 'Sesi pembayaran tidak valid.' });
  try {
    const checkout = await stripe.checkout.sessions.retrieve(text(req.query.session_id, 200));
    res.json({ paid: checkout.payment_status === 'paid', status: checkout.payment_status });
  } catch { res.status(404).json({ error: 'Sesi pembayaran tidak ditemukan.' }); }
});
app.get('/api/tickets/:code.pdf', async (req, res) => {
  const registration = db.prepare("SELECT * FROM registrations WHERE code=? AND status='paid'").get(text(req.params.code, 30).toUpperCase());
  if (!registration) return res.status(404).send('Tiket belum tersedia. Pastikan pembayaran sudah terkonfirmasi.');
  try {
    const pdf = await ticketBuffer(registration);
    res.type('application/pdf').attachment(`tiket-${registration.code}.pdf`).send(pdf);
  } catch (err) { console.error(err); res.status(500).send('Tiket gagal dibuat.'); }
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024, files: 1 }, fileFilter: (req, file, cb) => {
  const allowed = new Set(['image/jpeg','image/png','application/pdf']);
  if (!allowed.has(file.mimetype)) return cb(new Error('File harus berupa JPG, PNG, atau PDF.'));
  cb(null, true);
} });
app.get('/track/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'track.html')));
app.get('/api/track/:code', (req, res) => {
  const reg = db.prepare(`SELECT r.code,r.name,r.distance,r.status,e.name AS event_name,e.start_date,e.end_date
    FROM registrations r JOIN events e ON e.id=r.event_id WHERE r.code=?`).get(text(req.params.code,30).toUpperCase());
  if (!reg) return res.status(404).json({ error: 'Pendaftaran tidak ditemukan.' });
  if (reg.status !== 'paid') return res.status(402).json({ error: 'Pelacakan aktivitas aktif setelah tiket dibayar.' });
  const activities = db.prepare(`SELECT source,distance_m,moving_time_s,activity_date,status,created_at FROM activities WHERE registration_id=? ORDER BY created_at DESC`).all(
    db.prepare('SELECT id FROM registrations WHERE code=?').get(reg.code).id);
  res.json({ ...reg, activities, stravaConfigured: !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET) });
});
app.post('/api/track/:code/upload', upload.single('proof'), (req, res) => {
  const reg = db.prepare("SELECT id FROM registrations WHERE code=? AND status='paid'").get(text(req.params.code,30).toUpperCase());
  if (!reg) { if (req.file) fs.unlinkSync(req.file.path); return res.status(404).json({ error: 'Tiket tidak ditemukan atau belum dibayar.' }); }
  if (!req.file) return res.status(400).json({ error: 'Pilih file bukti aktivitas.' });
  db.prepare('INSERT INTO activities(registration_id,source,proof_path) VALUES(?,?,?)').run(reg.id,'upload',req.file.filename);
  res.status(201).json({ message: 'Bukti aktivitas berhasil dikirim.' });
});
app.get('/uploads/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const exists = db.prepare('SELECT id FROM activities WHERE proof_path=?').get(filename);
  if (!exists) return res.sendStatus(404);
  res.sendFile(path.join(UPLOAD_DIR, filename));
});

app.get('/api/strava/connect/:code', (req, res) => {
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) return res.status(503).send('Integrasi Strava belum dikonfigurasi.');
  const reg = db.prepare("SELECT id FROM registrations WHERE code=? AND status='paid'").get(text(req.params.code,30).toUpperCase());
  if (!reg) return res.status(404).send('Tiket tidak ditemukan atau belum dibayar.');
  const state = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO oauth_states(state,registration_id,expires_at) VALUES(?,?,?)').run(state,reg.id,Date.now()+10*60*1000);
  const query = new URLSearchParams({ client_id:process.env.STRAVA_CLIENT_ID,redirect_uri:`${BASE_URL}/api/strava/callback`,response_type:'code',approval_prompt:'auto',scope:'read,activity:read_all',state });
  res.redirect(`https://www.strava.com/oauth/authorize?${query}`);
});
app.get('/api/strava/callback', async (req, res) => {
  const state = text(req.query.state,100);
  const saved = db.prepare('SELECT * FROM oauth_states WHERE state=? AND expires_at>?').get(state,Date.now());
  db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
  if (!saved || !req.query.code || req.query.error) return res.status(400).send('Koneksi Strava dibatalkan atau kedaluwarsa. Kembali ke halaman aktivitas.');
  try {
    const response = await fetch('https://www.strava.com/oauth/token', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.STRAVA_CLIENT_ID,client_secret:process.env.STRAVA_CLIENT_SECRET,code:text(req.query.code,500),grant_type:'authorization_code'}) });
    const token = await response.json();
    if (!response.ok || !token.athlete?.id) throw new Error(token.message || 'Strava token exchange failed');
    db.prepare(`UPDATE registrations SET strava_athlete_id=?,strava_access_token=?,strava_refresh_token=?,strava_expires_at=? WHERE id=?`)
      .run(String(token.athlete.id),token.access_token,token.refresh_token,token.expires_at,saved.registration_id);
    res.redirect(`/track/${db.prepare('SELECT code FROM registrations WHERE id=?').get(saved.registration_id).code}?strava=connected`);
  } catch (err) { console.error('Strava OAuth error:',err.message); res.status(502).send('Gagal menghubungkan Strava. Silakan coba kembali.'); }
});
app.post('/api/strava/sync/:code', async (req, res) => {
  const reg = db.prepare(`SELECT r.*,e.start_date,e.end_date FROM registrations r JOIN events e ON e.id=r.event_id
    WHERE r.code=? AND r.status='paid'`).get(text(req.params.code,30).toUpperCase());
  if (!reg || !reg.strava_refresh_token) return res.status(400).json({ error:'Hubungkan akun Strava terlebih dahulu.' });
  try {
    let access = reg.strava_access_token;
    if (reg.strava_expires_at <= Math.floor(Date.now()/1000)+60) {
      const refreshResponse = await fetch('https://www.strava.com/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_id:process.env.STRAVA_CLIENT_ID,client_secret:process.env.STRAVA_CLIENT_SECRET,grant_type:'refresh_token',refresh_token:reg.strava_refresh_token})});
      const refreshed = await refreshResponse.json();
      if (!refreshResponse.ok) throw new Error('Strava token refresh failed');
      access = refreshed.access_token;
      db.prepare('UPDATE registrations SET strava_access_token=?,strava_refresh_token=?,strava_expires_at=? WHERE id=?').run(access,refreshed.refresh_token,refreshed.expires_at,reg.id);
    }
    const after = Math.floor(new Date(`${reg.start_date}T00:00:00Z`).getTime()/1000);
    const before = Math.floor(new Date(`${reg.end_date}T23:59:59Z`).getTime()/1000);
    const activitiesResponse = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&before=${before}&per_page=100`,{headers:{Authorization:`Bearer ${access}`}});
    const activities = await activitiesResponse.json();
    if (!activitiesResponse.ok || !Array.isArray(activities)) throw new Error('Could not read Strava activities');
    const insert = db.prepare(`INSERT OR IGNORE INTO activities(registration_id,source,external_id,distance_m,moving_time_s,activity_date,status)
      VALUES(?,?,?,?,?,?,'submitted')`);
    const insertMany = db.transaction(items => { let count=0; for (const a of items) { if (['Run','Walk','VirtualRun'].includes(a.type)) count += insert.run(reg.id,'strava',String(a.id),a.distance,a.moving_time,a.start_date).changes; } return count; });
    res.json({ imported:insertMany(activities), checked:activities.length });
  } catch (err) { console.error('Strava sync error:',err.message); res.status(502).json({error:'Sinkronisasi gagal. Coba lagi nanti.'}); }
});

app.get('/admin', (req,res) => res.sendFile(path.join(ROOT,'public','admin.html')));
app.post('/api/admin/login', rateLimit({windowMs:15*60*1000,limit:8}), async (req,res) => {
  const email = text(req.body.email,160).toLowerCase();
  const admin = db.prepare('SELECT * FROM admins WHERE email=?').get(email);
  if (!admin || !(await bcrypt.compare(String(req.body.password || ''),admin.password_hash))) return res.status(401).json({error:'Email atau kata sandi salah.'});
  req.session.adminId = admin.id;
  res.json({ok:true});
});
app.post('/api/admin/logout', requireAdmin, (req,res) => req.session.destroy(() => res.json({ok:true})));
app.get('/api/admin/me', requireAdmin, (req,res) => res.json({ok:true}));
app.get('/api/admin/events', requireAdmin, (req,res) => res.json(db.prepare('SELECT * FROM events ORDER BY id DESC').all().map(eventView)));
app.post('/api/admin/events', requireAdmin, (req,res) => {
  const name=text(req.body.name,120), slug=safeSlug(req.body.slug || req.body.name);
  const start=text(req.body.start_date,10), end=text(req.body.end_date,10), deadline=text(req.body.registration_deadline,10);
  const description=text(req.body.description,2000), distances=req.body.distances;
  if (!name || !slug || !validDate(start)||!validDate(end)||!validDate(deadline)||end<start||!distances||typeof distances!=='object'||Array.isArray(distances)) return res.status(400).json({error:'Periksa nama, slug, tanggal, dan kategori harga.'});
  const cleanPrices={};
  for (const [label,price] of Object.entries(distances)) { if (!/^\d{1,3}K$/.test(label)||!Number.isSafeInteger(Number(price))||Number(price)<1000) return res.status(400).json({error:'Jarak/harga tidak valid.'}); cleanPrices[label]=Number(price); }
  try {
    const info=db.prepare('INSERT INTO events(slug,name,description,start_date,end_date,registration_deadline,distances_json) VALUES(?,?,?,?,?,?,?)')
      .run(slug,name,description,start,end,deadline,JSON.stringify(cleanPrices));
    res.status(201).json(eventView(db.prepare('SELECT * FROM events WHERE id=?').get(info.lastInsertRowid)));
  } catch { res.status(409).json({error:'Slug event sudah digunakan.'}); }
});
app.put('/api/admin/events/:id', requireAdmin, (req,res) => {
  const id=Number(req.params.id), current=db.prepare('SELECT * FROM events WHERE id=?').get(id);
  if (!current) return res.sendStatus(404);
  const name=text(req.body.name,120), slug=safeSlug(req.body.slug||req.body.name);
  const start=text(req.body.start_date,10), end=text(req.body.end_date,10), deadline=text(req.body.registration_deadline,10);
  const distances=req.body.distances;
  if (!name||!slug||!validDate(start)||!validDate(end)||!validDate(deadline)||end<start||!distances||typeof distances!=='object'||Array.isArray(distances)) return res.status(400).json({error:'Data event tidak valid.'});
  const cleanPrices={}; for(const [label,price] of Object.entries(distances)){if(!/^\d{1,3}K$/.test(label)||!Number.isSafeInteger(Number(price))||Number(price)<1000)return res.status(400).json({error:'Harga/jarak tidak valid.'});cleanPrices[label]=Number(price);}
  try { db.prepare('UPDATE events SET slug=?,name=?,description=?,start_date=?,end_date=?,registration_deadline=?,distances_json=? WHERE id=?')
    .run(slug,name,text(req.body.description,2000),start,end,deadline,JSON.stringify(cleanPrices),id); res.json(eventView(db.prepare('SELECT * FROM events WHERE id=?').get(id))); }
  catch {res.status(409).json({error:'Slug event sudah digunakan.'});}
});
app.post('/api/admin/events/:id/activate', requireAdmin, (req,res) => {
  const id=Number(req.params.id); if(!db.prepare('SELECT id FROM events WHERE id=?').get(id))return res.sendStatus(404);
  const tx=db.transaction(()=>{db.prepare('UPDATE events SET active=0').run();db.prepare('UPDATE events SET active=1 WHERE id=?').run(id);});tx();res.json({ok:true});
});
app.get('/api/admin/registrations', requireAdmin, (req,res) => {
  res.json(db.prepare(`SELECT r.id,r.code,r.name,r.email,r.phone,r.distance,r.amount,r.status,r.ticket_sent_at,r.created_at,e.name AS event_name,
    (SELECT COUNT(*) FROM activities a WHERE a.registration_id=r.id) AS activity_count FROM registrations r JOIN events e ON e.id=r.event_id ORDER BY r.created_at DESC LIMIT 1000`).all());
});
app.get('/api/admin/activities', requireAdmin, (req,res) => {
  res.json(db.prepare(`SELECT a.*,r.code,r.name,r.email,e.name AS event_name FROM activities a JOIN registrations r ON r.id=a.registration_id JOIN events e ON e.id=r.event_id ORDER BY a.created_at DESC LIMIT 1000`).all());
});
app.patch('/api/admin/activities/:id', requireAdmin, (req,res) => {
  const status=text(req.body.status,20);if(!['approved','rejected','submitted'].includes(status))return res.status(400).json({error:'Status tidak valid.'});
  const result=db.prepare('UPDATE activities SET status=? WHERE id=?').run(status,Number(req.params.id));if(!result.changes)return res.sendStatus(404);res.json({ok:true});
});
app.post('/api/admin/tickets/:code/resend', requireAdmin, async (req,res) => {
  try { const pdf=await sendTicket(text(req.params.code,30).toUpperCase()); if(!mailer)return res.status(503).json({error:'SMTP belum dikonfigurasi; email tidak terkirim.'});res.json({ok:true}); }
  catch(err){res.status(400).json({error:err.message});}
});
app.use((err,req,res,next)=>{ if(err instanceof multer.MulterError)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Ukuran file maksimal 8 MB.':'Upload tidak valid.'});if(err) return res.status(400).json({error:err.message||'Permintaan tidak valid.'});next(); });
app.listen(PORT,()=>console.log(`Virtual Run CMS listening on ${BASE_URL}`));
