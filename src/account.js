// A customer's account pages: sign in, sign up, a forgotten password, and their own page.
import { escape } from './layout.js';

export const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(cents / 100);
const badge = (status, words) => `<span class="badge ${status}">${escape(words)}</span>`;

export function signIn({ problem = '', email = '' } = {}) {
  return `<section><h1>Sign in</h1><p class="lede">Shop as yourself, on any device. No account? <a href="/account/sign-up">Make one</a>.</p></section>
${problem}
<form class="panel account-form" method="post" action="/account/sign-in">
  <label>Email<input name="email" type="email" autocomplete="email" required value="${escape(email)}"></label>
  <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
  <button type="submit">Sign in</button>
  <p><a href="/account/forgot">Forgot your password?</a></p>
</form>`;
}

export function signUp({ problem = '', form = null } = {}) {
  return `<section><h1>Make an account</h1><p class="lede">Shop as yourself: your orders follow you to any device, and checkout fills in your name and email.</p></section>
${problem}
<form class="panel account-form" method="post" action="/account/sign-up">
  <label>Your name<input name="name" autocomplete="name" required maxlength="80" value="${escape(form?.get('name') ?? '')}"></label>
  <label>Email<input name="email" type="email" autocomplete="email" required value="${escape(form?.get('email') ?? '')}"></label>
  <label>Password (at least 10 characters)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
  <button type="submit">Make my account</button>
  <p>Already have one? <a href="/account/sign-in">Sign in</a>.</p>
</form>`;
}

export function forgot({ sent = false } = {}) {
  return `<section><h1>Reset your password</h1><p class="lede">We’ll email a link that works once, for an hour.</p></section>
${sent ? '<p class="ok" role="status">If there’s an account with that email, a link is on its way.</p>' : ''}
<form class="panel account-form" method="post" action="/account/forgot">
  <label>Email<input name="email" type="email" autocomplete="email" required></label>
  <button type="submit">Send the link</button>
</form>`;
}

export function reset({ token, problem = '', works = true }) {
  if (!works) return `<section><h1>That link has expired</h1><p class="lede">It may have been used already. <a href="/account/forgot">Ask for a new one</a>.</p></section>`;
  return `<section><h1>Choose a new password</h1></section>
${problem}
<form class="panel account-form" method="post" action="/account/reset">
  <input type="hidden" name="token" value="${escape(token)}">
  <label>New password (at least 10 characters)<input name="password" type="password" autocomplete="new-password" minlength="10" required></label>
  <button type="submit">Save and sign in</button>
</form>`;
}

/** The shopper's own page: what they've ordered from each farm; their details. */
export function account({ market, person, said }) {
  const orders = market.ordersFor(person);
  const active = orders.filter((order) => order.status !== 'delivered');
  const spent = market.allOrders().filter((order) => order.customer === person.id).reduce((sum, order) => sum + order.goods + order.fee, 0);
  const farms = [...new Set(orders.map((order) => order.farmName))];
  return `<section><h1>Hello, ${escape(person.name.split(' ')[0])}</h1><p class="lede">${orders.length ? `${orders.length} deliveries from ${farms.length} farm${farms.length === 1 ? '' : 's'}, ${money(spent)} in all.` : 'Nothing ordered yet.'} <a href="/orders">Your orders</a> · <a href="/">The market</a></p></section>
${said}
<section class="panel account"><h2>On the way</h2>${active.length ? `<table><tbody>${active.map((order) => `<tr><td>${escape(order.itemName)}</td><td>${escape(order.farmName)}</td><td>${badge(order.status, order.status)}</td><td class="num">${escape(order.total)}</td></tr>`).join('')}</tbody></table>` : '<p>Nothing on the way.</p>'}</section>
<section class="two">
  <form class="panel account-form" method="post" action="/account/profile"><h2>Your details</h2><label>Name<input name="name" autocomplete="name" required maxlength="80" value="${escape(person.name)}"></label><p class="muted">Email: ${escape(person.email)}</p><button type="submit">Save</button></form>
  <div class="panel account-form"><h2>Signing in</h2><p><a href="/account/forgot">Change your password</a> by email.</p><form method="post" action="/account/sign-out"><button class="button light" type="submit">Sign out</button></form></div>
</section>`;
}
