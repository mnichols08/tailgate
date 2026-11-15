// Tailgate: farm to door, on one small Node server.
//
// - Pages are rendered here by @zubra/server and hydrated in the browser.
// - Farmers' stock, each farm's storefront, and every order's live status are Sync documents
//   (@zubra/sync) in one SQLite log, which src/market.js also reads, so the server always knows
//   the current state.
// - Anything two people could both want (adding the last crate, claiming a delivery) is a
//   'use server' function (@zubra/actions): a plain form post, with or without JavaScript.
// - The cart and checkout are the Potomac kit's catalog, cart, checkout, pay and stages
//   (src/market.js), shown by the kit's cart-panel and checkout-form from the package.
// - The controls, charts, dashboards and themes are Zubra UI, installed with `npx shadcn add`.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createActions } from '@zubra/actions';
import { createMarket, THEMES } from './src/market.js';
import { money } from './src/account.js';
import { sessions } from './src/session.js';
import { createNotices } from '@potomac-solutions/kit/notice';
import { createCustomers } from '@potomac-solutions/kit/customers';
import { createStaff } from '@potomac-solutions/kit/staff';
import { staffPages, clientAddress } from '@potomac-solutions/kit/staff/pages';
import { createNotify, outbox } from '@potomac-solutions/kit/notify';
import * as accountPages from './src/account.js';
import { createAdmin } from './src/admin.js';
import { layout, appLayout, escape, DONE } from './src/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, 'src', 'components');
const require = createRequire(import.meta.url);

/** Text that reads on `hex`: near-black on light colours, white on dark ones. */
function inkOn(hex) {
  const channel = (pair) => {
    const c = parseInt(pair, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const light = 0.2126 * channel(hex.slice(1, 3)) + 0.7152 * channel(hex.slice(3, 5)) + 0.0722 * channel(hex.slice(5, 7));
  return light > 0.45 ? '#1b1f1d' : '#ffffff';
}

/**
 * Render `name` with slot content that may itself be Zubra output. @zubra/server parses slot
 * HTML as a template, which refuses the hydration markers (`<?zb …?>`) in already-rendered
 * children, so each slot is rendered as a placeholder and its content put in afterwards.
 */
function render(p, name, props = {}, slots = {}) {
  const marks = Object.fromEntries(Object.keys(slots).map((slot) => [slot, `tg-slot-${slot}-${Math.random().toString(36).slice(2)}`]));
  let html = p.render(name, props, marks);
  for (const [slot, mark] of Object.entries(marks)) html = html.replace(mark, () => slots[slot]);
  return html;
}

/** Static files: Zubra UI's themes and the two typefaces. */
function assets() {
  const files = new Map();
  files.set('/styles/theme.css', ['text/css', readFileSync(join(components, 'zubra', 'theme.css'))]);
  for (const theme of THEMES) files.set(`/styles/${theme}.css`, ['text/css', readFileSync(join(components, 'zubra', 'themes', `${theme}.css`))]);
  for (const [pkg, prefix] of [['@fontsource/barlow-condensed', 'barlow-condensed'], ['@fontsource/source-sans-3', 'source-sans-3']]) {
    const dir = join(dirname(require.resolve(`${pkg}/package.json`)), 'files');
    for (const weight of [400, 600, 700]) {
      const name = `${prefix}-latin-${weight}-normal.woff2`;
      try {
        files.set(`/fonts/${name}`, ['font/woff2', readFileSync(join(dir, name))]);
      } catch {}
    }
  }
  return files;
}

export async function createApp({ db = join(process.env.DATA_DIR ?? here, 'tailgate.db'), cache = true, secret = process.env.SESSION_SECRET, staffCost, now = Date.now } = {}) {
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('Set SESSION_SECRET.');
    secret = 'tailgate-development-only';
  }
  const market = await createMarket({ db });
  const session = sessions({ secret, people: market.people });
  const production = process.env.NODE_ENV === 'production';
  const cost = staffCost ? { cost: staffCost } : {};
  // Shoppers who make an account (kit/customers), and the people who run the market (kit/staff):
  // both in the market's own log, in collections no page can read.
  const customers = createCustomers({ store: market.store, secure: production, now, ...cost });
  const staff = createStaff({ store: market.store, secure: production, now, ...cost });
  market.names((id) => customers.get(id)?.name ?? '');
  /**
   * Who is asking, from a Cookie header: a shopper signed in to their account, or the demo person
   * picked on the start page.
   */
  function personOf(cookie = '') {
    const one = customers.session(cookie);
    if (one) return { id: one.customer, role: 'customer', name: one.name, email: one.email, address: '', account: true };
    return session.read(cookie);
  }
  market.identify((request) => personOf(request.headers.get('cookie') ?? ''));
  // Email goes to an outbox the owner can read: this demo sends nothing for real.
  const mail = outbox();
  const notify = createNotify({
    send: mail.send,
    templates: { reset: ({ name, link }) => ({ subject: 'Reset your Tailgate password', body: `Hi ${name},\n\nThis link sets a new password. It works once, for an hour:\n${link}\n\nIf it wasn’t you, ignore this email.` }) },
  });
  const proxies = Number(process.env.TRUST_PROXIES ?? 0);
  const origin = (req) => process.env.PUBLIC_URL || `http://${req.headers.host ?? 'localhost'}`;
  const admin = createAdmin({ market, customers, sent: mail.sent, now });

  // The kit's components come from the package. Where Tailgate has its own copy of a part they
  // use (action-button, text-field…), Tailgate's is used for both (Zubra 5.10).
  const zubra = createZubra({ components, cache, packages: ['@potomac-solutions/kit/components'] });
  const actions = await createActions({
    components,
    context: ({ request }) => ({ market, person: personOf(request.headers.get('cookie') ?? '') }),
  });
  const files = assets();

  // A message in an address shows only if the server signed it (kit/notice), so a link can't put
  // its own words in a page's alert.
  const notices = createNotices({ secret });
  const back = (res, location) => (res.writeHead(303, { location: notices.sign(location) }), res.end());
  const withDone = (path, words) => `${path}${path.includes('?') ? '&' : '?'}done=${encodeURIComponent(words)}`;
  const withProblem = (path, words) => `${path}${path.includes('?') ? '&' : '?'}problem=${encodeURIComponent(words)}`;
  const said = (url) => {
    const { problem, done } = notices.read(url);
    return `${problem ? `<p class="notice" role="alert">${escape(problem)}</p>` : ''}${done && !/^[a-z]+$/.test(done) ? `<p class="ok" role="status">${escape(done)}</p>` : ''}`;
  };
  const downloadCsv = (res, name, text) => (res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' }), res.end(text));
  // The market's staff: sign-in, invites, people and passwords are the kit's pages.
  const staffSite = staffPages({ staff, notices, proxies, home: '/admin', business: 'Tailgate', secure: production, render: (res, title, body) => send(res, 200, zubra.page().finish(layout({ title, path: '', person: null, body, actionsScript: actions.script() }))) });

  /** A small urlencoded form, or null when it's bigger than any of Tailgate's forms. */
  async function readForm(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 4000) return null;
    }
    return new URLSearchParams(body);
  }

  function send(res, status, html, headers = {}) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(html);
  }

  /** What the page reports from the last action: an error, or what was done (`?done=`). */
  function outcome(req, res, p, url) {
    // Without JavaScript, an action's error comes back once in a cookie.
    const result = actions.result(req, (name, value) => res.setHeader(name, value));
    const problem = result?.value?.error ?? (result?.error ? 'That didn’t go through. Try again.' : '');
    const done = DONE[url.searchParams.get('done')] ?? '';
    const banner = problem
      ? render(p, 'alert-banner', { variant: 'danger' }, { default: escape(problem) })
      : done
        ? `<noscript>${render(p, 'alert-banner', { variant: 'success' }, { default: escape(done) })}</noscript>`
        : '';
    return { banner, done };
  }

  function page(req, res, url, { title, person, body, p, wide = false, status = 200 }) {
    const { banner, done } = outcome(req, res, p, url);
    const avatar = person ? p.render('user-avatar', { name: person.name, size: 'sm' }) : '';
    const toasts = p.render('toast-region', {});
    const cartCount = person?.role === 'customer' ? market.cart(person).count : 0;
    const html = layout({ title, path: url.pathname, person, banner, body, done, avatar, cartCount, staff: staff.can(staff.session(req), 'staff'), wide, actionsScript: actions.script() }).replace('<toast-region></toast-region>', toasts);
    send(res, status, p.finish(html));
  }

  /** A dashboard, in `color`: the farm's own for farmers, Tailgate's amber for drivers. */
  function app(req, res, url, { title, p, shell, color = '#2e5e4e', chart = color }) {
    const { banner, done } = outcome(req, res, p, url);
    const toasts = p.render('toast-region', {});
    const palette = `--primary:${color};--ring:${color};--primary-foreground:${inkOn(color)};--chart-1:${chart};--chart-2:color-mix(in oklch, ${chart} 45%, white);--chart-3:#2e5e4e;--chart-4:#e3a21a;--chart-5:#7d8c86`;
    const html = appLayout({ title, shell, banner, done, palette, actionsScript: actions.script() }).replace('<toast-region></toast-region>', toasts);
    send(res, 200, p.finish(html));
  }

  /** An order as `order-card`'s props: the static parts, and where its live status starts. */
  const card = (order, viewer, compact = false) => ({
    doc: order.doc,
    itemName: order.itemName,
    qty: order.qty,
    unit: order.unit,
    total: order.total,
    farmName: order.farmName,
    customerName: order.customerName,
    address: order.address,
    statusNow: order.status,
    driverNow: order.driverName,
    viewer,
    compact,
    when: new Date(order.placed).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  });

  /** A farm's stall, live: its current look, and how many things it has for sale. */
  const stall = (p, farm, size = 'row', href = `/farms/${farm}`) => {
    const b = market.brand(farm);
    return p.render('farm-stall', { farm, nameNow: b.name, taglineNow: b.tagline, colorNow: b.color, themeNow: b.theme, logoNow: b.logo, town: b.town, count: market.catalog(farm).length, href, size });
  };

  const ask = (p, role, verb) =>
    `<section>${render(p, 'empty-state', { heading: `This page is for ${role}s` }, { default: `Choose a ${role} to ${verb}.`, actions: `<a class="button-light" href="/start">Choose who you are</a>` })}</section>`;

  // ---- Farmer dashboard ----------------------------------------------------------------------
  const FARM_NAV = [
    { id: 'overview', label: 'Overview', href: '/farm' },
    { id: 'stock', label: 'Stock', href: '/farm/stock' },
    { id: 'orders', label: 'Orders', href: '/farm/orders' },
    { id: 'storefront', label: 'Storefront', href: '/farm/storefront' },
  ];
  function farmShell(p, person, current, heading, content) {
    const b = market.brand(person.farm);
    return render(p, 
      'dashboard-shell',
      {
        product: b.name,
        heading,
        nav: FARM_NAV,
        current,
        user: person.name.split(' ')[0],
        menu: [
          { value: `/farms/${person.farm}`, label: 'See my stall' },
          { value: '/', label: 'Open the market' },
          { value: '/start', label: 'Switch person' },
        ],
      },
      { default: `<div class="app-body">${content}</div>`, actions: `<a class="shell-actions-link" href="/farms/${person.farm}">See my stall</a>` },
    );
  }

  function farmOverview(p, person) {
    const stats = market.farmStats(person.farm);
    const recent = market.ordersForFarm(person.farm).slice(0, 4);
    const stock = market
      .catalog(person.farm)
      .map((listing) => ({ label: listing.name, value: listing.qty }))
      .sort((a, b) => a.value - b.value);
    return `<p class="lede">Good to see you, ${escape(person.name.split(' ')[0])}. Here’s how ${escape(market.brand(person.farm).name)} is doing.</p>
      <div class="stats">
        ${p.render('stat-card', { label: 'Sales, last 7 days', value: stats.week, change: stats.weekChange, period: 'vs the week before' })}
        ${p.render('stat-card', { label: 'Orders to fill', value: String(stats.open), period: stats.open ? 'waiting for a driver or on the way' : 'nothing waiting' })}
        ${p.render('stat-card', { label: 'Running low', value: String(stats.low.length), period: stats.low.length ? stats.low.map((l) => l.name).join(', ') : 'everything is stocked' })}
      </div>
      <div class="panels">
        <section class="panel"><h2>Daily sales</h2>${p.render('line-chart', { points: stats.daily.map((d) => d.value), label: 'Daily sales in dollars, last 14 days' })}</section>
        <section class="panel"><h2>What sold, last 30 days</h2>${p.render('donut-chart', { segments: stats.byItem, label: 'Sales by item in dollars' })}</section>
      </div>
      <div class="panels">
        <section class="panel">${stock.length ? p.render('bar-chart', { items: stock, label: 'Stock on hand', unit: ' left' }) : render(p, 'empty-state', { heading: 'Nothing listed' }, { default: 'Add what you have on the Stock page.' })}</section>
        <section class="panel"><h2>Latest orders</h2><div class="stack">${recent.map((order) => p.render('order-card', card(order, 'farmer', true))).join('') || render(p, 'empty-state', { heading: 'No orders yet' }, { default: 'They show up here as customers place them.' })}</div></section>
      </div>`;
  }

  function farmBoard(p, person) {
    const all = market.ordersForFarm(person.farm);
    const columns = [
      ['placed', 'Waiting for a driver'],
      ['claimed', 'Driver on the way to you'],
      ['picked', 'Out for delivery'],
      ['delivered', 'Delivered'],
    ];
    return `<p class="lede">Every order for your farm, by where it is. Cards update by themselves as drivers move them along.</p>
      <div class="board">${columns
        .map(([status, heading]) => {
          const cards = all.filter((order) => order.status === status).slice(0, status === 'delivered' ? 8 : 50);
          return render(p, 'kanban-column', { heading, count: all.filter((order) => order.status === status).length }, { default: cards.map((order) => p.render('order-card', card(order, 'farmer', true))).join('') });
        })
        .join('')}</div>`;
  }

  // ---- Driver dashboard ----------------------------------------------------------------------
  const DRIVE_NAV = [
    { id: 'deliveries', label: 'Deliveries', href: '/drive' },
    { id: 'earnings', label: 'Earnings', href: '/drive/earnings' },
  ];
  const driveShell = (p, person, current, heading, content) =>
    render(p, 
      'dashboard-shell',
      { product: 'Tailgate for drivers', heading, nav: DRIVE_NAV, current, user: person.name.split(' ')[0], menu: [{ value: '/', label: 'Open the market' }, { value: '/start', label: 'Switch person' }] },
      { default: `<div class="app-body">${content}</div>`, actions: `<a class="shell-actions-link" href="/">Market</a>` },
    );

  function deliveries(p, person) {
    const stats = market.driverStats(person);
    const row = (order) =>
      `<div class="delivery">${p.render('order-card', card(order, 'driver'))}${p.render('delivery-actions', { order: order.doc, stage: order.status })}${
        order.status === 'claimed'
          ? `<p class="route">Pick up at <strong>${escape(order.farmName)}</strong>, ${escape(market.brand(order.farm)?.town ?? '')}. <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${order.farmName}, ${market.brand(order.farm)?.town ?? ''}`)}" target="_blank" rel="noopener">Directions to the farm</a></p>`
          : order.status === 'picked'
            ? `<p class="route">Deliver to <strong>${escape(order.address)}</strong>. <a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(order.address)}" target="_blank" rel="noopener">Directions to the door</a></p>`
            : ''
      }</div>`;
    const mine = market.deliveriesFor(person);
    const open = market.openDeliveries();
    return `
      <div class="stats">
        ${p.render('stat-card', { label: 'Waiting to be claimed', value: String(open.length), period: open.length ? 'first come, first served' : 'nothing right now' })}
        ${p.render('stat-card', { label: 'Yours in progress', value: String(mine.length), period: mine.length ? 'see below' : 'claim one to start' })}
        ${p.render('stat-card', { label: 'Earned this week', value: stats.earned, change: stats.weekChange, period: `${stats.week} deliveries at $6 each` })}
      </div>
      <section class="panel"><h2>Your deliveries</h2><div class="stack">${mine.map(row).join('') || render(p, 'empty-state', { heading: 'Nothing in progress' }, { default: 'Claim an open delivery below. You’ll get the farm’s address to pick it up.' })}</div></section>
      <section class="panel"><h2>Open deliveries</h2><div class="stack">${open.map(row).join('') || render(p, 'empty-state', { heading: 'Nothing waiting' }, { default: 'New orders appear here the moment they’re placed.' })}</div></section>`;
  }

  function earnings(p, person) {
    const stats = market.driverStats(person);
    return `
      <div class="stats">
        ${p.render('stat-card', { label: 'Earned this week', value: stats.earned, change: stats.weekChange, period: 'vs the week before' })}
        ${p.render('stat-card', { label: 'Deliveries this week', value: String(stats.week), period: '$6 each, paid by the customer' })}
      </div>
      <section class="panel">${p.render('bar-chart', { items: stats.daily, label: 'Deliveries by day, last 7 days', unit: '' })}</section>`;
  }

  const server = createServer(async (req, res) => {
    try {
      if (await market.sync.handle(req, res)) return;
      if (await actions.handle(req, res)) return;
      if (zubra.handle(req, res)) return;
      const url = new URL(req.url, 'http://localhost');
      const file = files.get(url.pathname);
      if (file) {
        res.writeHead(200, { 'content-type': file[0], 'cache-control': 'public, max-age=86400' });
        return res.end(file[1]);
      }
      const person = personOf(req.headers.cookie ?? '');
      const account = person?.account ? customers.get(person.id) : null;
      const who = staff.session(req);
      const atDesk = staff.can(who, 'staff');
      const owner = staff.can(who, 'owner');
      if (url.pathname.startsWith('/account') || url.pathname.startsWith('/admin')) res.setHeader('cache-control', 'no-store');

      // A shopper's account, the admin's changes, and the staff's sign-in: plain form posts.
      if (req.method === 'POST' && (url.pathname.startsWith('/account/') || url.pathname.startsWith('/admin/') || url.pathname.startsWith('/staff/'))) {
        if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Forbidden');
        const form = await readForm(req);
        if (!form) return send(res, 413, 'Too large');
        const p = zubra.page();
        const problem = (words) => `<p class="notice" role="alert">${escape(words)}</p>`;
        const show = (title, body, status) => page(req, res, url, { title, person, p, body, status });
        if (url.pathname === '/account/sign-up') {
          const made = await customers.signUp({ email: form.get('email'), name: form.get('name'), password: form.get('password') });
          if (made.error) return show('Make an account', accountPages.signUp({ problem: problem(made.error), form }), 422);
          res.setHeader('set-cookie', made.cookie);
          return back(res, withDone('/account', 'Welcome. Your account is ready.'));
        }
        if (url.pathname === '/account/sign-in') {
          const signed = await customers.signIn(form.get('email'), form.get('password'), { client: clientAddress(req, { proxies }) });
          if (signed.error) return show('Sign in', accountPages.signIn({ problem: problem(signed.error === 'locked' ? 'Too many tries. Wait 15 minutes, or reset your password.' : 'That email and password don’t match.'), email: String(form.get('email') ?? '') }), 401);
          res.setHeader('set-cookie', signed.cookie);
          return back(res, '/account');
        }
        if (url.pathname === '/account/sign-out') {
          res.setHeader('set-cookie', (await customers.signOut(req)).cookie);
          return back(res, '/');
        }
        if (url.pathname === '/account/forgot') {
          const email = String(form.get('email') ?? '').trim().toLowerCase();
          const raw = await customers.resetToken(email);
          const one = raw && customers.list().find((c) => c.email === email);
          if (one) {
            const link = `${origin(req)}/account/reset?token=${raw}`;
            await notify.notify({ email: one.email }, 'reset', { name: one.name, link });
            if (!production) console.log(`Password reset for ${one.email}: ${link}`);
          }
          return show('Reset your password', accountPages.forgot({ sent: true }));
        }
        if (url.pathname === '/account/reset') {
          const raw = String(form.get('token') ?? '');
          const reset = await customers.reset(raw, form.get('password'));
          if (reset.error) return show('Choose a new password', accountPages.reset({ token: raw, problem: problem(reset.error), works: customers.peek(raw) }), 422);
          res.setHeader('set-cookie', reset.cookie);
          return back(res, withDone('/account', 'Your new password is saved.'));
        }
        if (url.pathname === '/account/profile') {
          if (!account) return back(res, '/account/sign-in');
          const renamed = await customers.rename(account.customer, form.get('name'));
          return back(res, renamed.ok ? withDone('/account', 'Saved.') : withProblem('/account', renamed.error));
        }
        if (url.pathname.startsWith('/admin/')) {
          if (!owner) return back(res, '/admin');
          const action = url.pathname.match(/^\/admin\/shoppers\/(c[a-z0-9]+)\/(disabled|reset)$/);
          const one = action && customers.get(action[1]);
          if (one && action[2] === 'disabled') {
            const off = form.get('disabled') === 'yes';
            await customers.setDisabled(one.customer, off);
            await market.audit(who, `${off ? 'turned off' : 'turned back on'} ${one.name}’s account`, one.customer);
            return back(res, withDone(`/admin/shoppers/${one.customer}`, off ? 'Turned off and signed out everywhere.' : 'Turned back on.'));
          }
          if (one) {
            const raw = await customers.resetToken(one.email);
            if (!raw) return back(res, withProblem(`/admin/shoppers/${one.customer}`, 'That account is turned off.'));
            await notify.notify({ email: one.email }, 'reset', { name: one.name, link: `${origin(req)}/account/reset?token=${raw}` });
            await market.audit(who, `emailed ${one.name} a reset link`, one.customer);
            return back(res, withDone(`/admin/shoppers/${one.customer}`, 'Sent. It’s in the outbox.'));
          }
          return send(res, 404, 'Not found');
        }
        if (await staffSite.handle(req, res, url, form)) return;
        return send(res, 404, 'Not found');
      }

      // The cart's and checkout's forms are the kit's components, posting to plain routes. The
      // session cookie is SameSite=Lax, so another site's form arrives signed out; a browser that
      // says the post is cross-site is refused as well.
      if (req.method === 'POST' && (url.pathname === '/cart/change' || url.pathname === '/checkout')) {
        if (req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, 'Forbidden');
        const form = await readForm(req);
        if (!form) return send(res, 413, 'Too large');
        if (url.pathname === '/cart/change') {
          const done = await market.changeCart(person, form);
          return back(res, done.error ? `/cart?problem=${encodeURIComponent(done.error)}` : '/cart');
        }
        const done = await market.checkout(person, form);
        return back(res, done.error ? `/checkout?problem=${encodeURIComponent(done.error)}` : '/orders?done=placed');
      }

      if (url.pathname === '/who' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1000) return send(res, 413, 'Too large');
        }
        const form = new URLSearchParams(body);
        const known = market.people[form.get('who') ?? ''];
        const home = { farmer: '/farm', customer: '/', driver: '/drive' };
        res.writeHead(303, { location: known ? home[known.role] : '/start', ...(known ? { 'set-cookie': session.cookie(known.id) } : {}) });
        return res.end();
      }

      const logo = url.pathname.match(/^\/logos\/([a-z0-9-]+)\.webp$/);
      if (logo) {
        const file = market.logoFile(logo[1]);
        if (!file) return send(res, 404, 'No logo');
        res.writeHead(200, { 'content-type': file.type, 'cache-control': 'public, max-age=31536000, immutable' });
        return res.end(file.body);
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (await staffSite.handle(req, res, url, null)) return;
      const p = zubra.page();

      // A shopper's account pages.
      if (url.pathname === '/account') return account ? page(req, res, url, { title: 'Your account', person, p, body: accountPages.account({ market, person, said: said(url) }) }) : back(res, '/account/sign-in');
      if (url.pathname === '/account/sign-in') return account ? back(res, '/account') : page(req, res, url, { title: 'Sign in', person, p, body: accountPages.signIn({ problem: said(url) }) });
      if (url.pathname === '/account/sign-up') return account ? back(res, '/account') : page(req, res, url, { title: 'Make an account', person, p, body: accountPages.signUp() });
      if (url.pathname === '/account/forgot') return page(req, res, url, { title: 'Reset your password', person, p, body: accountPages.forgot() });
      if (url.pathname === '/account/reset') {
        const raw = url.searchParams.get('token') ?? '';
        return page(req, res, url, { title: 'Choose a new password', person, p, body: accountPages.reset({ token: raw, works: customers.peek(raw) }) });
      }

      // The market's admin: its staff only; reports and the outbox for owners.
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        const show = (title, body, status) => page(req, res, url, { title, person, p, body, wide: true, status });
        if (!atDesk) return show('Sign in', staffSite.signIn(url));
        const bar = staffSite.bar(who);
        if (url.pathname === '/admin') return show('Overview', admin.dashboard({ who, owner, bar }));
        if (url.pathname === '/admin/orders') return show('Orders', admin.orders({ url, owner, bar }));
        if (url.pathname === '/admin/orders.csv') return downloadCsv(res, 'orders.csv', admin.ordersCsv(url));
        if (url.pathname === '/admin/farms') return show('Farms', admin.farms({ owner, bar }));
        if (url.pathname === '/admin/drivers') return show('Drivers', admin.drivers({ owner, bar }));
        if (url.pathname === '/admin/shoppers') return show('Shoppers', admin.shoppers({ url, owner, bar }));
        if (url.pathname === '/admin/shoppers.csv') return downloadCsv(res, 'shoppers.csv', admin.shoppersCsv());
        const oneShopper = url.pathname.match(/^\/admin\/shoppers\/(c[a-z0-9]+)$/);
        const one = oneShopper && customers.get(oneShopper[1]);
        if (one) return show(one.name, admin.shopper({ one, owner, bar, said: said(url) }));
        if (['/admin/reports', '/admin/reports.csv', '/admin/outbox'].includes(url.pathname) && !owner) return show('Owners only', '<section><h1>Owners only</h1><p class="lede">Ask an owner to see this page.</p><p><a href="/admin">Back to the overview</a></p></section>', 403);
        if (url.pathname === '/admin/reports') return show('Reports', admin.reports({ url, owner, bar }));
        if (url.pathname === '/admin/reports.csv') return downloadCsv(res, 'sales.csv', admin.reportCsv(url));
        if (url.pathname === '/admin/outbox') return show('Outbox', admin.outbox({ owner, bar }));
        return send(res, 404, 'Not found');
      }

      if (url.pathname === '/start') {
        const as = (id, verb) => `<form method="post" action="/who"><input type="hidden" name="who" value="${id}">${render(p, 'action-button', { type: 'submit', variant: 'outline' }, { default: `${verb} as ${escape(market.people[id].name.split(' ')[0])}` })}</form>`;
        const role = (title, line, ids, verb) => `<section class="role"><h2>${title}</h2><p>${line}</p><div class="as">${ids.map((id) => as(id, verb)).join('')}</div></section>`;
        return page(req, res, url, {
          title: 'Start',
          person,
          p,
          body: `<style>.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1.25rem}.role{display:grid;gap:.6rem;align-content:start;padding:1.5rem;border-radius:var(--radius);background:var(--card);box-shadow:0 0 0 1px var(--tg-line);border-top:6px solid var(--tg-pine)}.role:nth-child(2){border-top-color:#9b2d20}.role:nth-child(3){border-top-color:var(--tg-amber)}.role p{margin:0;color:var(--tg-muted)}.as{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.4rem}</style>
<section><h1>Who are you today?</h1><p class="lede">Tailgate is a demo with no accounts yet. Pick someone and see the market as they do. Switch any time from the top of the page.</p></section>
<div class="roles">
  ${role('Shop', 'Fill a cart from farms nearby and pay once. A neighbour drives each farm’s order to your door.', ['rosa', 'sam'], 'Shop')}
  ${role('Sell', 'List what you have, set your prices, and dress your stall in your own colours and logo.', ['hilltop', 'meadow', 'bearrun'], 'Sell')}
  ${role('Drive', 'Claim deliveries on your way, pick up at the farm, and earn $6 for each one.', ['jules', 'kai'], 'Drive')}
</div>`,
        });
      }

      if (url.pathname === '/') {
        const farms = market.farms.map((farm) => ({ value: farm.id, label: market.brand(farm.id).name }));
        return page(req, res, url, {
          title: 'Market',
          person,
          p,
          body: `<section class="hero"><h1>Farm to door</h1><p class="lede">${market.farms.length} farms in the mountains of Western Maryland and West Virginia, one cart, one payment. Order by noon and a neighbour brings each farm’s order to your door the same day.</p><div class="actions"><a class="go" href="#fresh">Shop what’s fresh</a>${person ? '' : '<a class="ghost" href="/account/sign-up">Make an account</a><a class="ghost" href="/start">Try it as someone else</a>'}</div></section>
<div class="steps3"><div><h3>Shop</h3><p>Fill one cart from several farms and pay once. Follow each farm’s order to your door.</p></div><div><h3>Sell</h3><p>Farmers list what they have, set prices and dress their stall, even with no signal in the field.</p></div><div><h3>Drive</h3><p>Neighbours claim deliveries on their way, pick up at the farm, and earn ${money(market.DELIVERY_CENTS)} each.</p></div></div>
<section aria-labelledby="stalls"><div class="section-head"><h2 id="stalls">The farms</h2><p>Each farm runs its own stall.</p></div><div class="stalls">${market.farms.map((farm) => stall(p, farm.id)).join('')}</div></section>
<section aria-labelledby="fresh"><div class="section-head"><h2 id="fresh">For sale today</h2>${person?.role === 'customer' ? '' : '<p><a href="/start">Choose a shopper</a> to order.</p>'}</div>${p.render('market-grid', { items: market.catalog(), farms, canOrder: person?.role === 'customer' })}</section>`,
        });
      }

      const storefront = url.pathname.match(/^\/farms\/([a-z0-9-]+)$/);
      if (storefront) {
        const b = market.brand(storefront[1]);
        if (!b) return send(res, 404, 'No such farm');
        const items = market.catalog(b.farm);
        const cards = items.map((listing) => p.render('produce-card', { ...listing, showFarm: false, canOrder: person?.role === 'customer' })).join('');
        return page(req, res, url, {
          title: b.name,
          person,
          p,
          body: `<div class="storefront" data-theme="${b.theme}" style="--primary:${b.color};--ring:${b.color};--primary-foreground:${inkOn(b.color)};display:grid;gap:2rem;padding:clamp(0rem,2vw,1.5rem);border-radius:calc(var(--radius) * 2);background:var(--background);color:var(--foreground)">
  ${stall(p, b.farm, 'banner', '')}
  <section><div class="section-head"><h2 style="font-family:var(--font-heading)">For sale from ${escape(b.name)}</h2><p><a href="/">Back to all farms</a></p></div>
  <div class="stalls" style="grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))">${cards || render(p, 'empty-state', { heading: 'Sold out for now' }, { default: `${escape(b.name)} has nothing listed right now.` })}</div></section>
</div>`,
        });
      }

      // A problem the cart or checkout sent back with (one of the market's own sentences).
      const problem = notices.read(url).problem;

      if (url.pathname === '/cart') {
        if (person?.role !== 'customer') return page(req, res, url, { title: 'Cart', person, p, body: ask(p, 'shopper', 'fill a cart') });
        const view = market.cart(person);
        return page(req, res, url, {
          title: 'Your cart',
          person,
          p,
          body: `<section><h1>Your cart</h1><p class="lede">Fill it from as many farms as you like and pay once. Each farm’s goods come as their own delivery.</p></section>
${problem ? render(p, 'alert-banner', { variant: 'danger' }, { default: escape(problem) }) : ''}
<section class="cart">${p.render('cart-panel', { cart: view, fees: view.fees, change: '/cart/change', checkout: '/checkout', heading: 'In your cart' })}<p><a href="/">Keep shopping</a></p></section>`,
        });
      }

      if (url.pathname === '/checkout') {
        if (person?.role !== 'customer') return page(req, res, url, { title: 'Checkout', person, p, body: ask(p, 'shopper', 'check out') });
        const view = market.cart(person);
        if (!view.lines.length) return back(res, '/cart');
        return page(req, res, url, {
          title: 'Checkout',
          person,
          p,
          body: `<section><h1>Checkout</h1><p class="lede">One payment for everything. Each farm’s order goes out to the drivers as soon as it’s paid.</p></section>
<section class="checkout">${p.render('checkout-form', { cart: view, fees: view.fees, place: '/checkout', checkout: market.checkoutKey(), delivery: true, problem, testMode: true, name: person.name, email: person.email ?? '', address: person.address })}<p><a href="/cart">Back to your cart</a></p></section>`,
        });
      }

      if (url.pathname === '/orders') {
        if (person?.role !== 'customer') return page(req, res, url, { title: 'Orders', person, p, body: ask(p, 'shopper', 'see their orders') });
        const all = market.ordersFor(person);
        const active = all.filter((order) => order.status !== 'delivered');
        const past = all.filter((order) => order.status === 'delivered').slice(0, 12);
        return page(req, res, url, {
          title: 'My orders',
          person,
          p,
          body: `<section><h1>My orders</h1><p class="lede">Each farm’s order is its own delivery. They update by themselves as drivers move them along.</p></section>
<section><div class="section-head"><h2>On the way</h2><p>These update by themselves.</p></div><div class="stack">${active.map((order) => p.render('order-card', card(order, 'customer'))).join('') || render(p, 'empty-state', { heading: 'Nothing on the way' }, { default: 'Order something from the market and follow it here.', actions: p.render('action-button', { href: '/' }, { default: 'Go to the market' }) })}</div></section>
${past.length ? `<section><div class="section-head"><h2>Earlier orders</h2></div><div class="stalls" style="grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))">${past.map((order) => p.render('order-card', card(order, 'customer', true))).join('')}</div></section>` : ''}`,
        });
      }

      const farmPage = url.pathname.match(/^\/farm(?:\/(stock|orders|storefront))?$/);
      if (farmPage) {
        if (person?.role !== 'farmer') return page(req, res, url, { title: 'Farm', person, p, body: ask(p, 'farmer', 'manage their farm') });
        const section = farmPage[1] ?? 'overview';
        const b = market.brand(person.farm);
        const content =
          section === 'overview'
            ? farmOverview(p, person)
            : section === 'stock'
              ? `<p class="lede">What you have for sale. Edits save on this device first, so you can update stock in the field, and reach the market when you have signal.</p>${p.render('farm-stock', { doc: person.farm })}`
              : section === 'orders'
                ? farmBoard(p, person)
                : p.render('storefront-editor', { farm: person.farm, nameNow: b.name, taglineNow: b.tagline, colorNow: b.color, themeNow: b.theme, logoNow: b.logo, town: b.town });
        const heading = { overview: 'Overview', stock: 'Stock', orders: 'Orders', storefront: 'Your stall' }[section];
        return app(req, res, url, { title: heading, p, color: b.color, shell: farmShell(p, person, section, heading, content) });
      }

      const drivePage = url.pathname.match(/^\/drive(?:\/(earnings))?$/);
      if (drivePage) {
        if (person?.role !== 'driver') return page(req, res, url, { title: 'Drive', person, p, body: ask(p, 'driver', 'claim deliveries') });
        const section = drivePage[1] ?? 'deliveries';
        const content = section === 'earnings' ? earnings(p, person) : deliveries(p, person);
        return app(req, res, url, { title: section === 'earnings' ? 'Earnings' : 'Deliveries', p, chart: '#e3a21a', shell: driveShell(p, person, section, section === 'earnings' ? 'Earnings' : 'Deliveries', content) });
      }

      send(res, 404, 'Not found');
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Something went wrong.');
      else res.end();
    }
  });

  server.on('close', () => market.close());
  return Object.assign(server, { market, customers, staff, sent: mail.sent });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createApp();
  if (server.staff.needsOwner()) console.log(`Set up the market's first admin (works once, for a day): http://localhost:${port}/staff/accept?token=${await server.staff.setup()}`);
  server.listen(port, '0.0.0.0', () => console.log(`Tailgate on http://localhost:${port}`));
}
