// Tailgate: farm to door, on one small Node server.
//
// - Pages are rendered here by @zubra/server and hydrated in the browser.
// - Farmers' stock and every order's live status are Sync documents (@zubra/sync), kept in one
//   SQLite log, which src/market.js also reads, so the server always knows the current state.
// - Anything two people could both want (ordering the last crate, claiming a delivery) is a
//   'use server' function (@zubra/actions): a plain form post, with or without JavaScript.
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZubra } from '@zubra/server';
import { createActions } from '@zubra/actions';
import { createMarket } from './src/market.js';
import { sessions } from './src/session.js';
import { layout, escape } from './src/layout.js';

const here = dirname(fileURLToPath(import.meta.url));
const components = join(here, 'components');

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

  function send(res, status, html, headers = {}) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
    res.end(html);
  }

  function page(req, res, { title, path, person, body, page }) {
    // Without JavaScript, an action's error comes back once in a cookie; show it on the page.
    const result = actions.result(req, (name, value) => res.setHeader(name, value));
    const problem = result?.value?.error ?? (result?.error ? 'Something went wrong. Try again.' : '');
    send(res, 200, page.finish(layout({ title, path, person, people: market.people, problem, body, actionsScript: actions.script() })));
  }

  const needs = (role, person) => person?.role === role;
  const ask = (role) =>
    `<section class="ask"><h1>Choose a ${role}</h1><p>This page is for ${role}s. Pick one in the bar above to see it as they do.</p></section>`;

  const server = createServer(async (req, res) => {
    try {
      if (await market.sync.handle(req, res)) return;
      if (await actions.handle(req, res)) return;
      if (zubra.handle(req, res)) return;

      const url = new URL(req.url, 'http://localhost');
      const person = session.read(req.headers.cookie ?? '');

      if (url.pathname === '/who' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1000) return send(res, 413, 'Too large');
        }
        const id = new URLSearchParams(body).get('who') ?? '';
        const back = new URLSearchParams(body).get('back') ?? '/';
        const known = market.people[id];
        const home = { farmer: '/farm', customer: '/', driver: '/drive' };
        const to = known ? (back === '/' || back === '/farm' || back === '/orders' || back === '/drive' ? (back === '/' ? home[known.role] : back) : '/') : '/';
        res.writeHead(303, { location: to, ...(known ? { 'set-cookie': session.cookie(id) } : {}) });
        return res.end();
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const p = zubra.page();

      if (url.pathname === '/') {
        const items = market.catalog();
        const cards = items
          .map((listing) => p.render('produce-card', { ...listing, canOrder: needs('customer', person) }))
          .join('\n');
        const hint = needs('customer', person) ? '' : '<p class="hint">Pick a customer in the bar above to order.</p>';
        return page(req, res, {
          title: 'Market',
          path: '/',
          person,
          page: p,
          body: `<section><h1>What's fresh today</h1>${hint}<div class="grid">${cards || '<p class="hint">Nothing is listed right now.</p>'}</div></section>`,
        });
      }

      if (url.pathname === '/farm') {
        if (!needs('farmer', person)) return page(req, res, { title: 'Farm', path: '/farm', person, page: p, body: ask('farmer') });
        const incoming = market.ordersForFarm(person.farm).map((order) => p.render('order-card', card(order, 'farmer'))).join('\n');
        return page(req, res, {
          title: 'Your stock',
          path: '/farm',
          person,
          page: p,
          body: `<section><h1>${escape(market.farmName(person.farm))}: your stock</h1>
<p class="hint">Edits save on this device first and reach the market when you're online.</p>
${p.render('farm-stock', { doc: person.farm })}</section>
<section><h2>Orders for your farm</h2><div class="stack">${incoming || '<p class="hint">No orders yet.</p>'}</div></section>`,
        });
      }

      if (url.pathname === '/orders') {
        if (!needs('customer', person)) return page(req, res, { title: 'Orders', path: '/orders', person, page: p, body: ask('customer') });
        const mine = market.ordersFor(person).map((order) => p.render('order-card', card(order, 'customer'))).join('\n');
        return page(req, res, {
          title: 'Your orders',
          path: '/orders',
          person,
          page: p,
          body: `<section><h1>Your orders</h1><p class="hint">Delivering to ${escape(person.address)}. Pay on delivery.</p><div class="stack">${mine || '<p class="hint">No orders yet. <a href="/">Go to the market.</a></p>'}</div></section>`,
        });
      }

      if (url.pathname === '/drive') {
        if (!needs('driver', person)) return page(req, res, { title: 'Drive', path: '/drive', person, page: p, body: ask('driver') });
        const row = (order) =>
          `<div class="delivery">${p.render('order-card', card(order, 'driver'))}${p.render('delivery-actions', { order: order.doc, stage: order.status })}${
            order.status === 'picked' ? `<p class="hint"><a href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(order.address)}" rel="noopener" target="_blank">Directions to ${escape(order.address)}</a></p>` : ''
          }</div>`;
        const mine = market.deliveriesFor(person).map(row).join('\n');
        const open = market.openDeliveries().map(row).join('\n');
        return page(req, res, {
          title: 'Deliveries',
          path: '/drive',
          person,
          page: p,
          body: `<section><h1>Your deliveries</h1><div class="stack">${mine || '<p class="hint">None right now. Claim one below.</p>'}</div></section>
<section><h2>Open deliveries</h2><div class="stack">${open || '<p class="hint">Nothing waiting.</p>'}</div></section>`,
        });
      }

      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('ok');
      }
      send(res, 404, 'Not found');
    } catch (error) {
      console.error(error);
      if (!res.headersSent) send(res, 500, 'Something went wrong.');
      else res.end();
    }
  });

  /** An order as `order-card`'s props: the static parts, and where its live status starts. */
  function card(order, viewer) {
    return {
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
    };
  }

  server.on('close', () => market.close());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = await createApp();
  server.listen(port, '0.0.0.0', () => console.log(`Tailgate on http://localhost:${port}`));
}
