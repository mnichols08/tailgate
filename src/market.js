// The market: what the server knows, and the only things only the server may do.
//
// Everything lives in one place, the Sync log (a SQLite file). Farmers write their own stock
// into it from their devices, offline included. The server reads the same documents
// (`sync.documents()`), so it always knows each one's current fields, and writes into them itself
// (`sync.write()`) when something two people could both want has to be decided: an order taking
// the last crate, a driver claiming a delivery. Those writes go out on the live stream like
// anyone's, so every open page follows.
import { createSyncServer } from '@zubra/sync/server';
import { sqliteLog } from '@zubra/sync/sqlite';
import { people, farms as seedFarms, listings as seedListings, history, underway, DELIVERY_CENTS } from './seed.js';

/** The Zubra UI theme presets a farm can dress its storefront in. */
export const THEMES = ['paper', 'zinc', 'candy', 'midnight', 'terminal'];

const money = (cents) => `$${(cents / 100).toFixed(2)}`;
const toCents = (price) => Math.round(Number(price) * 100);

export async function createMarket({ db = ':memory:' } = {}) {
  let who = () => null;
  const log = await sqliteLog(db);
  const sync = createSyncServer({
    log,
    authorize({ request, collection, key, kind }) {
      if (kind === 'read') return true;
      const person = who(request);
      // Who has an order open (presence) stores nothing: anyone signed in may be in the room.
      if (kind === 'presence') return Boolean(person);
      if (collection === 'farms' || collection === 'brands') return person?.role === 'farmer' && person.farm === key;
      if (collection === 'listings') return person?.role === 'farmer' && key.startsWith(`${person.farm}/`);
      return false; // orders, and anything else, are the server's: it writes them with sync.write()
    },
  });
  // Every document as the devices see it, kept current. Reads are synchronous, so a check and the
  // write after it (with no await between) can't be interleaved with another request.
  const docs = await sync.documents();
  const write = sync.write;

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
      const qty = Number(formData.get('qty'));
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
      const key = String(formData.get('order') ?? '');
      const order = docs.get('orders', key);
      if (!order) return { error: 'That order is gone.' };
      if (order.driver) return { error: order.driver === person.id ? 'Already yours.' : `${personName(order.driver)} took this one.` };
      await write('orders', key, { driver: person.id, driverName: person.name, status: 'claimed' });
      return { ok: true };
    },

    /** The claiming driver moves the order along: claimed → picked up → delivered. */
    async advance(person, formData, to) {
      const key = String(formData.get('order') ?? '');
      const order = docs.get('orders', key);
      if (!order || order.driver !== person?.id) return { error: 'Only the driver on this delivery can update it.' };
      const from = { picked: 'claimed', delivered: 'picked' }[to];
      if (order.status !== from) return { error: `This order is ${order.status}.` };
      await write('orders', key, to === 'delivered' ? { status: to, delivered: Date.now() } : { status: to });
      return { ok: true };
    },

    close: () => log.close(),
  };
}
