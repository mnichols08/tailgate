// The market: what the server knows, and the only things only the server may do.
//
// Everything lives in one place, the Sync log (a SQLite file). Farmers write their own stock
// into it from their devices, offline included. The server reads the same log through `ledger`
// (below), so it always knows each document's current fields, and it writes back into the log
// itself when something two people could both want has to be decided: an order taking the last
// crate, a driver claiming a delivery. Those writes go out on the live stream like anyone's, so
// every open page follows.
import { createSyncServer } from '@zubra/sync/server';
import { sqliteLog } from '@zubra/sync/sqlite';
import { createStages } from '@potomac-solutions/kit/stages';
import { createCatalog } from '@potomac-solutions/kit/catalog';
import { createCart } from '@potomac-solutions/kit/cart';
import { createCheckout } from '@potomac-solutions/kit/checkout';
import { createPay, testProvider } from '@potomac-solutions/kit/pay';
import { people, farms as seedFarms, listings as seedListings, history, underway, DELIVERY_CENTS } from './seed.js';

/** The Zubra UI theme presets a farm can dress its storefront in. */
export const THEMES = ['paper', 'zinc', 'candy', 'midnight', 'terminal'];

const pad = (number, width) => String(number).padStart(width, '0');

/** A hybrid logical clock for the server's own writes (the same shape the devices use). */
function serverClock(device = 'server') {
  let last = 0;
  let counter = 0;
  const tick = (seen = 0) => {
    const now = Math.max(Date.now(), last, seen);
    counter = now === last ? counter + 1 : 0;
    last = now;
    return `${pad(now, 15)}-${pad(counter, 5)}-${device}`;
  };
  return { tick, see: (stamp) => tick(Number(stamp.slice(0, 15))) };
}

/**
 * Documents as the log says they are now: per field, the write with the latest clock wins, the
 * same rule every device applies. `apply` is synchronous on purpose: a check followed by a write
 * with no `await` between them can't be interleaved with another request.
 */
function ledger() {
  const docs = new Map();
  return {
    apply(change) {
      const id = `${change.collection}/${change.key}`;
      let doc = docs.get(id);
      if (!doc) docs.set(id, (doc = { collection: change.collection, key: change.key, fields: {}, clocks: {} }));
      const known = doc.clocks[change.field];
      if (known && known >= change.clock) return;
      doc.clocks[change.field] = change.clock;
      doc.fields[change.field] = change.value;
    },
    get: (collection, key) => docs.get(`${collection}/${key}`)?.fields,
    all: (collection) => [...docs.values()].filter((doc) => doc.collection === collection).map((doc) => ({ key: doc.key, ...doc.fields })),
  };
}

/** What the kit's answers mean, in Tailgate's words. */
function words(answer) {
  if (answer.ok) return answer;
  const said = {
    gone: 'That listing is gone.',
    'sold-out': answer.left > 0 ? `Only ${answer.left} left.` : 'Sold out.',
    'too-many': `You can have up to ${answer.max}.`,
    'bad-qty': 'Choose how many, from 1 to 99.',
    empty: 'Your cart is empty.',
    'not-ready': 'Something in your cart sold out. Check your cart and try again.',
    declined: 'That card was declined. Try another.',
    'in-progress': 'That order is already going through.',
    'not-yours': 'That checkout has expired. Try again.',
  }[answer.error];
  return { error: said ?? 'That didn’t go through. Try again.' };
}

/** The checkout keys this server makes (see `checkoutKey`). Anything else is refused. */
const CHECKOUT_KEY = /^c[a-z0-9]{6,24}$/;

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const toCents = (price) => Math.round(Number(price) * 100);

export async function createMarket({ db = ':memory:' } = {}) {
  const inner = await sqliteLog(db);
  const docs = ledger();
  const clock = serverClock();

  // Replay the log so the server starts knowing what every device knows.
  for (let cursor = 0; ; ) {
    const { changes, cursor: next } = await inner.after(cursor, 5000);
    for (const change of changes) {
      docs.apply(change);
      clock.see(change.clock);
    }
    if (!changes.length) break;
    cursor = next;
  }

  // The log the Sync server uses: the SQLite file, with every change also applied to `docs`.
  const log = {
    async append(changes) {
      for (const change of changes) {
        docs.apply(change);
        clock.see(change.clock);
      }
      return inner.append(changes);
    },
    after: (cursor, limit) => inner.after(cursor, limit),
  };

  // The server's own pushes go through the Sync server, so they reach the live streams. They are
  // the only requests allowed to write `orders`; WeakSet membership can't be forged by a client.
  const internal = new WeakSet();
  let who = () => null;

  const sync = createSyncServer({
    log,
    authorize({ request, collection, key, write }) {
      if (!write) return true;
      if (internal.has(request)) return true;
      const person = who(request);
      // Joining a document's presence room (who is looking) counts as a write to the Sync server,
      // but it stores nothing. Anyone signed in may join; data writes follow the rules below.
      const path = new URL(request.url).pathname;
      if (path.endsWith('/presence') || path.endsWith('/signal')) return Boolean(person);
      if (collection === 'farms' || collection === 'brands') return person?.role === 'farmer' && person.farm === key;
      if (collection === 'listings') return person?.role === 'farmer' && key.startsWith(`${person.farm}/`);
      return false; // orders, and anything else, are the server's
    },
  });

  /** Write fields into the log as the server. Applied first, so the next check sees them. */
  async function write(collection, key, fields) {
    const changes = Object.entries(fields).map(([field, value]) => ({ collection, key, field, value, clock: clock.tick() }));
    for (const change of changes) docs.apply(change);
    const request = new Request('http://tailgate.internal/_zb/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ changes }),
    });
    internal.add(request);
    const response = await sync.fetch(request);
    if (!response?.ok) throw new Error(`The log refused a server write (${response?.status})`);
  }

  // The kit's store: the same documents, read synchronously, written as the server.
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const store = {
    get: (collection, key) => docs.get(collection, key) ?? null,
    under: (collection, prefix = '') => docs.all(collection).filter((doc) => doc.key.startsWith(prefix)).sort(byKey),
    write,
  };

  // An order's journey (placed, claimed, picked up, delivered) is the kit's `stages` module.
  // The market says who the driver is and puts the answers into words.
  const delivery = createStages({
    store,
    collection: 'orders',
    steps: ['placed', 'claimed', 'picked', 'delivered'],
    owner: 'driver',
    stamp: ['delivered'],
  });

  // What's for sale is the kit's `catalog`, over the listings farmers write from their devices:
  // a price in dollars, a count in `qty`, and on sale only while it's on the farm's list. A
  // missing or unreadable count is none left (the kit reads `null` as no limit; a farm has one).
  const farmOf = (key) => key.slice(0, key.indexOf('/'));
  const catalogue = createCatalog({
    store,
    collection: 'listings',
    left: 'qty',
    read: (doc) => ({
      name: String(doc.name ?? '').trim(),
      unit: String(doc.unit ?? 'each').trim() || 'each',
      cents: toCents(doc.price),
      left: Number.isFinite(Number(doc.qty)) && doc.qty !== null && doc.qty !== '' ? Number(doc.qty) : 0,
    }),
    listed: (key) => (docs.get('farms', farmOf(key))?.items ?? []).includes(key.slice(key.indexOf('/') + 1)),
  });

  // A shopper's cart, one charge for all of it, and one order per farm (each farm's goods are
  // picked up on their own, so each is its own delivery and its own fee). Payments are the kit's
  // test provider: no money moves, and the checkout says so.
  const cart = createCart({ store, catalog: catalogue });
  const fees = ({ lines }) => [...new Set(lines.map((line) => farmOf(line.item)))].map((farm) => ({ label: `Delivery from ${farmName(farm)}`, cents: DELIVERY_CENTS, group: farm }));
  const checkout = createCheckout({
    store,
    catalog: catalogue,
    cart,
    pay: createPay({ provider: testProvider(), store }),
    stages: delivery,
    group: (line) => farmOf(line.item),
    fees,
  });

  // A fresh log gets the demo farms, their storefronts, first listings and three weeks of orders.
  if (!docs.all('farms').length) {
    for (const farm of seedFarms) {
      await write('farms', farm.id, { items: seedListings.filter((item) => item.farm === farm.id).map((item) => item.item) });
      const { id, town, ...brand } = farm;
      await write('brands', id, { ...brand, logo: '' });
    }
    for (const { farm, item, ...fields } of seedListings) await write('listings', `${farm}/${item}`, fields);
    for (const { key, ...order } of [...history(), ...underway()]) await write('orders', key, order);
  }

  const seedFarm = (id) => seedFarms.find((farm) => farm.id === id);
  const personName = (id) => people[id]?.name ?? id;

  /** A farm's storefront as its farmer last set it: name, tagline, colour, theme and logo. */
  function brand(id) {
    const base = seedFarm(id);
    if (!base) return null;
    const live = docs.get('brands', id) ?? {};
    const pick = (field) => (typeof live[field] === 'string' && live[field].trim() ? live[field] : base[field] ?? '');
    return {
      farm: id,
      town: base.town,
      name: pick('name'),
      tagline: pick('tagline'),
      color: /^#[0-9a-f]{6}$/i.test(live.color ?? '') ? live.color : base.color,
      theme: THEMES.includes(live.theme) ? live.theme : base.theme,
      logo: typeof live.logo === 'string' && live.logo.startsWith('data:image/') ? live.logo : '',
    };
  }
  const farmName = (id) => brand(id)?.name ?? id;

  /**
   * Logos are kept in the farm's Sync document as a small data URL, and served from
   * `/logos/<farm>.webp`: pages never put a data URL in an `src` (Zubra refuses them).
   * `?v=` changes with the picture, so a new logo shows at once.
   */
  const logoUrl = (id) => {
    const logo = brand(id)?.logo;
    return logo ? `/logos/${id}.webp?v=${logo.length}` : '';
  };
  function logoFile(id) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(brand(id)?.logo ?? '');
    return match ? { type: match[1], body: Buffer.from(match[2], 'base64') } : null;
  }

  const listingsOf = (farm) =>
    (docs.get('farms', farm)?.items ?? []).map((item) => ({ farm, item, ...docs.get('listings', `${farm}/${item}`) }));

  /**
   * What a customer can buy now, from the kit's catalog: listings on a farm's list, named, priced
   * and in stock, in the order each farm lists them.
   */
  function catalog(only) {
    return seedFarms
      .filter((farm) => !only || farm.id === only)
      .flatMap((farm) => {
        const b = brand(farm.id);
        const order = docs.get('farms', farm.id)?.items ?? [];
        return catalogue
          .items(`${farm.id}/`)
          .map((found) => ({ ...found, item: found.key.slice(farm.id.length + 1) }))
          .sort((x, y) => order.indexOf(x.item) - order.indexOf(y.item))
          .map((found) => ({
            farm: farm.id,
            item: found.item,
            name: found.name,
            unit: found.unit,
            price: money(found.cents),
            qty: found.left,
            farmName: b.name,
            farmColor: b.color,
            farmLogo: logoUrl(farm.id),
          }));
      });
  }

  /**
   * An order's lines. An order from the cart (the kit's checkout) has `lines` and its farm in
   * `group`; one placed before the cart, and the demo's history, is one listing.
   */
  const linesOf = (order) => (Array.isArray(order.lines) ? order.lines : [{ item: `${order.farm}/${order.item}`, name: order.itemName, unit: order.unit, qty: order.qty, total: order.cents }]);
  const farmOfOrder = (order) => order.farm ?? order.group;

  const orderView = (order) => {
    const lines = linesOf(order);
    const one = lines.length === 1;
    return {
    doc: order.key,
    farm: farmOfOrder(order),
    itemName: lines.map((line) => line.name).join(', '),
    qty: one ? lines[0].qty : lines.reduce((sum, line) => sum + line.qty, 0),
    unit: one ? lines[0].unit : 'items',
    total: money(order.cents + (order.fee ?? 0)),
    goods: order.cents,
    farmName: farmName(farmOfOrder(order)),
    customerName: personName(order.customer),
    address: order.address,
    status: order.status,
    driverName: order.driver ? personName(order.driver) : '',
    placed: order.placed,
    };
  };
  const newestFirst = (a, b) => b.placed - a.placed;
  const orders = (match) => docs.all('orders').filter(match).sort(newestFirst);

  const DAY = 86_400_000;
  const startOfDay = (time) => {
    const date = new Date(time);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  const dayLabel = (time) => new Date(time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const change = (now, before) => (before && now !== before ? Math.round(((now - before) / before) * 100) : null);

  /** A farm's dashboard: sales, open orders, low stock, and where the money came from. */
  function farmStats(farm, now = Date.now()) {
    const mine = docs.all('orders').filter((order) => farmOfOrder(order) === farm);
    const today = startOfDay(now);
    const sum = (from, to) => mine.filter((o) => o.placed >= from && o.placed < to).reduce((total, o) => total + o.cents, 0);
    const week = sum(today - 6 * DAY, today + DAY);
    const before = sum(today - 13 * DAY, today - 6 * DAY);
    const daily = Array.from({ length: 14 }, (_, i) => {
      const from = today - (13 - i) * DAY;
      return { label: dayLabel(from), value: sum(from, from + DAY) / 100 };
    });
    const byItem = new Map();
    for (const order of mine.filter((o) => o.placed >= today - 29 * DAY)) for (const line of linesOf(order)) byItem.set(line.name, (byItem.get(line.name) ?? 0) + line.total / 100);
    const stock = listingsOf(farm).filter((listing) => String(listing.name ?? '').trim());
    return {
      week: money(week),
      weekChange: change(week, before),
      open: mine.filter((o) => o.status !== 'delivered').length,
      low: stock.filter((listing) => Number(listing.qty) <= 3),
      daily,
      byItem: [...byItem].sort((a, b) => b[1] - a[1]).map(([label, value], i) => ({ label, value: Math.round(value), tone: i % 8 })),
    };
  }

  /** A driver's dashboard: deliveries and pay this week, and how many are waiting. */
  function driverStats(person, now = Date.now()) {
    const today = startOfDay(now);
    const done = docs.all('orders').filter((o) => o.driver === person.id && o.status === 'delivered');
    const count = (from, to) => done.filter((o) => (o.delivered ?? o.placed) >= from && (o.delivered ?? o.placed) < to).length;
    const week = count(today - 6 * DAY, today + DAY);
    const before = count(today - 13 * DAY, today - 6 * DAY);
    return {
      week,
      weekChange: change(week, before),
      earned: money(week * DELIVERY_CENTS),
      open: docs.all('orders').filter((o) => o.status === 'placed' && !o.driver).length,
      daily: Array.from({ length: 7 }, (_, i) => {
        const from = today - (6 - i) * DAY;
        return { label: new Date(from).toLocaleDateString('en-US', { weekday: 'short' }), value: count(from, from + DAY) };
      }),
    };
  }

  return {
    sync,
    people,
    farms: seedFarms,
    brand,
    logoUrl,
    logoFile,
    catalog,
    farmName,
    farmStats,
    driverStats,
    /** `who(request)` tells the Sync server who is writing (the session cookie). */
    identify(fn) {
      who = fn;
    },
    ordersFor: (person) => orders((order) => order.customer === person.id).map(orderView),
    ordersForFarm: (farm) => orders((order) => farmOfOrder(order) === farm).map(orderView),
    openDeliveries: () => orders((order) => order.status === 'placed' && !order.driver).map(orderView),
    deliveriesFor: (person) => orders((order) => order.driver === person.id && order.status !== 'delivered').map(orderView),

    /** A shopper's cart, priced now, with the delivery fees checkout will add (one per farm). */
    cart(person) {
      const view = cart.view(person.id);
      return { ...view, fees: fees({ lines: view.lines.filter((line) => !line.gone) }) };
    },

    /** Put `qty` of a listing in a shopper's cart. Nothing is taken from stock until checkout. */
    async addToCart(person, formData) {
      if (person?.role !== 'customer') return { error: 'Choose a shopper to buy.' };
      const farm = String(formData.get('farm') ?? '');
      const item = String(formData.get('item') ?? '');
      // `qtyFallback` is the form's no-JavaScript stand-in for the quantity stepper.
      const qty = Number(formData.get('qty') ?? formData.get('qtyFallback'));
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { error: 'Choose how many, from 1 to 99.' };
      return words(await cart.add(person.id, `${farm}/${item}`, qty));
    },

    /** Set a cart line's quantity; 0 takes it out. */
    async changeCart(person, form) {
      if (person?.role !== 'customer') return { error: 'Choose a shopper to buy.' };
      const qty = Number(form.get('qty'));
      if (!Number.isInteger(qty) || qty < 0) return { error: 'Choose how many, from 1 to 99.' };
      return words(await cart.set(person.id, String(form.get('item') ?? ''), qty));
    },

    /** A new checkout's key, made when the checkout page is: a second press is the same checkout. */
    checkoutKey: () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,

    /**
     * Check out the whole cart: stock from every farm taken at once, one charge, then one order
     * per farm for the drivers to claim. All or nothing.
     */
    async checkout(person, form) {
      if (person?.role !== 'customer') return { error: 'Choose a shopper to buy.' };
      const key = String(form.get('checkout') ?? '');
      if (!CHECKOUT_KEY.test(key)) return { error: 'That checkout has expired. Try again.' };
      const address = String(form.get('address') ?? '').trim().slice(0, 200) || person.address;
      const done = await checkout.place(person.id, {
        key,
        method: { card: String(form.get('card') ?? '') },
        fields: { customer: person.id, address, driver: '', driverName: '', placed: Date.now() },
        description: 'Tailgate order',
      });
      return done.ok ? { ok: true, orders: done.orders } : words(done);
    },

    /** A driver claims an open delivery. Exactly one driver wins a race. */
    async claim(person, formData) {
      if (person?.role !== 'driver') return { error: 'Choose a driver to claim deliveries.' };
      const answer = await delivery.claim(String(formData.get('order') ?? ''), person.id, { driverName: person.name });
      if (answer.ok) return { ok: true };
      if (answer.error === 'claimed') return { error: answer.yours ? 'Already yours.' : `${personName(answer.by)} took this one.` };
      return { error: answer.error === 'wrong-step' ? `This order is ${answer.at}.` : 'That order is gone.' };
    },

    /** The claiming driver moves the order along: claimed → picked up → delivered. */
    async advance(person, formData, to) {
      const answer = await delivery.advance(String(formData.get('order') ?? ''), to, { by: person?.id });
      if (answer.ok) return { ok: true };
      return { error: answer.error === 'wrong-step' ? `This order is ${answer.at}.` : 'Only the driver on this delivery can update it.' };
    },

    close: () => inner.close(),
  };
}
