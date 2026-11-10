// The demo's people and farms. Accounts come later; for now a visitor picks who they are.
export const people = {
  hilltop: { id: 'hilltop', role: 'farmer', farm: 'hilltop', name: 'Dana (Hilltop Farm)' },
  meadow: { id: 'meadow', role: 'farmer', farm: 'meadow', name: 'Luis (Meadow Creek)' },
  rosa: { id: 'rosa', role: 'customer', name: 'Rosa', address: '12 Main St, Oakland, MD' },
  sam: { id: 'sam', role: 'customer', name: 'Sam', address: '48 Ridge Rd, Davis, WV' },
  jules: { id: 'jules', role: 'driver', name: 'Jules' },
  kai: { id: 'kai', role: 'driver', name: 'Kai' },
};

export const farms = [
  { id: 'hilltop', name: 'Hilltop Farm' },
  { id: 'meadow', name: 'Meadow Creek' },
];

export const listings = [
  { farm: 'hilltop', item: 'tomatoes', name: 'Heirloom tomatoes', unit: 'lb', price: 4.5, qty: 20 },
  { farm: 'hilltop', item: 'eggs', name: 'Pasture eggs', unit: 'dozen', price: 6, qty: 12 },
  { farm: 'meadow', item: 'honey', name: 'Wildflower honey', unit: 'jar', price: 11, qty: 8 },
  { farm: 'meadow', item: 'squash', name: 'Butternut squash', unit: 'each', price: 3, qty: 1 },
];
