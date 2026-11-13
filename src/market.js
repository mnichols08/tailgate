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

  // An order's journey (placed, claimed, picked up, delivered) is the kit's `stages` module.
  // The market says who the driver is and puts the answers into words.
  const delivery = createStages({
    store: { get: (collection, key) => docs.get(collection, key) ?? null, under: (collection, prefix = '') => docs.all(collection).filter((doc) => doc.key.startsWith(prefix)), write },
    collection: 'orders',
    steps: ['placed', 'claimed', 'picked', 'delivered'],
    owner: 'driver',
    stamp: ['delivered'],
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

  /** What a customer can buy now: listings that are on a farm's list, named, priced and in stock. */
  function catalog(only) {
    return seedFarms
      .filter((farm) => !only || farm.id === only)
      .flatMap((farm) => {
        const b = brand(farm.id);
        return listingsOf(farm.id)
          .filter((listing) => String(listing.name ?? '').trim() && Number(listing.price) > 0 && Number(listing.qty) > 0)
          .map((listing) => ({
            farm: listing.farm,
            item: listing.item,
            name: String(listing.name).trim(),
            unit: String(listing.unit ?? 'each').trim() || 'each',
            price: money(toCents(listing.price)),
            qty: Math.floor(Number(listing.qty)),
            farmName: b.name,
            farmColor: b.color,
            farmLogo: logoUrl(farm.id),
          }));
      });
  }

  const orderView = (order) => ({
    doc: order.key,
    farm: order.farm,
    itemName: order.itemName,
    qty: order.qty,
    unit: order.unit,
    total: money(order.cents + (order.fee ?? 0)),
    goods: order.cents,
    farmName: farmName(order.farm),
    customerName: personName(order.customer),
    address: order.address,
    status: order.status,
    driverName: order.driver ? personName(order.driver) : '',
    placed: order.placed,
  });
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
    const mine = docs.all('orders').filter((order) => order.farm === farm);
    const today = startOfDay(now);
    const sum = (from, to) => mine.filter((o) => o.placed >= from && o.placed < to).reduce((total, o) => total + o.cents, 0);
    const week = sum(today - 6 * DAY, today + DAY);
    const before = sum(today - 13 * DAY, today - 6 * DAY);
    const daily = Array.from({ length: 14 }, (_, i) => {
      const from = today - (13 - i) * DAY;
      return { label: dayLabel(from), value: sum(from, from + DAY) / 100 };
    });
    const byItem = new Map();
    for (const order of mine.filter((o) => o.placed >= today - 29 * DAY)) byItem.set(order.itemName, (byItem.get(order.itemName) ?? 0) + order.cents / 100);
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
    ordersForFarm: (farm) => orders((order) => order.farm === farm).map(orderView),
    openDeliveries: () => orders((order) => order.status === 'placed' && !order.driver).map(orderView),
    deliveriesFor: (person) => orders((order) => order.driver === person.id && order.status !== 'delivered').map(orderView),

    /** A customer orders `qty` of a listing. The check and the decrement can't be interleaved. */
    async placeOrder(person, formData) {
      if (person?.role !== 'customer') return { error: 'Choose a customer to order.' };
      const farm = String(formData.get('farm') ?? '');
      const item = String(formData.get('item') ?? '');
      // `qtyFallback` is the order form's no-JavaScript stand-in for the quantity stepper.
      const qty = Number(formData.get('qty') ?? formData.get('qtyFallback'));
      if (!Number.isInteger(qty) || qty < 1 || qty > 100) return { error: 'Choose how many, from 1 to 100.' };
      const listed = (docs.get('farms', farm)?.items ?? []).includes(item);
      const listing = docs.get('listings', `${farm}/${item}`);
      if (!listed || !listing) return { error: 'That listing is gone.' };
      const left = Math.floor(Number(listing.qty) || 0);
      if (left < qty) return { error: left > 0 ? `Only ${left} left.` : 'Sold out.' };
      const key = `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const cents = toCents(listing.price) * qty;
      // Both writes are applied before the first await: a second order sees the new stock.
      const stock = write('listings', `${farm}/${item}`, { qty: left - qty });
      const order = write('orders', key, {
        farm,
        item,
        itemName: String(listing.name).trim(),
        unit: String(listing.unit ?? 'each'),
        qty,
        cents,
        fee: DELIVERY_CENTS,
        customer: person.id,
        address: person.address,
        status: 'placed',
        driver: '',
        driverName: '',
        placed: Date.now(),
      });
      await Promise.all([stock, order]);
      return { ok: true, order: key };
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
