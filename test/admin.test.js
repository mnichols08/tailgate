// Shopper accounts and the market's admin, over plain HTTP (no browser needed).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';

const COST = { N: 2 ** 10, r: 8, p: 1 };
const OWNER = { email: 'owner@example.com', name: 'Test Owner', password: 'test owner password' };
const STAFF = { email: 'support@example.com', name: 'Market Support', password: 'market support password' };
const dir = mkdtempSync(join(tmpdir(), 'tailgate-admin-'));
let server;
let base;

before(async () => {
  server = await createApp({ staffCost: COST, db: join(dir, 'shop.db'), cache: false, secret: 'test' });
  await server.staff.accept(await server.staff.setup(), OWNER);
  const owner = server.staff.list().find((one) => one.email === OWNER.email);
  await server.staff.accept((await server.staff.invite(owner, { email: STAFF.email, name: STAFF.name, roles: ['staff'] })).token, STAFF);
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
});

function browser() {
  const jar = new Map();
  const remember = (response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      if (pair.slice(at + 1)) jar.set(pair.slice(0, at), pair.slice(at + 1));
      else jar.delete(pair.slice(0, at));
    }
    return response;
  };
  const cookie = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const where = (response) => decodeURIComponent((response.headers.get('location') ?? '').replace(/&sig=[\w-]+/, '').replaceAll('+', ' '));
  return {
    async get(path) {
      const response = remember(await fetch(`${base}${path}`, { headers: { cookie: cookie() }, redirect: 'manual' }));
      return { status: response.status, type: response.headers.get('content-type'), location: where(response), text: await response.text() };
    },
    async post(path, form) {
      const response = remember(await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), redirect: 'manual' }));
      return { status: response.status, location: where(response), text: await response.text() };
    },
    /** An action, as a page with JavaScript calls it. */
    async act(path, form) {
      const response = remember(await fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(form), redirect: 'manual' }));
      return response.status;
    },
    /** Every change the live log would send this browser, asking for `collections`. */
    async pull(collections) {
      const scope = encodeURIComponent(JSON.stringify(Object.fromEntries(collections.map((one) => [one, true]))));
      const response = await fetch(`${base}/_zb/sync/pull?since=0&scope=${scope}`, { headers: { cookie: cookie() } });
      return { status: response.status, text: await response.text() };
    },
  };
}
async function signInStaff(who) {
  const b = browser();
  await b.get('/');
  assert.equal((await b.post('/staff/sign-in', { email: who.email, password: who.password })).location, '/admin');
  return b;
}

test('the market leads with what Tailgate is, then the farms and what’s for sale; no admin link for a guest', async () => {
  const page = (await browser().get('/')).text;
  assert.match(page, /class="hero"[\s\S]*Farm to door[\s\S]*Shop[\s\S]*Sell[\s\S]*Drive[\s\S]*The farms[\s\S]*For sale today/);
  assert.ok(!page.includes('>Admin</a>'));
});

test('a shopper makes an account, fills a cart, checks out, and their orders follow them to another device', async () => {
  const phone = browser();
  await phone.get('/');
  assert.equal((await phone.post('/account/sign-up', { name: 'Pat Quill', email: 'pat@example.com', password: 'pat quill password' })).location, '/account?done=Welcome. Your account is ready.');
  assert.equal(await phone.act('/_zb/action/produce-card/add', { farm: 'bearrun', item: 'apples', qty: '2' }), 204);
  const html = (await phone.get('/checkout')).text;
  assert.match(html, /value="Pat Quill"[\s\S]*value="pat@example.com"/, 'checkout knows the shopper');
  const checkout = /name="checkout" value="([a-z0-9]+)"/.exec(html)[1];
  assert.equal((await phone.post('/checkout', { checkout, name: 'Pat Quill', email: 'pat@example.com', address: '1 Test Rd', card: '4242 4242 4242 4242' })).location, '/orders?done=placed');
  const id = server.customers.list().find((one) => one.email === 'pat@example.com').customer;
  const order = server.market.allOrders().find((one) => one.customer === id);
  assert.ok(order, 'the order is the account’s');
  assert.equal(order.customerName, 'Pat Quill');

  const laptop = browser();
  await laptop.get('/');
  assert.match((await laptop.get('/orders')).text, /Choose|shopper/i, 'not signed in, no orders');
  assert.equal((await laptop.post('/account/sign-in', { email: 'pat@example.com', password: 'pat quill password' })).location, '/account');
  assert.match((await laptop.get('/orders')).text, /Honeycrisp apples/);
  assert.equal((await laptop.post('/account/sign-out', {})).location, '/');
  assert.equal((await laptop.get('/account')).location, '/account/sign-in');
});

test('no page can read accounts, sessions, tokens or the admin’s activity from the live log', async () => {
  const b = browser();
  await b.get('/');
  await b.post('/account/sign-up', { name: 'Nosy Parker', email: 'nosy@example.com', password: 'nosy parker password' });
  const pulled = await b.pull(['customers', 'customer-sessions', 'customer-tokens', 'accounts', 'staff-sessions', 'staff-tokens', 'audit']);
  assert.ok(!/nosy@example\.com|scrypt|Market Support/.test(pulled.text), pulled.text.slice(0, 200));
});

test('a forgotten password: the same page either way, and the emailed link works once', async () => {
  const b = browser();
  await b.get('/');
  await b.post('/account/sign-up', { name: 'Lee Forgets', email: 'lee@example.com', password: 'lee first password' });
  const nobody = (await b.post('/account/forgot', { email: 'nobody@example.com' })).text.match(/<main[\s\S]*<\/main>/)[0];
  const lee = (await b.post('/account/forgot', { email: 'lee@example.com' })).text.match(/<main[\s\S]*<\/main>/)[0];
  assert.equal(nobody, lee);
  const token = /\/account\/reset\?token=([\w-]{43})/.exec(server.sent.at(-1).body)[1];
  assert.equal((await b.post('/account/reset', { token, password: 'lee second password' })).location, '/account?done=Your new password is saved.');
  assert.match((await b.post('/account/reset', { token, password: 'lee third password' })).text, /expired/);
});

test('the admin is for the market’s staff; reports and the outbox for owners', async () => {
  const guest = browser();
  await guest.get('/');
  for (const path of ['/admin', '/admin/orders', '/admin/reports', '/admin/orders.csv']) {
    const page = await guest.get(path);
    assert.ok(!/Overview|text\/csv/.test(`${page.text}${page.type}`), path);
  }
  // A farmer from the demo isn't the market's staff.
  const farmer = browser();
  await farmer.get('/');
  await farmer.post('/who', { who: 'hilltop' });
  assert.ok(!(await farmer.get('/admin')).text.includes('Overview'));
  const hand = await signInStaff(STAFF);
  assert.match((await hand.get('/admin')).text, /Overview[\s\S]*Waiting for a driver/);
  for (const path of ['/admin/orders', '/admin/farms', '/admin/drivers', '/admin/shoppers']) assert.equal((await hand.get(path)).status, 200, path);
  for (const path of ['/admin/reports', '/admin/outbox']) assert.equal((await hand.get(path)).status, 403, path);
  const owner = await signInStaff(OWNER);
  for (const path of ['/admin/reports', '/admin/outbox']) assert.equal((await owner.get(path)).status, 200, path);
});

test('orders search and download; the report adds up; a name can’t become a formula', async () => {
  const b = browser();
  await b.get('/');
  await b.post('/account/sign-up', { name: '=HYPERLINK("http://evil.example")', email: 'sheet@example.com', password: 'spreadsheet password' });
  await b.act('/_zb/action/produce-card/add', { farm: 'hilltop', item: 'eggs', qty: '1' });
  const checkout = /name="checkout" value="([a-z0-9]+)"/.exec((await b.get('/checkout')).text)[1];
  await b.post('/checkout', { checkout, name: 'x', email: 'sheet@example.com', address: '2 Test Rd', card: '4242 4242 4242 4242' });
  const owner = await signInStaff(OWNER);
  assert.match((await owner.get('/admin/orders?q=2%20Test%20Rd')).text, /Pasture eggs/);
  const all = server.market.allOrders();
  const at = Date.now();
  const recent = all.filter((order) => order.placed >= at - 29 * 86_400_000);
  const total = recent.reduce((sum, order) => sum + order.goods + order.fee, 0);
  const rows = (await owner.get('/admin/reports.csv?range=30d')).text.trim().split('\r\n');
  assert.equal(rows[0], 'Day,Orders,Sales with delivery (USD)');
  assert.equal(Math.round(rows.slice(1).reduce((sum, row) => sum + Number(row.split(',')[2]), 0) * 100), total);
  assert.match((await owner.get('/admin/orders.csv')).text, /"'=HYPERLINK\(""http:\/\/evil\.example""\)"/);
});

test('an owner turns a shopper off; staff can’t turn them back on', async () => {
  const b = browser();
  await b.get('/');
  await b.post('/account/sign-up', { name: 'Off Switch', email: 'off@example.com', password: 'off switch password' });
  const id = server.customers.list().find((c) => c.email === 'off@example.com').customer;
  const owner = await signInStaff(OWNER);
  assert.match((await owner.post(`/admin/shoppers/${id}/disabled`, { disabled: 'yes' })).location, /Turned off/);
  assert.equal((await b.get('/account')).location, '/account/sign-in');
  const hand = await signInStaff(STAFF);
  await hand.post(`/admin/shoppers/${id}/disabled`, { disabled: 'no' });
  assert.equal(server.customers.get(id).disabled, true);
});
