// Demo data on top of the market's own: the people who run the market, thirty shopper accounts,
// and four months of delivered orders between them, so the admin and its reports have something
// to show.
//
//   npm run seed            add to a fresh market (refuses if it already has admins)
//   npm run seed -- --fresh start over: delete the database first
//
// A fresh market seeds itself with its farms, the demo people and three weeks of orders; this adds
// to that. The names are made up and every address is @example.com. Run it with the server stopped.
import { existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.js';
import { listings, DELIVERY_CENTS } from '../src/seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const db = join(process.env.DATA_DIR ?? join(here, '..'), 'tailgate.db');
if (process.argv.includes('--fresh')) for (const file of [db, `${db}-wal`, `${db}-shm`]) if (existsSync(file)) rmSync(file);

export const DEMO = {
  owner: { email: 'owner@example.com', name: 'Mara Ellison', password: 'tailgate-owner-demo' },
  staff: { email: 'support@example.com', name: 'Owen Pruitt', password: 'tailgate-staff-demo' },
  customer: { email: 'riley@example.com', name: 'Riley Morgan', password: 'tailgate-shopper-demo' },
};

let seed = 20261115;
const random = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];
const FIRST = ['Avery', 'Blake', 'Casey', 'Drew', 'Emerson', 'Finley', 'Harper', 'Jamie', 'Kendall', 'Logan', 'Morgan', 'Noah', 'Parker', 'Quinn', 'Reese', 'Sawyer', 'Taylor', 'Peyton', 'Rowan', 'Skyler', 'Elliot', 'Hayden', 'Jordan', 'Kai', 'Lane', 'Micah', 'Sasha', 'Tatum', 'Wren', 'Ari'];
const LAST = ['Abbott', 'Barnes', 'Calloway', 'Dunmore', 'Ellison', 'Fairbanks', 'Garrett', 'Holloway', 'Iverson', 'Jessup', 'Kessler', 'Lowry', 'Marsh', 'Nolan', 'Oakley', 'Pruitt', 'Ramsey', 'Sutton', 'Thayer', 'Underwood', 'Vance', 'Whitaker', 'Yates', 'Zeller'];
const TOWNS = ['Oakland, MD', 'Davis, WV', 'Thomas, WV', 'Accident, MD', 'Grantsville, MD', 'Swanton, MD', 'Mountain Lake Park, MD'];
const DAY = 86_400_000;
const NOW = Date.now();

const server = await createApp({ db, cache: false });
const { market, customers, staff } = server;
const { store } = market;
if (!staff.needsOwner()) {
  console.log(`The market in ${db} already has admins. Run \`npm run seed -- --fresh\` to start over.`);
  process.exit(1);
}

await staff.accept(await staff.setup(), DEMO.owner);
const ownerView = staff.list().find((one) => one.email === DEMO.owner.email);
await staff.accept((await staff.invite(ownerView, { email: DEMO.staff.email, name: DEMO.staff.name, roles: ['staff'] })).token, DEMO.staff);
const support = staff.list().find((one) => one.email === DEMO.staff.email);

const accounts = [];
const riley = await customers.signUp(DEMO.customer);
accounts.push({ id: riley.customer, ...DEMO.customer, at: NOW - 125 * DAY });
for (let i = 0; i < 30; i++) {
  const name = `${pick(FIRST)} ${pick(LAST)}`;
  const made = await customers.signUp({ name, email: `${name.toLowerCase().replace(' ', '.')}${i}@example.com`, password: `demo-password-${i}-${Math.floor(random() * 1e6)}` });
  if (made.ok) accounts.push({ id: made.customer, name, at: NOW - Math.floor(random() * 125 + 1) * DAY });
}
for (const one of accounts) await store.write('customers', one.id, { at: one.at });
await customers.setDisabled(accounts.at(-1).id, true);

// Four months of delivered orders from the accounts, busier at weekends, before the market's own
// three weeks of history.
const drivers = [['jules', 'Jules Friend'], ['kai', 'Kai Sines']];
let added = 0;
for (let day = 120; day >= 1; day--) {
  const at = NOW - day * DAY;
  const weekend = [0, 6].includes(new Date(at).getUTCDay());
  const count = Math.round((weekend ? 6 : 3) * (0.5 + random()));
  for (let n = 0; n < count; n++) {
    const joined = accounts.slice(0, -1).filter((one) => one.at < at);
    if (!joined.length) continue;
    const who = random() < 0.08 ? accounts[0] : pick(joined);
    const listing = pick(listings);
    const qty = 1 + Math.floor(Math.pow(random(), 2) * 4);
    const placed = at + Math.floor(7 + random() * 12) * 3_600_000 + Math.floor(random() * 60) * 60_000;
    if (placed > NOW - 3_600_000) continue;
    const [driver, driverName] = pick(drivers);
    await store.write('orders', `s${placed.toString(36)}${n}`, {
      farm: listing.farm, item: listing.item, itemName: listing.name, unit: listing.unit, qty,
      cents: Math.round(listing.price * 100) * qty, fee: DELIVERY_CENTS,
      customer: who.id, address: `${10 + Math.floor(random() * 300)} ${pick(['Main St', 'Ridge Rd', 'Pine Ln', 'Lake Shore Dr', 'Church St'])}, ${pick(TOWNS)}`,
      status: 'delivered', driver, driverName, placed, delivered: placed + Math.floor(90 + random() * 240) * 60_000,
    });
    added++;
  }
}
await market.audit(support, 'emailed a shopper a reset link');
await market.audit(ownerView, 'invited Owen Pruitt to the staff');

console.log(`Seeded ${db}:
  ${accounts.length} shopper accounts, ${added} past orders (plus the market's own three weeks and four in progress).

Sign in (this machine only; these are demo passwords):
  Admin owner  ${DEMO.owner.email} / ${DEMO.owner.password}     → /admin
  Admin staff  ${DEMO.staff.email} / ${DEMO.staff.password}   → /admin
  Shopper      ${DEMO.customer.email} / ${DEMO.customer.password}   → /account
  Or pick a demo farmer, driver or shopper on /start.

Then: npm start`);
process.exit(0);
