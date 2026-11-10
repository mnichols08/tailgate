// The Tailgate walk: each browser context is one person's device.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createApp } from '../server.js';

const dir = mkdtempSync(join(tmpdir(), 'tailgate-'));
let server;
let base;
let browser;
const errors = [];

before(async () => {
  server = await createApp({ db: join(dir, 'tailgate.db'), cache: false, secret: 'test' });
  await new Promise((done) => server.listen(0, done));
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  server.closeAllConnections?.();
  await new Promise((done) => server.close(done));
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(errors, [], 'no page errors in any browser');
});

/** A device signed in as `who`, optionally without JavaScript. */
async function device(who, { javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ javaScriptEnabled });
  await context.request.post(`${base}/who`, { form: { who, back: '/' }, maxRedirects: 0 });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${who}: ${error.message}`));
  return { context, page };
}
const ready = async (page, tag) => {
  await page.waitForFunction((tag) => customElements.get(tag), tag);
  await page.waitForTimeout(300); // documents loaded, live stream open
};
/** HTTP as `who`, the way a second device's fetch would. */
async function as(who) {
  const context = await browser.newContext();
  await context.request.post(`${base}/who`, { form: { who, back: '/' }, maxRedirects: 0 });
  return {
    post: async (path, form) => {
      const response = await context.request.post(`${base}${path}`, { form, headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' }, maxRedirects: 0 });
      const text = await response.text();
      return { status: response.status(), body: text ? JSON.parse(text) : null };
    },
    close: () => context.close(),
  };
}

test('without JavaScript: the market is complete and an order goes through', async () => {
  const { context, page } = await device('rosa', { javaScriptEnabled: false });
  await page.goto(base);
  const names = await page.$$eval('produce-card h3', (headings) => headings.map((h) => h.textContent));
  assert.deepEqual(names, ['Heirloom tomatoes', 'Pasture eggs', 'Wildflower honey', 'Butternut squash']);
  // Zubra UI's quantity-stepper submits its value with the form, JavaScript or not.
  await page.click('produce-card[item=eggs] button[type=submit]');
  await page.waitForURL(`${base}/orders`);
  assert.match(await page.textContent('order-card'), /1 dozen · Pasture eggs/);
  assert.match(await page.textContent('order-card [aria-current=step]'), /Placed/);
  await page.goto(base);
  assert.equal(await page.getAttribute('produce-card[item=eggs]', 'qty'), '11');
  await context.close();
});

test('with JavaScript: the stepper sets how many, and the order lands', async () => {
  const { context, page } = await device('sam');
  await page.goto(base);
  await ready(page, 'quantity-stepper');
  const card = page.locator('produce-card[item=tomatoes]');
  await card.locator('quantity-stepper button.more').click();
  await card.locator('quantity-stepper button.more').click();
  await card.locator('action-button button').click();
  await page.waitForURL(`${base}/orders`);
  assert.match(await page.textContent('order-card'), /3 lb · Heirloom tomatoes/);
  await context.close();
});

test('the last one goes to one customer', async () => {
  const rosa = await as('rosa');
  const sam = await as('sam');
  const [a, b] = await Promise.all([
    rosa.post('/_zb/action/produce-card/order', { farm: 'meadow', item: 'squash', qty: '1' }),
    sam.post('/_zb/action/produce-card/order', { farm: 'meadow', item: 'squash', qty: '1' }),
  ]);
  const won = [a, b].filter((r) => r.status === 204 || r.body?.ok);
  const lost = [a, b].filter((r) => r.body?.error);
  assert.equal(won.length, 1, JSON.stringify([a, b]));
  assert.deepEqual(lost.map((r) => r.body.error), ['Sold out.']);
  await rosa.close();
  await sam.close();
});

test('a driver claims; the customer sees it live, and sees the driver looking', async () => {
  const customer = await device('rosa');
  await customer.page.goto(`${base}/orders`);
  await ready(customer.page, 'order-card');
  const card = customer.page.locator('order-card').filter({ hasText: 'Pasture eggs' });
  const doc = await card.getAttribute('doc');

  const driver = await device('jules');
  await driver.page.goto(`${base}/drive`);
  await ready(driver.page, 'delivery-actions');
  await driver.page.locator('.delivery').filter({ has: driver.page.locator(`order-card[doc="${doc}"]`) }).locator('button', { hasText: 'Claim' }).click();
  await driver.page.waitForURL(`${base}/drive`);

  // No reload on the customer's page.
  await card.locator('[aria-current=step]', { hasText: 'Driver assigned' }).waitFor({ timeout: 5000 });
  await card.getByText('Driver: Jules').waitFor({ timeout: 5000 });
  // The driver's page shows the order; the customer's card says so.
  await card.getByText('Jules is looking at this order now').waitFor({ timeout: 5000 });

  // A second driver loses the race with a message, not an error page.
  const kai = await as('kai');
  const late = await kai.post('/_zb/action/delivery-actions/claim', { order: doc });
  assert.deepEqual(late.body, { error: 'Jules took this one.' });
  await kai.close();

  // Picked up, then delivered: the customer follows each step.
  await driver.page.locator(`.delivery:has(order-card[doc="${doc}"]) delivery-actions button`, { hasText: 'Picked up' }).click();
  await card.locator('[aria-current=step]', { hasText: 'On the way' }).waitFor({ timeout: 5000 });
  await driver.page.locator(`.delivery:has(order-card[doc="${doc}"]) delivery-actions button`, { hasText: 'Delivered' }).click();
  await card.locator('li.done', { hasText: 'Delivered' }).waitFor({ timeout: 5000 });
  await customer.context.close();
  await driver.context.close();
});

test('a farmer edits stock offline; the market has it once they reconnect', async () => {
  const farmer = await device('meadow');
  await farmer.page.goto(`${base}/farm`);
  await ready(farmer.page, 'stock-item');
  // Child props are properties, not attributes: find the row by its accessible name.
  const honey = farmer.page.locator('stock-item', { has: farmer.page.getByRole('button', { name: 'Remove Wildflower honey' }) });
  await honey.locator('input[aria-label=Quantity]').waitFor();
  await farmer.page.waitForFunction(() => [...document.querySelectorAll('stock-item')].find((el) => el.item === 'honey')?.querySelector('input[aria-label=Quantity]').value === '8');

  await farmer.context.setOffline(true);
  await honey.locator('input[aria-label=Quantity]').fill('30');
  await honey.locator('money-input input').fill('12');
  await farmer.page.waitForTimeout(500);
  let market = await (await fetch(base)).text();
  assert.match(market, /item="honey"[^>]*price="\$11\.00" qty="8"/, 'still the old stock while offline');

  await farmer.context.setOffline(false);
  await farmer.page.evaluate(() => window.dispatchEvent(new Event('online')));
  for (let i = 0; i < 50 && !/item="honey"[^>]*price="\$12\.00" qty="30"/.test(market); i++) {
    await new Promise((done) => setTimeout(done, 200));
    market = await (await fetch(base)).text();
  }
  assert.match(market, /item="honey"[^>]*price="\$12\.00" qty="30"/);

  // A new row, named and priced, reaches the market too.
  await farmer.page.click('action-button.add button');
  const row = farmer.page.locator('stock-item').last();
  await row.locator('input[aria-label=Item]').fill('Sweet corn');
  await row.locator('input[aria-label=Unit]').fill('dozen');
  await row.locator('money-input input').fill('7');
  await row.locator('input[aria-label=Quantity]').fill('15');
  for (let i = 0; i < 50 && !market.includes('Sweet corn'); i++) {
    await new Promise((done) => setTimeout(done, 200));
    market = await (await fetch(base)).text();
  }
  assert.match(market, /name="Sweet corn" unit="dozen" price="\$7\.00" qty="15"/);
  await farmer.context.close();
});

test('a farmer can only write their own farm', async () => {
  const luis = await as('meadow');
  const response = await luis.post('/_zb/sync/push', {});
  assert.equal(response.status, 400);
  await luis.close();
  const context = await browser.newContext();
  await context.request.post(`${base}/who`, { form: { who: 'meadow', back: '/' }, maxRedirects: 0 });
  const push = (collection, key) =>
    context.request.post(`${base}/_zb/sync/push`, {
      headers: { 'sec-fetch-site': 'same-origin' },
      data: { changes: [{ collection, key, field: 'qty', value: 0, clock: '000000000000001-00000-x' }] },
    });
  assert.equal((await push('listings', 'meadow/honey')).status(), 200);
  assert.equal((await push('listings', 'hilltop/eggs')).status(), 403);
  assert.equal((await push('orders', 'anything')).status(), 403);
  await context.close();
});

test('server code never reaches the browser', async () => {
  const html = await (await fetch(base)).text();
  const modules = [...html.matchAll(/(\/_zubra\/[^"']+\.js)/g)].map((m) => m[1]);
  const mine = modules.filter((path) => /produce-card|delivery-actions/.test(path));
  assert.ok(mine.length, `component modules in the page: ${modules.join(', ')}`);
  for (const path of mine) {
    const source = await (await fetch(`${base}${path}`)).text();
    assert.doesNotMatch(source, /use server|placeOrder|context\.market/, path);
  }
  const drive = await (await fetch(`${base}/_zubra/components/delivery-actions.js`)).text();
  if (drive.length > 0 && !drive.startsWith('Not found')) assert.doesNotMatch(drive, /use server|context\.market|advance\(/);
});
