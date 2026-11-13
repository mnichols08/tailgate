// The Tailgate walk: each browser context is one person's device.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
  // Playwright's own Chromium when it is installed; otherwise the machine's Chrome.
  const system = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((path) => existsSync(path));
  browser = await chromium.launch().catch(() => chromium.launch({ executablePath: process.env.CHROME ?? system }));
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
    /** A plain form post (the cart's and checkout's routes): where it sends the browser. */
    form: async (path, form) => {
      const response = await context.request.post(`${base}${path}`, { form, maxRedirects: 0 });
      return { status: response.status(), location: decodeURIComponent(response.headers().location ?? '') };
    },
    close: () => context.close(),
  };
}
/** The checkout page's form fields, as a second device would post them. */
async function checkoutForm(person, card = '4242 4242 4242 4242') {
  const html = await person.get('/checkout');
  const key = /name="checkout" value="([a-z0-9]+)"/.exec(html)?.[1];
  assert.ok(key, 'the checkout page has a key');
  return { checkout: key, name: 'Test', email: 'test@example.com', address: '1 Test Rd', card };
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
  assert.deepEqual(await page.$$eval('produce-card', (cards) => cards.map((card) => card.getAttribute('item'))), ['tomatoes', 'eggs', 'greens', 'honey', 'squash', 'beeswax', 'apples', 'cider', 'butter'], 'farm by farm, in the order each farm lists them');
  // Zubra UI's quantity-stepper can't submit itself without JavaScript; the form carries 1.
  await page.click('produce-card[item=beeswax] button[type=submit]');
  await page.waitForURL(/\/cart/);
  assert.match(await page.textContent('cart-panel'), /Beeswax candles/);
  assert.match(await page.textContent('main'), /Added to your cart/);
  await page.click('cart-panel a:has-text("Check out")');
  await page.waitForURL(/\/checkout/);
  await page.fill('checkout-form input[name=card]', '4242 4242 4242 4242');
  await page.click('checkout-form button[type=submit]');
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
  await page.waitForURL(/\/cart/);
  await page.locator('toast-region', { hasText: 'Added to your cart' }).waitFor({ timeout: 5000 });
  await page.locator('cart-panel output', { hasText: '3' }).waitFor();
  await page.click('cart-panel a:has-text("Check out")');
  await page.waitForURL(/\/checkout/);
  await page.fill('checkout-form input[name=card]', '4242 4242 4242 4242');
  await page.click('checkout-form button[type=submit]');
  await page.waitForURL(/\/orders/);
  await page.locator('order-card', { hasText: '3 half peck · Honeycrisp apples' }).waitFor();
  await page.locator('toast-region', { hasText: 'Order placed' }).waitFor({ timeout: 5000 });
  await context.close();
});

test('the last one goes to one customer', async () => {
  const rosa = await as('rosa');
  const sam = await as('sam');
  // Both can put the last squash in a cart: nothing is taken until checkout.
  for (const person of [rosa, sam]) assert.equal((await person.post('/_zb/action/produce-card/add', { farm: 'meadow', item: 'squash', qty: '1' })).status, 204);
  const forms = [await checkoutForm(rosa), await checkoutForm(sam)];
  const [a, b] = await Promise.all([rosa.form('/checkout', forms[0]), sam.form('/checkout', forms[1])]);
  const won = [a, b].filter((r) => r.location === '/orders?done=placed');
  const lost = [a, b].filter((r) => r.location.startsWith('/checkout?problem='));
  assert.equal(won.length, 1, JSON.stringify([a, b]));
  assert.deepEqual(lost.map((r) => r.location), ['/checkout?problem=Something in your cart sold out. Check your cart and try again.']);
  // The loser's cart still has it, marked; the winner's is empty.
  const carts = await Promise.all([rosa.get('/cart'), sam.get('/cart')]);
  assert.equal(carts.filter((html) => /Only 0 left|No longer for sale/.test(html)).length, 1);
  // Empty the loser's cart again, so the later tests start clean.
  for (const person of [rosa, sam]) await person.form('/cart/change', { item: 'meadow/squash', qty: '0' });
  await rosa.close();
  await sam.close();
});

test('a cart from two farms is paid once, and goes out as one order per farm', async () => {
  const sam = await as('sam');
  const before = await sam.get('/');
  const left = (html, item) => Number(new RegExp(`item="${item}"[^>]*qty="(\\d+)"`).exec(html)[1]);
  assert.equal((await sam.post('/_zb/action/produce-card/add', { farm: 'hilltop', item: 'eggs', qty: '2' })).status, 204);
  assert.equal((await sam.post('/_zb/action/produce-card/add', { farm: 'hilltop', item: 'tomatoes', qty: '1' })).status, 204);
  assert.equal((await sam.post('/_zb/action/produce-card/add', { farm: 'meadow', item: 'beeswax', qty: '1' })).status, 204);
  const cart = await sam.get('/cart');
  assert.match(cart, /<dt>Delivery from Hilltop Farm<\/dt><dd>\$6\.00<\/dd>/);
  assert.match(cart, /<dt>Delivery from Meadow Creek<\/dt><dd>\$6\.00<\/dd>/);
  assert.match(cart, /Cart \(4\)/, 'the header counts what is in the cart');

  // The same form sent twice (a double press, a retry) is one checkout.
  const form = await checkoutForm(sam);
  const sent = await Promise.all([sam.form('/checkout', form), sam.form('/checkout', form)]);
  assert.ok(sent.some((r) => r.location === '/orders?done=placed'), JSON.stringify(sent));
  assert.equal((await sam.form('/checkout', form)).location, '/orders?done=placed', 'sent again later: the same paid checkout');

  const orders = await sam.get('/orders');
  const docs = [...orders.matchAll(new RegExp(`<order-card doc="(${form.checkout}/[a-z]+)"`, 'g'))].map((m) => m[1]).sort();
  assert.deepEqual(docs, [`${form.checkout}/hilltop`, `${form.checkout}/meadow`], 'one order per farm, once');
  assert.match(orders, /item-name="Pasture eggs, Heirloom tomatoes" qty="3" unit="items" total="\$22\.50"/, 'both of Hilltop\'s lines on its one order, with its delivery');
  assert.match(orders, /item-name="Beeswax candles" qty="1" unit="pair" total="\$15\.00"/, 'candles and their delivery');

  const after = await sam.get('/');
  assert.equal(left(after, 'eggs'), left(before, 'eggs') - 2);
  assert.equal(left(after, 'tomatoes'), left(before, 'tomatoes') - 1);
  assert.equal(left(after, 'beeswax'), left(before, 'beeswax') - 1);
  assert.doesNotMatch(await sam.get('/cart'), /<li data-item/, 'the cart is empty');

  // Each farm sees its own order, ready for a driver.
  const hilltop = await as('hilltop');
  assert.match(await hilltop.get('/farm/orders'), new RegExp(`doc="${form.checkout}/hilltop"`));
  assert.doesNotMatch(await hilltop.get('/farm/orders'), new RegExp(`doc="${form.checkout}/meadow"`));
  await hilltop.close();
  const jules = await as('jules');
  const open = await jules.get('/drive');
  assert.match(open, new RegExp(`doc="${form.checkout}/hilltop"`));
  assert.match(open, new RegExp(`doc="${form.checkout}/meadow"`));
  await jules.close();
  await sam.close();
});

test('a declined card takes nothing: the stock and the cart stay as they were', async () => {
  const rosa = await as('rosa');
  const before = await rosa.get('/');
  assert.equal((await rosa.post('/_zb/action/produce-card/add', { farm: 'bearrun', item: 'cider', qty: '2' })).status, 204);
  const declined = await rosa.form('/checkout', await checkoutForm(rosa, '4000 0000 0000 0002'));
  assert.equal(declined.location, '/checkout?problem=That card was declined. Try another.');
  assert.match(await rosa.get('/checkout?problem=That card was declined. Try another.'), /That card was declined/);
  const qty = (html) => /item="cider"[^>]*qty="(\d+)"/.exec(html)[1];
  assert.equal(qty(await rosa.get('/')), qty(before), 'the stock went back');
  assert.match(await rosa.get('/cart'), /<li data-item="bearrun\/cider"/, 'still in the cart, to try another card');
  // A key this server didn't make, and a post another site sends, change nothing.
  assert.equal((await rosa.form('/checkout', { ...(await checkoutForm(rosa)), checkout: 'x/../y' })).location, '/checkout?problem=That checkout has expired. Try again.');
  const context = await browser.newContext();
  await context.request.post(`${base}/who`, { form: { who: 'rosa' }, maxRedirects: 0 });
  const forged = await context.request.post(`${base}/checkout`, { form: await checkoutForm(rosa), headers: { 'sec-fetch-site': 'cross-site' }, maxRedirects: 0 });
  assert.equal(forged.status(), 403);
  await context.close();
  await rosa.form('/cart/change', { item: 'bearrun/cider', qty: '0' });
  assert.doesNotMatch(await rosa.get('/cart'), /<li data-item/);
  await rosa.close();
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
  await until(async () => /name="Sweet corn" unit="dozen" price="\$7\.00" qty="15"/.test(await (await fetch(base)).text()), 'the new row on the market');
  await farmer.context.close();
});

test('the market sells only what a farm lists, named, priced and counted', async () => {
  const context = await browser.newContext();
  await context.request.post(`${base}/who`, { form: { who: 'bearrun' }, maxRedirects: 0 });
  const clock = () => `${String(Date.now()).padStart(15, '0')}-00000-test`;
  const write = (key, fields) =>
    context.request.post(`${base}/_zb/sync/push`, {
      headers: { 'sec-fetch-site': 'same-origin' },
      data: { changes: Object.entries(fields).map(([field, value]) => ({ collection: 'listings', key, field, value, clock: clock() })) },
    });
  // Written, but not on the farm's list: not for sale.
  assert.equal((await write('bearrun/pears', { name: 'Seckel pears', unit: 'quart', price: 6, qty: 10 })).status(), 200);
  // On the list (the butter row), but with no count: none left, not "no limit".
  assert.equal((await write('bearrun/butter', { qty: null })).status(), 200);
  await new Promise((done) => setTimeout(done, 200));
  const market = await (await fetch(base)).text();
  assert.doesNotMatch(market, /item="pears"/, 'unlisted');
  assert.doesNotMatch(market, /item="butter"/, 'no count is none left');
  const rosa = await as('rosa');
  assert.deepEqual((await rosa.post('/_zb/action/produce-card/add', { farm: 'bearrun', item: 'pears', qty: '1' })).body, { error: 'That listing is gone.' });
  await rosa.close();
  await context.close();
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
  for (const collection of ['carts', 'checkouts', 'payments']) assert.equal((await push(collection, 'meadow', 'status')).status(), 403, collection);
  await context.close();
  // Only a shopper fills a cart.
  const farmer = await as('meadow');
  assert.deepEqual((await farmer.post('/_zb/action/produce-card/add', { farm: 'hilltop', item: 'eggs', qty: '1' })).body, { error: 'Choose a shopper to buy.' });
  assert.equal((await farmer.form('/cart/change', { item: 'hilltop/eggs', qty: '1' })).location, '/cart?problem=Choose a shopper to buy.');
  await farmer.close();
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
    ['rosa', '/cart', ['cart-panel']],
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

test("the cart's components are the kit's, and Tailgate's parts stand in for the kit's copies", async () => {
  const kit = await fetch(`${base}/_zubra/components/@potomac-solutions/kit/components/cart-panel.js`);
  assert.equal(kit.status, 200);
  assert.match(await kit.text(), /import "\.\/action-button\.js"/, "the kit's cart-panel imports its own copy");
  // That copy is Tailgate's module, so the browser defines <action-button> once.
  const copy = await (await fetch(`${base}/_zubra/components/@potomac-solutions/kit/components/action-button.js`)).text();
  assert.match(copy, /^export \* from "\/_zubra\/components\/action-button\.js";/);
});

test('server code never reaches the browser', async () => {
  // The two components with 'use server' functions, as the browser loads them.
  for (const path of ['/_zubra/components/produce-card.js', '/_zubra/components/delivery-actions.js']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const source = await response.text();
    assert.match(source, /customElements\.define|define\(/, `${path} is the element module`);
    assert.doesNotMatch(source, /use server|addToCart|context\.market|advance\(/, path);
  }
});
