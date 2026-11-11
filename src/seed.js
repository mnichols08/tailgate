// The demo's people, farms and history. Accounts come later; for now a visitor picks who they are.
export const people = {
  hilltop: { id: 'hilltop', role: 'farmer', farm: 'hilltop', name: 'Dana Whitlock' },
  meadow: { id: 'meadow', role: 'farmer', farm: 'meadow', name: 'Luis Ortega' },
  bearrun: { id: 'bearrun', role: 'farmer', farm: 'bearrun', name: 'June Harsh' },
  rosa: { id: 'rosa', role: 'customer', name: 'Rosa Bittinger', address: '12 Main St, Oakland, MD' },
  sam: { id: 'sam', role: 'customer', name: 'Sam Teets', address: '48 Ridge Rd, Davis, WV' },
  jules: { id: 'jules', role: 'driver', name: 'Jules Friend' },
  kai: { id: 'kai', role: 'driver', name: 'Kai Sines' },
};

/** What a driver earns for each delivery; the customer pays it as the delivery fee. */
export const DELIVERY_CENTS = 600;

/** Each farm's storefront as it starts. Farmers change all of it from their dashboard. */
export const farms = [
  { id: 'hilltop', name: 'Hilltop Farm', tagline: 'Tomatoes, eggs and greens from the top of Bittinger Road.', color: '#9b2d20', theme: 'paper', town: 'Bittinger, MD' },
  { id: 'meadow', name: 'Meadow Creek', tagline: 'Wildflower honey and squash from the creek bottom.', color: '#1f5f8b', theme: 'zinc', town: 'Davis, WV' },
  { id: 'bearrun', name: 'Bear Run Orchard', tagline: 'Apples, cider and preserves since 1952.', color: '#4f7a28', theme: 'candy', town: 'Accident, MD' },
];

export const listings = [
  { farm: 'hilltop', item: 'tomatoes', name: 'Heirloom tomatoes', unit: 'lb', price: 4.5, qty: 40 },
  { farm: 'hilltop', item: 'eggs', name: 'Pasture eggs', unit: 'dozen', price: 6, qty: 18 },
  { farm: 'hilltop', item: 'greens', name: 'Salad greens', unit: 'bag', price: 5, qty: 3 },
  { farm: 'meadow', item: 'honey', name: 'Wildflower honey', unit: 'jar', price: 11, qty: 14 },
  { farm: 'meadow', item: 'squash', name: 'Butternut squash', unit: 'each', price: 3, qty: 1 },
  { farm: 'meadow', item: 'beeswax', name: 'Beeswax candles', unit: 'pair', price: 9, qty: 10 },
  { farm: 'bearrun', item: 'apples', name: 'Honeycrisp apples', unit: 'half peck', price: 8, qty: 25 },
  { farm: 'bearrun', item: 'cider', name: 'Fresh cider', unit: 'half gallon', price: 7, qty: 12 },
  { farm: 'bearrun', item: 'butter', name: 'Apple butter', unit: 'jar', price: 6.5, qty: 2 },
];

/** Orders in progress when a fresh demo starts, so every role has something live to look at. */
export function underway(now = Date.now()) {
  const order = (key, farm, item, qty, customer, status, driver, minutesAgo) => {
    const listing = listings.find((l) => l.farm === farm && l.item === item);
    return {
      key, farm, item, itemName: listing.name, unit: listing.unit, qty,
      cents: Math.round(listing.price * 100) * qty, fee: DELIVERY_CENTS,
      customer, address: people[customer].address, status,
      driver: driver ?? '', driverName: driver ? people[driver].name : '', placed: now - minutesAgo * 60_000,
    };
  };
  return [
    order('u1', 'hilltop', 'eggs', 2, 'rosa', 'picked', 'jules', 55),
    order('u2', 'bearrun', 'cider', 1, 'sam', 'claimed', 'kai', 35),
    order('u3', 'meadow', 'honey', 1, 'rosa', 'placed', null, 12),
    order('u4', 'hilltop', 'tomatoes', 3, 'sam', 'placed', null, 6),
  ];
}

/**
 * Three weeks of delivered orders, so the dashboards have something to show. Deterministic:
 * the same history every time a fresh log is seeded.
 */
export function history(now = Date.now(), days = 21) {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const customers = ['rosa', 'sam'];
  const drivers = ['jules', 'kai'];
  const orders = [];
  for (let day = days; day >= 1; day--) {
    const count = 1 + Math.floor(random() * 4);
    for (let n = 0; n < count; n++) {
      const listing = listings[Math.floor(random() * listings.length)];
      const qty = 1 + Math.floor(random() * 3);
      const customer = customers[Math.floor(random() * customers.length)];
      const driver = drivers[Math.floor(random() * drivers.length)];
      const placed = now - day * 86_400_000 + Math.floor(random() * 10) * 3_600_000;
      orders.push({
        key: `h${String(orders.length + 1).padStart(3, '0')}`,
        farm: listing.farm,
        item: listing.item,
        itemName: listing.name,
        unit: listing.unit,
        qty,
        cents: Math.round(listing.price * 100) * qty,
        fee: DELIVERY_CENTS,
        customer,
        address: people[customer].address,
        status: 'delivered',
        driver,
        driverName: people[driver].name,
        placed,
        delivered: placed + 3 * 3_600_000,
      });
    }
  }
  return orders;
}
