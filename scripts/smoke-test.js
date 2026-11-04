#!/usr/bin/env node
// Lightweight deployment smoke test: public site + authenticated admin read APIs.
// This does not charge a card; use PAYMENT-E2E.md for Stripe test-mode workflow.
const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) {
  console.error('Set BASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD in the environment.');
  process.exit(2);
}
async function request(path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  const body = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${body.slice(0, 300)}`);
  return { res, body };
}
(async () => {
  const publicPage = await request('/');
  if (!publicPage.body.includes('<html')) throw new Error('Public landing page did not return HTML.');
  const activeEvent = await request('/api/events/active');
  const event = JSON.parse(activeEvent.body);
  if (!event.id || !event.distances) throw new Error('Active event response is missing event data.');
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!login.ok) throw new Error(`Admin login failed with HTTP ${login.status}.`);
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  if (!cookie) throw new Error('Login succeeded but no session cookie was returned.');
  for (const endpoint of ['/api/admin/me', '/api/admin/events', '/api/admin/registrations', '/api/admin/activities', '/api/admin/ticket-jobs']) {
    await request(endpoint, { headers: { Cookie: cookie } });
  }
  console.log(`Smoke test passed for ${base}; active event: ${event.name}.`);
  console.log('No real payment was made. Follow PAYMENT-E2E.md to test Stripe webhook and email delivery in test mode.');
})().catch(err => { console.error(`Smoke test failed: ${err.message}`); process.exit(1); });
