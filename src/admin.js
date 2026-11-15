// The market's admin: for the people who run Tailgate itself, across every farm, driver and
// shopper. Staff see the overview, orders, farms, drivers and shoppers; owners also see the
// reports and the outbox, and can turn a shopper's account off. Plain HTML and forms.
import { series, totals, breakdown, csv } from '@potomac-solutions/kit/reports';
import { barChart, rankBars } from '@potomac-solutions/kit/charts';
import { escape } from './layout.js';
import { money } from './account.js';

const DAY = 86_400_000;
const PAGE = 25;
const ZONE = 'America/New_York';
const STATUS = { placed: 'Waiting for a driver', claimed: 'Claimed', picked: 'Picked up', delivered: 'Delivered' };

export const RANGES = {
  '30d': { label: 'Last 30 days', days: 30, by: 'day' },
  '13w': { label: 'Last 13 weeks', days: 91, by: 'week' },
  '12m': { label: 'Last 12 months', days: 365, by: 'month' },
};

export function createAdmin({ market, customers, sent, now = Date.now }) {
  const dateTime = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: ZONE }) : '');
  const short = (start, by) => {
    const date = new Date(`${start}T12:00:00Z`);
    return by === 'month' ? date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  };
  const badge = (status) => `<span class="badge ${status}">${escape(STATUS[status] ?? status)}</span>`;
  const value = (order) => order.goods + order.fee;
  const hours = (order) => (order.delivered && order.placed ? (order.delivered - order.placed) / 3_600_000 : null);
  const option = (v, words, current) => `<option value="${escape(v)}"${current === v ? ' selected' : ''}>${escape(words)}</option>`;
  const pageOf = (url) => Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const pager = (url, base, count, page) => {
    const pages = Math.max(1, Math.ceil(count / PAGE));
    const at = (n) => {
      const next = new URLSearchParams(url.searchParams);
      next.set('page', String(n));
      return `${base}?${next}`;
    };
    return pages > 1 ? `<p class="pager">${page > 1 ? `<a href="${escape(at(page - 1))}">Newer</a>` : ''}<span>Page ${page} of ${pages}</span>${page < pages ? `<a href="${escape(at(page + 1))}">Older</a>` : ''}</p>` : '';
  };
  const drivers = () => Object.values(market.people).filter((one) => one.role === 'driver');

  function nav(here, owner) {
    const link = (href, words) => `<a href="${href}"${here === href ? ' aria-current="page"' : ''}>${words}</a>`;
    return `<nav class="admin-nav" aria-label="Admin"><small>Market</small>${link('/admin', 'Overview')}${link('/admin/orders', 'Orders')}${link('/admin/farms', 'Farms')}${link('/admin/drivers', 'Drivers')}${link('/admin/shoppers', 'Shoppers')}${link('/', 'The market')}${
      owner ? `<small>Owner</small>${link('/admin/reports', 'Reports')}${link('/staff/people', 'Staff')}${link('/admin/outbox', 'Outbox')}` : ''
    }</nav>`;
  }
  const frame = (here, owner, bar, body) => `<div class="admin">${nav(here, owner)}<div class="admin-body">${bar}${body}</div></div>`;
  const orderRows = (list) =>
    list.length
      ? `<div class="table-wrap"><table><thead><tr><th scope="col">Placed</th><th scope="col">What</th><th scope="col">Farm</th><th scope="col">Shopper</th><th scope="col">Driver</th><th scope="col">Status</th><th scope="col" class="num">Total</th></tr></thead><tbody>${list
          .map((order) => `<tr><td>${dateTime(order.placed)}<br><small class="muted">${escape(order.doc)}</small></td><td>${order.qty} ${escape(order.unit)} · ${escape(order.itemName)}</td><td>${escape(order.farmName)}</td><td>${escape(order.customerName)}${order.customer && customers.get(order.customer) ? ` <a class="muted" href="/admin/shoppers/${escape(order.customer)}">(account)</a>` : ''}</td><td>${escape(order.driverName || '—')}</td><td>${badge(order.status)}</td><td class="num">${escape(order.total)}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '<p>None.</p>';

  function filterOrders(url) {
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
    const status = url.searchParams.get('status') ?? '';
    const farm = url.searchParams.get('farm') ?? '';
    return market.allOrders().filter((order) => (!status || order.status === status) && (!farm || order.farm === farm) && (!q || [order.doc, order.customerName, order.itemName, order.address, order.driverName].some((field) => String(field ?? '').toLowerCase().includes(q))));
  }

  return {
    dashboard({ who, owner, bar }) {
      const at = now();
      const all = market.allOrders();
      const last30 = all.filter((order) => order.placed > at - 30 * DAY);
      const before30 = all.filter((order) => order.placed <= at - 30 * DAY && order.placed > at - 60 * DAY);
      const gmv = totals(last30, { amount: value }).amount;
      const earlier = totals(before30, { amount: value }).amount;
      const open = all.filter((order) => order.status === 'placed');
      const moving = all.filter((order) => order.status === 'claimed' || order.status === 'picked');
      const lowStock = market.farms.flatMap((farm) => market.catalog(farm.id).filter((listing) => Number(listing.qty) <= 3).map((listing) => ({ ...listing, farmName: market.brand(farm.id).name })));
      const days = series(all, { at: (order) => order.placed, amount: value, by: 'day', zone: ZONE, from: at - 29 * DAY, to: at });
      const times = last30.map(hours).filter((h) => h !== null);
      const activity = market.activity(8);
      return frame(
        '/admin',
        owner,
        bar,
        `<section><h1>Overview</h1><p class="lede">Tailgate, across ${market.farms.length} farms and ${drivers().length} drivers. Good to see you, ${escape(who.name.split(' ')[0])}.</p></section>
<div class="tiles">
  <div class="tile"><span>Sales through the market, 30 days</span><strong>${money(gmv)}</strong><small>${earlier ? `${gmv >= earlier ? '▲' : '▼'} ${Math.abs(Math.round(((gmv - earlier) / earlier) * 100))}% on the 30 days before` : `${last30.length} orders`}</small></div>
  <div class="tile"><span>Orders, 30 days</span><strong>${last30.length}</strong><small>${money(last30.length ? Math.round(gmv / last30.length) : 0)} on average, with delivery</small></div>
  <div class="tile"><span>Waiting for a driver</span><strong>${open.length}</strong><small>${moving.length} on the road</small></div>
  <div class="tile"><span>Placed to delivered</span><strong>${times.length ? `${(times.reduce((n, h) => n + h, 0) / times.length).toFixed(1)} h` : '—'}</strong><small>on average, 30 days</small></div>
  <div class="tile"><span>Running low</span><strong>${lowStock.length}</strong><small>listings with 3 or fewer</small></div>
  <div class="tile"><span>Shopper accounts</span><strong>${customers.list().length}</strong><small>${customers.list().filter((one) => one.at > at - 30 * DAY).length} new in 30 days</small></div>
</div>
<section class="panel"><h2>Sales by day, last 30 days</h2>${barChart(days.map((b) => ({ label: short(b.start, 'day'), value: b.amount, tip: `${short(b.start, 'day')}: ${money(b.amount)} from ${b.count} order${b.count === 1 ? '' : 's'}` })), { name: 'Sales', format: money })}${owner ? '<p><a href="/admin/reports">All reports</a></p>' : ''}</section>
<section class="panel"><h2>Waiting for a driver</h2>${orderRows(open.slice(0, 8))}</section>
${lowStock.length ? `<section class="panel"><h2>Running low</h2><ul>${lowStock.map((listing) => `<li>${escape(listing.farmName)}: ${escape(listing.name)}, ${escape(String(listing.qty))} left</li>`).join('')}</ul></section>` : ''}
<section class="panel"><h2>Staff activity</h2>${activity.length ? `<ul>${activity.map((one) => `<li><strong>${escape(one.by)}</strong> ${escape(one.what)} <small class="muted">${dateTime(one.at)}</small></li>`).join('')}</ul>` : '<p>Nothing yet.</p>'}</section>`,
      );
    },

    orders({ url, owner, bar }) {
      const list = filterOrders(url);
      const page = pageOf(url);
      const query = new URLSearchParams(url.searchParams);
      query.delete('page');
      return frame(
        '/admin/orders',
        owner,
        bar,
        `<section><h1>Orders</h1><p class="lede">${list.length} order${list.length === 1 ? '' : 's'}, ${money(totals(list, { amount: value }).amount)} with delivery.</p></section>
<form class="panel filters" method="get" action="/admin/orders">
  <label>Search<input name="q" value="${escape(url.searchParams.get('q') ?? '')}" placeholder="Shopper, item, address or driver"></label>
  <label>Status<select name="status">${option('', 'Any', url.searchParams.get('status') ?? '')}${Object.entries(STATUS).map(([v, words]) => option(v, words, url.searchParams.get('status'))).join('')}</select></label>
  <label>Farm<select name="farm">${option('', 'Any', url.searchParams.get('farm') ?? '')}${market.farms.map((farm) => option(farm.id, market.brand(farm.id).name, url.searchParams.get('farm'))).join('')}</select></label>
  <button type="submit">Show</button>
  <a class="button light" href="/admin/orders.csv?${escape(String(query))}">Download CSV</a>
</form>
<section class="panel">${orderRows(list.slice((page - 1) * PAGE, page * PAGE))}${pager(url, '/admin/orders', list.length, page)}</section>`,
      );
    },

    ordersCsv(url) {
      return csv(filterOrders(url), [
        { key: 'doc', label: 'Order' },
        { key: 'placed', label: 'Placed', value: (order) => new Date(order.placed).toISOString() },
        { key: 'farmName', label: 'Farm' },
        { key: 'itemName', label: 'Items' },
        { key: 'customerName', label: 'Shopper' },
        { key: 'address', label: 'Address' },
        { key: 'driverName', label: 'Driver' },
        { key: 'status', label: 'Status' },
        { key: 'goods', label: 'Goods (USD)', value: (order) => order.goods / 100 },
        { key: 'fee', label: 'Delivery (USD)', value: (order) => order.fee / 100 },
      ]);
    },

    farms({ owner, bar }) {
      const at = now();
      const all = market.allOrders().filter((order) => order.placed > at - 30 * DAY);
      return frame(
        '/admin/farms',
        owner,
        bar,
        `<section><h1>Farms</h1><p class="lede">Each farm runs its own stall and stock. Last 30 days.</p></section>
<section class="panel"><div class="table-wrap"><table><thead><tr><th scope="col">Farm</th><th scope="col">Town</th><th scope="col" class="num">Listings</th><th scope="col" class="num">Running low</th><th scope="col" class="num">Orders</th><th scope="col" class="num">Sales</th></tr></thead><tbody>${market.farms
          .map((farm) => {
            const brand = market.brand(farm.id);
            const listings = market.catalog(farm.id);
            const mine = all.filter((order) => order.farm === farm.id);
            return `<tr><td><a href="/farms/${farm.id}">${escape(brand.name)}</a><br><small class="muted">${escape(brand.tagline)}</small></td><td>${escape(brand.town)}</td><td class="num">${listings.length}</td><td class="num">${listings.filter((listing) => Number(listing.qty) <= 3).length}</td><td class="num">${mine.length}</td><td class="num">${money(totals(mine, { amount: (order) => order.goods }).amount)}</td></tr>`;
          })
          .join('')}</tbody></table></div></section>`,
      );
    },

    drivers({ owner, bar }) {
      const at = now();
      const all = market.allOrders().filter((order) => order.status === 'delivered' && order.delivered > at - 30 * DAY);
      return frame(
        '/admin/drivers',
        owner,
        bar,
        `<section><h1>Drivers</h1><p class="lede">Deliveries in the last 30 days. Each pays the driver ${money(market.DELIVERY_CENTS)}.</p></section>
<section class="panel"><div class="table-wrap"><table><thead><tr><th scope="col">Driver</th><th scope="col" class="num">Delivered</th><th scope="col" class="num">Earned</th><th scope="col" class="num">Average time</th><th scope="col" class="num">On the road now</th></tr></thead><tbody>${drivers()
          .map((driver) => {
            const mine = all.filter((order) => order.driver === driver.id);
            const times = mine.map(hours).filter((h) => h !== null);
            const now2 = market.allOrders().filter((order) => order.driver === driver.id && order.status !== 'delivered').length;
            return `<tr><td>${escape(driver.name)}</td><td class="num">${mine.length}</td><td class="num">${money(mine.length * market.DELIVERY_CENTS)}</td><td class="num">${times.length ? `${(times.reduce((n, h) => n + h, 0) / times.length).toFixed(1)} h` : '—'}</td><td class="num">${now2}</td></tr>`;
          })
          .join('')}</tbody></table></div></section>`,
      );
    },

    shoppers({ url, owner, bar }) {
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 80);
      const all = market.allOrders();
      const list = customers.list().filter((one) => !q || one.name.toLowerCase().includes(q) || one.email.includes(q));
      const page = pageOf(url);
      return frame(
        '/admin/shoppers',
        owner,
        bar,
        `<section><h1>Shoppers</h1><p class="lede">${customers.list().length} with accounts. The demo’s shoppers (picked on the start page) aren’t listed.</p></section>
<form class="panel filters" method="get" action="/admin/shoppers"><label>Search<input name="q" value="${escape(url.searchParams.get('q') ?? '')}" placeholder="Name or email"></label><button type="submit">Show</button><a class="button light" href="/admin/shoppers.csv">Download CSV</a></form>
<section class="panel"><div class="table-wrap"><table><thead><tr><th scope="col">Shopper</th><th scope="col">Joined</th><th scope="col" class="num">Orders</th><th scope="col" class="num">Spent</th></tr></thead><tbody>${list
          .slice((page - 1) * PAGE, page * PAGE)
          .map((one) => {
            const theirs = all.filter((order) => order.customer === one.customer);
            return `<tr><td><a href="/admin/shoppers/${escape(one.customer)}">${escape(one.name)}</a>${one.disabled ? ' <span class="badge off">Off</span>' : ''}<br><small class="muted">${escape(one.email)}</small></td><td>${dateTime(one.at)}</td><td class="num">${theirs.length}</td><td class="num">${money(totals(theirs, { amount: value }).amount)}</td></tr>`;
          })
          .join('')}</tbody></table></div>${pager(url, '/admin/shoppers', list.length, page)}</section>`,
      );
    },

    shoppersCsv() {
      const all = market.allOrders();
      return csv(customers.list(), [
        { key: 'name', label: 'Name' },
        { key: 'email', label: 'Email' },
        { key: 'at', label: 'Joined', value: (one) => new Date(one.at).toISOString() },
        { key: 'disabled', label: 'Turned off', value: (one) => (one.disabled ? 'yes' : 'no') },
        { key: 'orders', label: 'Orders', value: (one) => all.filter((order) => order.customer === one.customer).length },
        { key: 'spent', label: 'Spent (USD)', value: (one) => all.filter((order) => order.customer === one.customer).reduce((sum, order) => sum + value(order), 0) / 100 },
      ]);
    },

    shopper({ one, owner, bar, said }) {
      const orders = market.allOrders().filter((order) => order.customer === one.customer);
      return frame(
        '/admin/shoppers',
        owner,
        bar,
        `<section><a href="/admin/shoppers">All shoppers</a><h1>${escape(one.name)}</h1><p class="lede">${escape(one.email)} · joined ${dateTime(one.at)}${one.disabled ? ' · <span class="badge off">Turned off</span>' : ''}</p></section>
${said}
<div class="tiles"><div class="tile"><span>Orders</span><strong>${orders.length}</strong></div><div class="tile"><span>Spent</span><strong>${money(totals(orders, { amount: value }).amount)}</strong></div><div class="tile"><span>Favourite farm</span><strong>${escape(breakdown(orders, { key: (order) => order.farmName })[0]?.key ?? '—')}</strong></div></div>
<section class="panel"><h2>Orders</h2>${orderRows(orders)}</section>
${
  owner
    ? `<section class="panel"><h2>Account</h2><p>Turning an account off signs it out everywhere; its orders stay.</p><div class="filters"><form method="post" action="/admin/shoppers/${escape(one.customer)}/disabled"><input type="hidden" name="disabled" value="${one.disabled ? 'no' : 'yes'}"><button type="submit" class="${one.disabled ? '' : 'button light'}">${one.disabled ? 'Turn back on' : 'Turn off'}</button></form>${one.disabled ? '' : `<form method="post" action="/admin/shoppers/${escape(one.customer)}/reset"><button class="button light" type="submit">Email a reset link</button></form>`}</div></section>`
    : ''
}`,
      );
    },

    report(url) {
      const key = RANGES[url.searchParams.get('range')] ? url.searchParams.get('range') : '30d';
      const { days, by, label } = RANGES[key];
      const to = now();
      const from = to - (days - 1) * DAY;
      const orders = market.allOrders().filter((order) => order.placed >= from && order.placed <= to);
      return { key, by, label, from, to, orders, buckets: series(orders, { at: (order) => order.placed, amount: value, by, zone: ZONE, from, to }) };
    },

    reports({ url, owner, bar }) {
      const r = this.report(url);
      const sum = totals(r.orders, { amount: value });
      const goods = totals(r.orders, { amount: (order) => order.goods }).amount;
      const byFarm = breakdown(r.orders, { key: (order) => order.farmName, amount: (order) => order.goods }).sort((a, b) => b.amount - a.amount);
      const items = new Map();
      for (const order of r.orders) for (const line of order.lines) items.set(line.name, (items.get(line.name) ?? 0) + (line.total ?? 0));
      const byHour = Array.from({ length: 24 }, (_, hour) => ({ label: `${((hour + 11) % 12) + 1} ${hour < 12 ? 'am' : 'pm'}`, value: r.orders.filter((order) => Number(new Date(order.placed).toLocaleString('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: ZONE })) === hour).length })).filter((row) => row.value);
      return frame(
        '/admin/reports',
        owner,
        bar,
        `<section><h1>Reports</h1><p class="lede">${r.label}, by ${r.by}, in Eastern time. Counted on the day each order was placed.</p></section>
<div class="panel filters" role="group" aria-label="Range">${Object.entries(RANGES).map(([k, one]) => `<a class="button${k === r.key ? '' : ' light'}" href="?range=${k}"${k === r.key ? ' aria-current="true"' : ''}>${one.label}</a>`).join('')}</div>
<div class="tiles">
  <div class="tile"><span>Sales, with delivery</span><strong>${money(sum.amount)}</strong></div>
  <div class="tile"><span>To the farms</span><strong>${money(goods)}</strong></div>
  <div class="tile"><span>To the drivers</span><strong>${money(sum.amount - goods)}</strong></div>
  <div class="tile"><span>Orders</span><strong>${sum.count}</strong></div>
  <div class="tile"><span>Average order</span><strong>${money(sum.count ? Math.round(sum.amount / sum.count) : 0)}</strong></div>
</div>
<section class="panel"><h2>Sales by ${r.by}</h2>${barChart(r.buckets.map((b) => ({ label: short(b.start, r.by), value: b.amount, tip: `${short(b.start, r.by)}: ${money(b.amount)} from ${b.count} orders` })), { name: 'Sales', format: money })}<p><a class="button light" href="/admin/reports.csv?range=${r.key}">Download CSV</a></p></section>
<section class="two">
  <div class="panel"><h2>By farm</h2>${byFarm.length ? rankBars(byFarm.map((row) => ({ label: row.key, value: row.amount })), { format: money }) : '<p>None.</p>'}</div>
  <div class="panel"><h2>What sold</h2>${items.size ? rankBars([...items].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, v]) => ({ label, value: v })), { format: money }) : '<p>None.</p>'}</div>
</section>
<section class="panel"><h2>When people order</h2>${byHour.length ? rankBars(byHour) : '<p>None.</p>'}</section>`,
      );
    },

    reportCsv(url) {
      const r = this.report(url);
      return csv(r.buckets, [
        { key: 'start', label: r.by === 'day' ? 'Day' : r.by === 'week' ? 'Week starting' : 'Month' },
        { key: 'count', label: 'Orders' },
        { key: 'amount', label: 'Sales with delivery (USD)', value: (b) => b.amount / 100 },
      ]);
    },

    outbox({ owner, bar }) {
      const list = [...sent].reverse();
      return frame(
        '/admin/outbox',
        owner,
        bar,
        `<section><h1>Outbox</h1><p class="lede">This demo sends no real email. What it would have sent since the server started is here, newest first.</p></section>
<section class="panel">${list.length ? list.map((message) => `<article class="stack" style="border-top:1px solid var(--tg-line);padding-top:0.75rem"><p><strong>${escape(message.subject)}</strong><br><small class="muted">To ${escape(message.to)}</small></p><pre style="white-space:pre-wrap;margin:0">${escape(message.body)}</pre></article>`).join('') : '<p>Nothing sent yet.</p>'}</section>`,
      );
    },
  };
}
