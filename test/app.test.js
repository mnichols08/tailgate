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
  await context.request.post(`${base}/who`, { form: { who }, maxRedirects: 0 });
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
  await context.request.post(`${base}/who`, { form: { who }, maxRedirects: 0 });
  return {
    post: async (path, form) => {
      const response = await context.request.post(`${base}${path}`, { form, headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' }, maxRedirects: 0 });
      const text = await response.text();
      return { status: response.status(), body: text ? JSON.parse(text) : null };
    },
    get: async (path) => (await context.request.get(`${base}${path}`)).text(),
    close: () => context.close(),
  };
}
const until = async (check, what) => {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 200));
  }
  assert.fail(`timed out waiting for ${what}`);
};

test('without JavaScript: the market is complete and an order goes through', async () => {
  const { context, page } = await device('rosa', { javaScriptEnabled: false });
  await page.goto(base);
  assert.deepEqual(await page.$$eval('farm-stall h3', (h) => h.map((x) => x.textContent)), ['Hilltop Farm', 'Meadow Creek', 'Bear Run Orchard']);
  assert.equal(await page.locator('produce-card h3').count(), 9);
  // Zubra renders the stepper's no-JavaScript stand-in itself (nested form controls), and the
  // avatars' initials on the server (Zubra UI): nothing here is waiting for JavaScript.
  assert.equal(await page.locator('produce-card[item=beeswax] quantity-stepper input[type=hidden][name=qty][data-zb-fallback]').getAttribute('value'), '1');
  assert.equal((await page.locator('farm-stall[farm=hilltop] [role=img]').textContent()).trim(), 'HF');
  await page.click('produce-card[item=beeswax] button[type=submit]');
  await page.waitForURL(/\/orders/);
  assert.match(await page.textContent('order-card:has-text("Beeswax candles")'), /1 pair · Beeswax candles/);
  assert.match(await page.textContent('main'), /Order placed/, 'the result is said without JavaScript too');
  await page.goto(base);
  assert.equal(await page.getAttribute('produce-card[item=beeswax]', 'qty'), '9');
  await context.close();
});

test('with JavaScript: the stepper sets how many, and the order lands', async () => {
  const { context, page } = await device('sam');
  await page.goto(base);
  await ready(page, 'quantity-stepper');
  const card = page.locator('produce-card[item=apples]');
  await card.locator('quantity-stepper button.more').click();
  await card.locator('quantity-stepper button.more').click();
  await card.locator('action-button button').click();
  await page.waitForURL(/\/orders/);
  await page.locator('order-card', { hasText: '3 half peck · Honeycrisp apples' }).waitFor();
  await page.locator('toast-region', { hasText: 'Order placed' }).waitFor({ timeout: 5000 });
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
  // The one just placed (Rosa's history has delivered beeswax orders too, as compact cards).
  const card = customer.page.locator('order-card:not([compact])', { hasText: 'Beeswax candles' });
  const doc = await card.getAttribute('doc');

  const driver = await device('jules');
  await driver.page.goto(`${base}/drive`);
  await ready(driver.page, 'delivery-actions');
  const row = () => driver.page.locator(`.delivery:has(order-card[doc="${doc}"]) delivery-actions button`);
  await row().filter({ hasText: 'Claim' }).click();
  await driver.page.waitForURL(/\/drive/);

  // No reload on the customer's page.
  await card.locator('[aria-current=step]', { hasText: 'Driver assigned' }).waitFor({ timeout: 5000 });
  assert.equal(await card.getByRole('button').count(), 0, 'the status is read-only: nothing to press (Zubra UI step-indicator readonly)');
  await card.getByText('Driver: Jules Friend').waitFor({ timeout: 5000 });
  await card.getByText('Jules Friend has this order open now').waitFor({ timeout: 5000 });

  // A second driver loses the race with a message, not an error page.
  const kai = await as('kai');
  const late = await kai.post('/_zb/action/delivery-actions/claim', { order: doc });
  assert.deepEqual(late.body, { error: 'Jules Friend took this one.' });
  await kai.close();

  // Picked up, then delivered: the customer follows each step.
  await row().filter({ hasText: 'Picked up' }).click();
  await card.locator('[aria-current=step]', { hasText: 'On the way' }).waitFor({ timeout: 5000 });
  await row().filter({ hasText: 'Delivered' }).click();
  await card.locator('li.done', { hasText: 'Delivered' }).waitFor({ timeout: 5000 });
  await customer.context.close();
  await driver.context.close();
});

test('a farmer edits stock offline; the market has it once they reconnect', async () => {
  const farmer = await device('meadow');
  await farmer.page.goto(`${base}/farm/stock`);
  await ready(farmer.page, 'stock-item');
  // Child props are properties, not attributes: find the row by its accessible name.
  const honey = farmer.page.locator('stock-item', { has: farmer.page.getByRole('button', { name: 'Remove Wildflower honey' }) });
  await honey.locator('input[aria-label=Quantity]').waitFor();
  await farmer.page.waitForFunction(() => [...document.querySelectorAll('stock-item')].find((el) => el.item === 'honey')?.querySelector('input[aria-label=Quantity]').value === '14');

  await farmer.context.setOffline(true);
  await honey.locator('input[aria-label=Quantity]').fill('30');
  await honey.locator('input[aria-label=Quantity]').press('Tab'); // Zubra UI's editable stepper commits on leaving
  await honey.locator('money-input input').fill('12');
  await farmer.page.waitForTimeout(500);
  let market = await (await fetch(base)).text();
  assert.match(market, /item="honey"[^>]*price="\$11\.00" qty="14"/, 'still the old stock while offline');

  await farmer.context.setOffline(false);
  await farmer.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => /item="honey"[^>]*price="\$12\.00" qty="30"/.test((market = await (await fetch(base)).text())), 'the new stock on the market');

  // A new row, named and priced, reaches the market too.
  await farmer.page.click('action-button.add button');
  const row = farmer.page.locator('stock-item').last();
  await row.locator('input[aria-label=Item]').fill('Sweet corn');
  await row.locator('input[aria-label=Unit]').fill('dozen');
  await row.locator('money-input input').fill('7');
  await row.locator('input[aria-label=Quantity]').fill('15');
  await row.locator('input[aria-label=Quantity]').press('Tab');
  await until(async () => /name="Sweet corn" unit="dozen" price="\$7\.00" qty="15"/.test(await (await fetch(base)).text()), 'the new row on the market');
  await farmer.context.close();
});

test('a farmer restyles their stall; shoppers see it change as it happens', async () => {
  const shopper = await device('sam');
  await shopper.page.goto(base);
  await ready(shopper.page, 'farm-stall');
  const stall = shopper.page.locator('farm-stall[farm=bearrun]');

  const farmer = await device('bearrun');
  await farmer.page.goto(`${base}/farm/storefront`);
  await ready(farmer.page, 'storefront-editor');
  const editor = farmer.page.locator('storefront-editor');
  await editor.locator('text-field input').first().fill('Bear Run Cidery');
  await editor.locator('color-swatches button[data-color="#6b3a6e"]').click();
  await editor.locator('choice-cards').getByText('Midnight').click();
  // A real picture, as if picked from the farmer's photos: a corner of the page itself.
  const png = await farmer.page.screenshot({ clip: { x: 0, y: 0, width: 64, height: 64 } });
  await editor.locator('file-drop input[type=file]').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: png });

  // The preview follows at once; the shopper's market follows without a reload.
  await editor.locator('stall-card h3', { hasText: 'Bear Run Cidery' }).waitFor({ timeout: 5000 });
  await stall.locator('h3', { hasText: 'Bear Run Cidery' }).waitFor({ timeout: 5000 });
  await shopper.page.waitForFunction(() => {
    const card = document.querySelector('farm-stall[farm=bearrun] .stall');
    return card?.dataset.theme === 'midnight' && card.style.getPropertyValue('--stall') === '#6b3a6e' && card.querySelector('img.logo')?.src.includes('/logos/bearrun.webp?v=') && card.querySelector('img.logo').complete && card.querySelector('img.logo').naturalWidth > 0;
  }, null, { timeout: 5000 });

  // And it's what the server renders from then on: the market, the storefront, the dashboard.
  const html = await (await fetch(`${base}/farms/bearrun`)).text();
  assert.match(html, /data-theme="midnight" style="--primary:#6b3a6e/);
  assert.match(html, /<h3>Bear Run Cidery<\/h3>/);
  assert.match(html, /<img class="logo" src="\/logos\/bearrun\.webp\?v=\d+"/);
  const logo = await fetch(`${base}/logos/bearrun.webp`);
  assert.equal(logo.status, 200);
  assert.match(logo.headers.get('content-type'), /^image\//);
  await shopper.context.close();
  await farmer.context.close();
});

test('each person writes only what is theirs', async () => {
  const context = await browser.newContext();
  await context.request.post(`${base}/who`, { form: { who: 'meadow' }, maxRedirects: 0 });
  const push = (collection, key, field = 'qty') =>
    context.request.post(`${base}/_zb/sync/push`, {
      headers: { 'sec-fetch-site': 'same-origin' },
      data: { changes: [{ collection, key, field, value: field === 'qty' ? 0 : '#000000', clock: '000000000000001-00000-x' }] },
    });
  assert.equal((await push('listings', 'meadow/honey')).status(), 200);
  assert.equal((await push('brands', 'meadow', 'color')).status(), 200);
  assert.equal((await push('listings', 'hilltop/eggs')).status(), 403);
  assert.equal((await push('brands', 'hilltop', 'color')).status(), 403);
  assert.equal((await push('orders', 'anything', 'status')).status(), 403);
  await context.close();
});

test('every screen renders for the person it is for', async () => {
  const screens = [
    ['hilltop', '/farm', ['stat-card', 'line-chart', 'donut-chart', 'bar-chart']],
    ['hilltop', '/farm/orders', ['kanban-column']],
    ['hilltop', '/farm/stock', ['farm-stock']],
    ['hilltop', '/farm/storefront', ['storefront-editor', 'file-drop', 'color-swatches', 'choice-cards']],
    ['jules', '/drive', ['stat-card', 'delivery-actions']],
    ['jules', '/drive/earnings', ['bar-chart']],
    ['rosa', '/orders', ['order-card']],
    ['rosa', '/farms/hilltop', ['farm-stall', 'produce-card']],
  ];
  for (const [who, path, tags] of screens) {
    const person = await as(who);
    const html = await person.get(path);
    for (const tag of tags) assert.match(html, new RegExp(`<${tag}[\\s>]`), `${path} as ${who} has ${tag}`);
    await person.close();
  }
  // The wrong person gets a way in, not a broken page.
  const shopper = await as('rosa');
  assert.match(await shopper.get('/farm'), /This page is for farmers/);
  await shopper.close();
});

test('server code never reaches the browser', async () => {
  // The two components with 'use server' functions, as the browser loads them.
  for (const path of ['/_zubra/components/produce-card.js', '/_zubra/components/delivery-actions.js']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const source = await response.text();
    assert.match(source, /customElements\.define|define\(/, `${path} is the element module`);
    assert.doesNotMatch(source, /use server|placeOrder|context\.market|advance\(/, path);
  }
});
