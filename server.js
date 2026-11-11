// Tailgate: farm to door, on one small Node server.
//
// - Pages are rendered here by @zubra/server and hydrated in the browser.
// - Farmers' stock, each farm's storefront, and every order's live status are Sync documents
//   (@zubra/sync) in one SQLite log, which src/market.js also reads, so the server always knows
//   the current state.
// - Anything two people could both want (ordering the last crate, claiming a delivery) is a
//   'use server' function (@zubra/actions): a plain form post, with or without JavaScript.
// - The controls, charts, dashboards and themes are Zubra UI, installed with `npx shadcn add`.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createActions } from '@zubra/actions';
import { createMarket, THEMES } from './src/market.js';
import { sessions } from './src/session.js';
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

export async function createApp({ db = join(process.env.DATA_DIR ?? here, 'tailgate.db'), cache = true, secret = process.env.SESSION_SECRET } = {}) {
  if (!secret) {
    if (process.env.NODE_ENV === 'production') throw new Error('Set SESSION_SECRET.');
    secret = 'tailgate-development-only';
  }
  const market = await createMarket({ db });
  const session = sessions({ secret, people: market.people });
  market.identify((request) => session.fromRequest(request));

  const zubra = createZubra({ components, cache });
  const actions = await createActions({
    components,
    context: ({ request }) => ({ market, person: session.fromRequest(request) }),
  });
  const files = assets();

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
      ? p.render('alert-banner', { variant: 'danger' }, { default: escape(problem) })
      : done
        ? `<noscript>${p.render('alert-banner', { variant: 'success' }, { default: escape(done) })}</noscript>`
        : '';
    return { banner, done };
  }

  function page(req, res, url, { title, person, body, p }) {
    const { banner, done } = outcome(req, res, p, url);
    const avatar = person ? p.render('user-avatar', { name: person.name, size: 'sm' }) : '';
    const toasts = p.render('toast-region', {});
    const html = layout({ title, path: url.pathname, person, banner, body, done, avatar, actionsScript: actions.script() }).replace('<toast-region></toast-region>', toasts);
    send(res, 200, p.finish(html));
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
    `<section>${p.render('empty-state', { heading: `This page is for ${role}s` }, { default: `Choose a ${role} to ${verb}.`, actions: `<a class="button-light" href="/start">Choose who you are</a>` })}</section>`;

  // ---- Farmer dashboard ----------------------------------------------------------------------
  const FARM_NAV = [
    { id: 'overview', label: 'Overview', href: '/farm' },
    { id: 'stock', label: 'Stock', href: '/farm/stock' },
    { id: 'orders', label: 'Orders', href: '/farm/orders' },
    { id: 'storefront', label: 'Storefront', href: '/farm/storefront' },
  ];
  function farmShell(p, person, current, heading, content) {
    const b = market.brand(person.farm);
    return p.render(
      'dashboard-shell',
      {
        product: b.name,
        heading,
        nav: FARM_NAV,
        current,
        user: person.name,
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
        <section class="panel">${stock.length ? p.render('bar-chart', { items: stock, label: 'Stock on hand', unit: ' left' }) : p.render('empty-state', { heading: 'Nothing listed' }, { default: 'Add what you have on the Stock page.' })}</section>
        <section class="panel"><h2>Latest orders</h2><div class="stack">${recent.map((order) => p.render('order-card', card(order, 'farmer', true))).join('') || p.render('empty-state', { heading: 'No orders yet' }, { default: 'They show up here as customers place them.' })}</div></section>
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
          return p.render('kanban-column', { heading, count: all.filter((order) => order.status === status).length }, { default: cards.map((order) => p.render('order-card', card(order, 'farmer', true))).join('') });
        })
        .join('')}</div>`;
  }

  // ---- Driver dashboard ----------------------------------------------------------------------
  const DRIVE_NAV = [
    { id: 'deliveries', label: 'Deliveries', href: '/drive' },
    { id: 'earnings', label: 'Earnings', href: '/drive/earnings' },
  ];
  const driveShell = (p, person, current, heading, content) =>
    p.render(
      'dashboard-shell',
      { product: 'Tailgate for drivers', heading, nav: DRIVE_NAV, current, user: person.name, menu: [{ value: '/', label: 'Open the market' }, { value: '/start', label: 'Switch person' }] },
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
      <section class="panel"><h2>Your deliveries</h2><div class="stack">${mine.map(row).join('') || p.render('empty-state', { heading: 'Nothing in progress' }, { default: 'Claim an open delivery below. You’ll get the farm’s address to pick it up.' })}</div></section>
      <section class="panel"><h2>Open deliveries</h2><div class="stack">${open.map(row).join('') || p.render('empty-state', { heading: 'Nothing waiting' }, { default: 'New orders appear here the moment they’re placed.' })}</div></section>`;
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
      const person = session.read(req.headers.cookie ?? '');

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
      const p = zubra.page();

      if (url.pathname === '/start') {
        const as = (id, verb) => `<form method="post" action="/who"><input type="hidden" name="who" value="${id}">${p.render('action-button', { type: 'submit', variant: 'outline' }, { default: `${verb} as ${escape(market.people[id].name.split(' ')[0])}` })}</form>`;
        const role = (title, line, ids, verb) => `<section class="role"><h2>${title}</h2><p>${line}</p><div class="as">${ids.map((id) => as(id, verb)).join('')}</div></section>`;
        return page(req, res, url, {
          title: 'Start',
          person,
          p,
          body: `<style>.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(16rem,1fr));gap:1.25rem}.role{display:grid;gap:.6rem;align-content:start;padding:1.5rem;border-radius:var(--radius);background:var(--card);box-shadow:0 0 0 1px var(--tg-line);border-top:6px solid var(--tg-pine)}.role:nth-child(2){border-top-color:#9b2d20}.role:nth-child(3){border-top-color:var(--tg-amber)}.role p{margin:0;color:var(--tg-muted)}.as{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.4rem}</style>
<section><h1>Who are you today?</h1><p class="lede">Tailgate is a demo with no accounts yet. Pick someone and see the market as they do. Switch any time from the top of the page.</p></section>
<div class="roles">
  ${role('Shop', 'Order from farms nearby. A neighbour drives it to your door, and you pay when it arrives.', ['rosa', 'sam'], 'Shop')}
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
          body: `<section><h1>This week at the market</h1><p class="lede">${market.farms.length} farms in the mountains of Western Maryland and West Virginia. Order by noon and a neighbour brings it to your door the same day.</p></section>
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
  <div class="stalls" style="grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))">${cards || p.render('empty-state', { heading: 'Sold out for now' }, { default: `${escape(b.name)} has nothing listed right now.` })}</div></section>
</div>`,
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
          body: `<section><h1>My orders</h1><p class="lede">Delivering to ${escape(person.address)}. You pay the driver when it arrives.</p></section>
<section><div class="section-head"><h2>On the way</h2><p>These update by themselves.</p></div><div class="stack">${active.map((order) => p.render('order-card', card(order, 'customer'))).join('') || p.render('empty-state', { heading: 'Nothing on the way' }, { default: 'Order something from the market and follow it here.', actions: p.render('action-button', { href: '/' }, { default: 'Go to the market' }) })}</div></section>
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
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createApp();
  server.listen(port, '0.0.0.0', () => console.log(`Tailgate on http://localhost:${port}`));
}
