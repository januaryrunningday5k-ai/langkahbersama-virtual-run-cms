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
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE = 1000 * 60 * 60 * 8;
fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET must be a unique random value of at least 32 characters.');
if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12) throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters.');

const db = new Database(process.env.DB_FILE || path.join(ROOT, 'cms.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, end_date TEXT NOT NULL, registration_deadline TEXT NOT NULL, distances_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES events(id), code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, distance TEXT NOT NULL, shirt TEXT NOT NULL DEFAULT 'M', address TEXT NOT NULL DEFAULT '', promo TEXT NOT NULL DEFAULT '', amount INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', payment_session_id TEXT, ticket_pdf_path TEXT, ticket_sent_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, strava_athlete_id TEXT, strava_access_token TEXT, strava_refresh_token TEXT, strava_expires_at INTEGER);
  CREATE TABLE IF NOT EXISTS activities (id INTEGER PRIMARY KEY AUTOINCREMENT, registration_id INTEGER NOT NULL REFERENCES registrations(id), source TEXT NOT NULL, external_id TEXT, distance_m INTEGER, activity_date TEXT, proof_path TEXT, status TEXT NOT NULL DEFAULT 'submitted', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, registration_id INTEGER NOT NULL REFERENCES registrations(id), expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS participant_tokens (token_hash TEXT PRIMARY KEY, registration_id INTEGER NOT NULL REFERENCES registrations(id), expires_at INTEGER NOT NULL, used_at INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS ticket_mail_jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, registration_id INTEGER NOT NULL UNIQUE REFERENCES registrations(id), status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
`);
for (const [table, column, definition] of [
  ['registrations', 'ticket_sent_at', 'TEXT'],
  ['registrations', 'strava_athlete_id', 'TEXT'],
  ['registrations', 'strava_access_token', 'TEXT'],
  ['registrations', 'strava_refresh_token', 'TEXT'],
  ['registrations', 'strava_expires_at', 'INTEGER']
]) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
if (!db.prepare('SELECT id FROM admins WHERE email=?').get(adminEmail)) {
  db.prepare('INSERT INTO admins(email,password_hash) VALUES(?,?)').run(adminEmail, bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12));
}
if (!db.prepare('SELECT id FROM events LIMIT 1').get()) {
  db.prepare('INSERT INTO events(slug,name,description,start_date,end_date,registration_deadline,distances_json,active) VALUES(?,?,?,?,?,?,?,1)').run(
    'langkahbersama-virtual-run',
    'LangkahBersama Virtual Run',
    'Ikuti tantangan lari virtual dari mana saja.',
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    JSON.stringify({ '5K': 150000, '10K': 250000, '21K': 350000, '42K': 550000 })
  );
}

const SQLiteStore = SQLiteStoreFactory(session);
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'https://api.open-meteo.com'],
      mediaSrc: ["'self'"],
      childSrc: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  noSniff: true,
  frameguard: { action: 'deny' }
}));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.sqlite', dir: ROOT }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    maxAge: SESSION_MAX_AGE,
  }
}));

const publicApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan. Silakan coba lagi nanti.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Login dibatasi sementara. Coba lagi nanti.' }
});

const accessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan akses tiket. Silakan tunggu.' }
});

app.use('/api/', publicApiLimiter);

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

function text(v, n = 250) {
  if (typeof v !== 'string') return '';
  return v.replace(/\0/g, '').trim().slice(0, n);
}

function code(v) {
  return text(v, 30).toUpperCase();
}

function makeCode() {
  return `LB-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function safeSlug(v) {
  return text(v, 100).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

function eventView(row) {
  return { ...row, distances: JSON.parse(row.distances_json), active: !!row.active };
}

function requireAdmin(req, res, next) {
  if (!req.session.adminId) return res.status(401).json({ error: 'Silakan masuk sebagai admin.' });
  next();
}

function participant(req, res, next) {
  const r = db.prepare("SELECT id FROM registrations WHERE code=? AND status='paid'").get(code(req.params.code));
  if (!r) return res.status(404).json({ error: 'Tiket tidak ditemukan atau belum dibayar.' });
  req.registrationId = r.id;
  next();
}

function requireParticipantCode(req, res, next) {
  const r = db.prepare("SELECT id FROM registrations WHERE code=? AND status='paid'").get(code(req.params.code));
  if (!r) return res.sendStatus(404);
  if (!req.session || !req.session.participantRegistrationId || String(req.session.participantRegistrationId) !== String(r.id)) {
    return res.status(401).json({ error: 'Verifikasi peserta diperlukan.' });
  }
  next();
}

async function ticketBuffer(reg) {
  const event = db.prepare('SELECT name,start_date,end_date FROM events WHERE id=?').get(reg.event_id);
  const qr = await QRCode.toBuffer(`${BASE_URL}/track/${reg.code}`, { errorCorrectionLevel: 'M', margin: 1, width: 180 });
  const pdf = new PDFDocument({ size: 'A5', margin: 36 });
  const chunks = [];
  pdf.on('data', chunk => chunks.push(chunk));
  pdf.fontSize(20).text(event.name || 'Virtual Run Ticket', { align: 'center' });
  pdf.moveDown();
  pdf.fontSize(12).text(`Kode tiket: ${reg.code}`);
  pdf.text(`Nama: ${reg.name}`);
  pdf.text(`Email: ${reg.email}`);
  pdf.text(`Jarak: ${reg.distance}`);
  pdf.text(`Event: ${event.start_date} — ${event.end_date}`);
  pdf.moveDown();
  pdf.image(qr, { fit: [120, 120], align: 'center' });
  pdf.text('Pantau aktivitas: ' + `${BASE_URL}/track/${reg.code}`, { align: 'center' });
  pdf.end();
  await new Promise((resolve, reject) => {
    pdf.on('end', resolve);
    pdf.on('error', reject);
  });
  return Buffer.concat(chunks);
}

function enqueueTicket(registrationId) {
  const existing = db.prepare('SELECT id FROM ticket_mail_jobs WHERE registration_id=?').get(registrationId);
  if (existing) return;
  db.prepare(`INSERT INTO ticket_mail_jobs(registration_id,status,attempts,next_attempt_at,last_error,sent_at,updated_at) VALUES(?,'pending',0,0,NULL,NULL,CURRENT_TIMESTAMP)`).run(registrationId);
}

async function deliverTicket(reg) {
  if (!mailer) throw new Error('SMTP is not configured');
  const pdf = await ticketBuffer(reg);
  await mailer.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: reg.email,
    subject: 'Tiket Anda — LangkahBersama Virtual Run',
    text: `Halo ${reg.name},\n\nTiket Anda sudah aktif. Silakan buka link di bawah ini untuk melacak aktivitas Anda.\n\n${BASE_URL}/track/${reg.code}\n\nTerima kasih.`,
    attachments: [{ filename: `tiket-${reg.code}.pdf`, content: pdf, contentType: 'application/pdf' }]
  });
  db.prepare('UPDATE registrations SET ticket_sent_at=CURRENT_TIMESTAMP WHERE id=?').run(reg.id);
  db.prepare('UPDATE ticket_mail_jobs SET status=?, attempts=attempts+1, sent_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP, last_error=NULL WHERE registration_id=?').run('sent', reg.id);
}

let mailWorkerBusy = false;
async function processMailQueue() {
  if (mailWorkerBusy || !mailer) return;
  mailWorkerBusy = true;
  try {
    const job = db.prepare("SELECT j.id, j.registration_id, j.attempts FROM ticket_mail_jobs j WHERE j.status='pending' ORDER BY j.id LIMIT 1").get();
    if (!job) return;
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(job.registration_id);
    if (!reg) {
      db.prepare('DELETE FROM ticket_mail_jobs WHERE id=?').run(job.id);
      return;
    }
    try {
      await deliverTicket(reg);
    } catch (error) {
      const attempts = job.attempts + 1;
      const nextDelay = Math.min(60 * 60 * 1000, 1000 * 60 * Math.pow(2, attempts - 1));
      db.prepare('UPDATE ticket_mail_jobs SET status=?, attempts=?, next_attempt_at=?, last_error=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('failed', attempts, Date.now() + nextDelay, String(error.message || error).slice(0, 500), job.id);
    }
  } finally {
    mailWorkerBusy = false;
  }
}

setInterval(processMailQueue, 5000).unref();

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.sendStatus(503);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.error('Stripe signature verification failed:', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const registration = db.prepare('SELECT * FROM registrations WHERE payment_session_id=?').get(session.id);
    if (registration) {
      db.prepare("UPDATE registrations SET status='paid', payment_session_id=? WHERE id=?").run(session.id, registration.id);
      enqueueTicket(registration.id);
    }
  }

  if (event.type === 'checkout.session.expired') {
    const session = event.data.object;
    db.prepare("UPDATE registrations SET status='expired' WHERE payment_session_id=?").run(session.id);
  }

  return res.json({ received: true });
});

app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.get('/api/events/active', (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE active=1 ORDER BY id DESC LIMIT 1').get();
  if (!e) return res.status(404).json({ error: 'Belum ada event aktif.' });
  res.json(eventView(e));
});

app.post('/api/registrations', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Pembayaran online belum dikonfigurasi.' });

  const event = db.prepare('SELECT * FROM events WHERE id=? AND active=1').get(Number(req.body.event_id));
  if (!event) return res.status(400).json({ error: 'Event tidak valid atau belum aktif.' });

  const name = text(req.body.name, 100);
  const email = text(req.body.email, 160).toLowerCase();
  const phone = text(req.body.phone, 30);
  const distance = text(req.body.distance, 20);
  const shirt = text(req.body.shirt, 10) || 'M';
  const address = text(req.body.address, 300);
  const promo = text(req.body.promo, 30);
  const prices = JSON.parse(event.distances_json || '{}');
  const amount = Number(prices[distance] || 0);

  if (!name || !email || !phone || !distance || !address || !amount) {
    return res.status(400).json({ error: 'Data pendaftaran tidak lengkap atau tarif tidak valid.' });
  }

  const regCode = makeCode();
  const registration = db.prepare(`INSERT INTO registrations(event_id,code,name,email,phone,distance,shirt,address,promo,amount,status,payment_session_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,? ,CURRENT_TIMESTAMP)`).run(
    event.id, regCode, name, email, phone, distance, shirt, address, promo, amount, 'pending', null
  );

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price_data: { currency: 'idr', product_data: { name: `${event.name} — ${distance}` }, unit_amount: amount }, quantity: 1 }],
      success_url: `${BASE_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/?payment=cancelled`,
      customer_email: email,
      metadata: { registration_id: String(registration.lastInsertRowid), code: regCode },
      expires_at: Math.round(Date.now() / 1000) + 1800,
      payment_method_types: ['card']
    });

    db.prepare('UPDATE registrations SET payment_session_id=? WHERE id=?').run(session.id, registration.lastInsertRowid);
    return res.json({ ok: true, sessionId: session.id, url: session.url });
  } catch (error) {
    db.prepare('DELETE FROM registrations WHERE id=?').run(registration.lastInsertRowid);
    console.error('Stripe checkout creation failed:', error.message);
    return res.status(500).json({ error: 'Gagal membuat sesi pembayaran. Silakan coba lagi.' });
  }
});

app.get('/api/payment-status', async (req, res) => {
  if (!stripe || !req.query.session_id) return res.status(400).json({ error: 'Sesi tidak valid.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(text(req.query.session_id, 200));
    const registration = db.prepare('SELECT * FROM registrations WHERE payment_session_id=?').get(session.id);
    const paid = Boolean(session.payment_status === 'paid' || (registration && registration.status === 'paid'));
    return res.json({ paid, sessionId: session.id, amount_total: session.amount_total || 0 });
  } catch (error) {
    return res.status(400).json({ error: 'Sesi tidak ditemukan atau tidak valid.' });
  }
});

app.get('/api/tickets/:code.pdf', async (req, res) => {
  const r = db.prepare("SELECT * FROM registrations WHERE code=? AND status='paid'").get(code(req.params.code));
  if (!r) return res.status(404).send('Tiket tidak ditemukan atau belum dibayar.');
  const pathToPdf = path.join(ROOT, 'downloads', `${r.code}.pdf`);
  try {
    const pdf = await ticketBuffer(r);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ticket-${r.code}.pdf"`);
    return res.send(pdf);
  } catch (error) {
    console.error('Ticket generation failed:', error.message);
    return res.status(500).send('Gagal membuat tiket.');
  }
});

const accessLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan akses tiket. Silakan tunggu.' }
});

app.post('/api/track/request-access', accessLimiter, async (req, res) => {
  const c = code(req.body.code);
  const email = text(req.body.email, 160).toLowerCase();
  const r = db.prepare('SELECT id, email FROM registrations WHERE code=?').get(c);
  if (!r || r.email !== email) return res.status(404).json({ error: 'Kode tiket atau email tidak cocok.' });
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = Date.now() + 1000 * 60 * 15;
  db.prepare('INSERT INTO participant_tokens(token_hash,registration_id,expires_at,created_at) VALUES(?,?,?,CURRENT_TIMESTAMP)').run(tokenHash, r.id, expiresAt);
  const link = `${BASE_URL}/track/${c}?token=${encodeURIComponent(rawToken)}`;
  if (mailer) {
    await mailer.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: email,
      subject: 'Link akses pantauan aktivitas',
      text: `Klik tautan berikut untuk melihat pantauan aktivitas Anda:\n\n${link}\n\nTautan berlaku 15 menit.`
    });
  }
  return res.json({ ok: true, message: 'Link akses telah dikirim ke email Anda.' });
});

app.get('/api/track/verify', async (req, res) => {
  const raw = text(req.query.token, 100);
  if (!raw) return res.status(400).json({ error: 'Token tidak valid.' });
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const token = db.prepare('SELECT * FROM participant_tokens WHERE token_hash=? AND expires_at>?').get(hash, Date.now());
  if (!token) return res.status(400).json({ error: 'Token sudah kadaluarsa atau tidak valid.' });
  const reg = db.prepare('SELECT id, code FROM registrations WHERE id=?').get(token.registration_id);
  if (!reg) return res.status(404).json({ error: 'Peserta tidak ditemukan.' });
  req.session.participantRegistrationId = reg.id;
  db.prepare('UPDATE participant_tokens SET used_at=? WHERE token_hash=?').run(Date.now(), hash);
  return res.redirect(`/track/${reg.code}`);
});

app.post('/api/track/:code/logout', participant, (req, res) => {
  delete req.session.participantRegistrationId;
  res.json({ ok: true });
});

app.get('/track/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'track.html')));

app.get('/api/track/:code', participant, (req, res) => {
  const r = db.prepare(`SELECT r.code, r.name, r.distance, r.status, e.name AS event_name, e.start_date, e.end_date FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.id = ?`).get(req.registrationId);
  if (!r) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
  const activities = db.prepare('SELECT * FROM activities WHERE registration_id=? ORDER BY created_at DESC').all(req.registrationId);
  res.json({ ...r, activities, stravaConfigured: Boolean(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET) });
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.pdf'].includes(ext)) return cb(new Error('Format file tidak didukung.'));
    cb(null, true);
  }
});

function detectFile(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: '.jpg', mime: 'image/jpeg' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: '.png', mime: 'image/png' };
  if (buffer.length >= 5 && buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) return { ext: '.pdf', mime: 'application/pdf' };
  return null;
}

app.post('/api/track/:code/upload', participant, upload.single('proof'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Pilih bukti aktivitas.' });
  const detected = detectFile(req.file.buffer);
  if (!detected) return res.status(400).json({ error: 'File bukti tidak valid.' });
  if (req.file.mimetype && !['image/jpeg', 'image/png', 'application/pdf'].includes(req.file.mimetype)) {
    return res.status(400).json({ error: 'Jenis file tidak diizinkan.' });
  }
  const fileExt = detected.ext;
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${fileExt}`;
  const destination = path.join(UPLOAD_DIR, filename);
  fs.writeFileSync(destination, req.file.buffer, { mode: 0o600 });
  db.prepare('INSERT INTO activities(registration_id,source,proof_path,status,created_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP)').run(req.registrationId, 'upload', filename, 'submitted');
  return res.json({ ok: true, message: 'Bukti aktivitas berhasil dikirim.' });
});

app.get('/uploads/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const exists = db.prepare('SELECT id FROM activities WHERE proof_path=?').get(filename);
  if (!exists) return res.sendStatus(404);
  res.sendFile(path.join(UPLOAD_DIR, filename));
});

app.get('/api/strava/connect/:code', (req, res) => {
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) return res.status(503).send('Strava belum dikonfigurasi.');
  const r = db.prepare("SELECT id FROM registrations WHERE code=? AND status='paid'").get(code(req.params.code));
  if (!r) return res.status(404).send('Tiket tidak ditemukan.');
  const state = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO oauth_states(state,registration_id,expires_at) VALUES(?,?,?)').run(state, r.id, Date.now() + 1000 * 60 * 10);
  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: `${BASE_URL}/api/strava/callback`,
    approval_prompt: 'auto',
    scope: 'read,activity:read_all',
    state
  });
  return res.redirect(`https://www.strava.com/oauth/authorize?${params.toString()}`);
});

app.get('/api/strava/callback', async (req, res) => {
  const state = text(req.query.state, 100);
  const saved = db.prepare('SELECT * FROM oauth_states WHERE state=? AND expires_at>?').get(state, Date.now());
  if (!saved) return res.status(400).send('Sesi Strava tidak valid atau sudah kedaluwarsa.');
  const codeStr = text(req.query.code, 200);
  if (!codeStr) return res.status(400).send('Tidak ada kode oauth Strava.');

  try {
    const result = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code: codeStr,
        grant_type: 'authorization_code'
      })
    });
    const data = await result.json();
    if (!result.ok) throw new Error(data.errors?.[0]?.message || 'Strava auth failed');
    db.prepare('UPDATE registrations SET strava_access_token=?, strava_refresh_token=?, strava_athlete_id=?, strava_expires_at=? WHERE id=?').run(
      data.access_token,
      data.refresh_token,
      String(data.athlete?.id || ''),
      Date.now() + (data.expires_in || 0) * 1000,
      saved.registration_id
    );
    db.prepare('DELETE FROM oauth_states WHERE state=?').run(state);
    return res.redirect(`${BASE_URL}/track/${db.prepare('SELECT code FROM registrations WHERE id=?').get(saved.registration_id).code}?strava=connected`);
  } catch (error) {
    console.error('Strava callback failed:', error);
    return res.status(500).send('Gagal menghubungkan Strava.');
  }
});

app.post('/api/strava/sync/:code', requireParticipantCode, async (req, res) => {
  const reg = db.prepare('SELECT r.*, e.start_date, e.end_date FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.code = ?').get(code(req.params.code));
  if (!reg || !reg.strava_access_token) return res.status(400).json({ error: 'Strava belum terhubung.' });

  try {
    const url = new URL('https://www.strava.com/api/v3/athlete/activities');
    url.searchParams.set('per_page', '30');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${reg.strava_access_token}` } });
    if (!response.ok) throw new Error('Strava sync failed');
    const activities = await response.json();
    let imported = 0;
    for (const item of activities) {
      const existing = db.prepare('SELECT id FROM activities WHERE external_id=? AND registration_id=?').get(String(item.id), reg.id);
      if (!existing && item.distance && Number(item.distance) > 0) {
        db.prepare('INSERT INTO activities(registration_id,source,external_id,distance_m,activity_date,status,created_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)').run(
          reg.id, 'strava', String(item.id), Math.round(Number(item.distance)), item.start_date_local || new Date(item.start_date).toISOString().slice(0, 10), 'submitted'
        );
        imported += 1;
      }
    }
    return res.json({ ok: true, imported });
  } catch (error) {
    console.error('Strava sync error:', error);
    return res.status(500).json({ error: 'Sinkronisasi Strava gagal.' });
  }
});

app.get('/admin', (req, res) => res.sendFile(path.join(ROOT, 'public', 'admin.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(ROOT, 'public', 'privacy.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(ROOT, 'public', 'terms.html')));

app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const email = text(req.body.email, 160).toLowerCase();
  const pass = text(req.body.password, 200);
  const admin = db.prepare('SELECT * FROM admins WHERE email=?').get(email);
  if (!admin || !bcrypt.compareSync(pass, admin.password_hash)) {
    return res.status(401).json({ error: 'Email atau kata sandi salah.' });
  }
  req.session.adminId = admin.id;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Gagal masuk.' });
    res.json({ ok: true });
  });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true }));
app.get('/api/admin/events', requireAdmin, (req, res) => res.json(db.prepare('SELECT * FROM events ORDER BY id DESC').all().map(eventView)));

function validateEvent(body) {
  const name = text(body.name, 120);
  const slug = safeSlug(body.slug || body.name);
  const start = text(body.start_date, 10);
  const end = text(body.end_date, 10);
  const deadline = text(body.registration_deadline, 10);
  const description = text(body.description, 2000);
  const distances = typeof body.distances === 'object' ? body.distances : {};
  if (!name || !start || !end || !deadline || !Object.keys(distances).length) {
    throw new Error('Data event tidak lengkap.');
  }
  for (const [key, value] of Object.entries(distances)) {
    if (!key || Number(value) <= 0) throw new Error('Harga jarak tidak valid.');
  }
  if (!validDate(start) || !validDate(end) || !validDate(deadline)) throw new Error('Tanggal event tidak valid.');
  return { name, slug, start, end, deadline, description, distances };
}

app.post('/api/admin/events', requireAdmin, (req, res) => {
  try {
    const x = validateEvent(req.body);
    const r = db.prepare('INSERT INTO events(slug,name,description,start_date,end_date,registration_deadline,distances_json,active) VALUES(?,?,?,?,?,?,?,0)').run(
      x.slug || 'event', x.name, x.description, x.start, x.end, x.deadline, JSON.stringify(x.distances)
    );
    res.status(201).json({ ok: true, id: r.lastInsertRowid });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Event tidak valid.' });
  }
});

app.put('/api/admin/events/:id', requireAdmin, (req, res) => {
  if (!db.prepare('SELECT id FROM events WHERE id=?').get(Number(req.params.id))) return res.sendStatus(404);
  try {
    const x = validateEvent(req.body);
    db.prepare('UPDATE events SET slug=?,name=?,description=?,start_date=?,end_date=?,registration_deadline=?,distances_json=? WHERE id=?').run(
      x.slug || 'event', x.name, x.description, x.start, x.end, x.deadline, JSON.stringify(x.distances), Number(req.params.id)
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Event tidak valid.' });
  }
});

app.post('/api/admin/events/:id/activate', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT id FROM events WHERE id=?').get(id)) return res.sendStatus(404);
  db.exec('UPDATE events SET active = CASE WHEN id = ' + id + ' THEN 1 ELSE 0 END;');
  res.json({ ok: true });
});

app.get('/api/admin/registrations', requireAdmin, (req, res) => res.json(db.prepare(`SELECT r.id,r.code,r.name,r.email,r.phone,r.distance,r.amount,r.status,r.ticket_sent_at,r.created_at,e.name AS event_name FROM registrations r JOIN events e ON e.id=r.event_id ORDER BY r.id DESC`).all()));
app.get('/api/admin/activities', requireAdmin, (req, res) => res.json(db.prepare('SELECT a.*,r.code,r.name,r.email,e.name AS event_name FROM activities a JOIN registrations r ON r.id=a.registration_id JOIN events e ON e.id=r.event_id ORDER BY a.id DESC').all()));
app.patch('/api/admin/activities/:id', requireAdmin, (req, res) => {
  const status = text(req.body.status, 20);
  if (!['approved', 'rejected', 'submitted'].includes(status)) return res.status(400).json({ error: 'Status aktivitas tidak valid.' });
  db.prepare('UPDATE activities SET status=? WHERE id=?').run(status, Number(req.params.id));
  res.json({ ok: true });
});
app.get('/api/admin/ticket-jobs', requireAdmin, (req, res) => res.json(db.prepare('SELECT j.id,j.registration_id,j.status,j.attempts,j.next_attempt_at,j.last_error,j.sent_at,r.code,r.name,r.email FROM ticket_mail_jobs j JOIN registrations r ON r.id=j.registration_id ORDER BY j.id DESC').all()));
app.post('/api/admin/tickets/:code/resend', requireAdmin, async (req, res) => {
  const reg = db.prepare("SELECT * FROM registrations WHERE code=? AND status='paid'").get(code(req.params.code));
  if (!reg) return res.status(404).json({ error: 'Tiket tidak ditemukan.' });
  try {
    await deliverTicket(reg);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Pengiriman ulang tiket gagal.' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Ukuran file maksimal 8 MB.' : 'Upload tidak valid.' });
  if (err) {
    console.error('Unhandled error:', err);
    return res.status(500).json({ error: 'Terjadi kesalahan server.' });
  }
  next();
});

app.use(express.static(path.join(ROOT, 'public')));
app.listen(PORT, () => console.log(`Virtual Run CMS listening on ${BASE_URL}`));
