// The page around the components: Tailgate's own look, the header, toasts, and the connection to
// the Sync log. Tailgate's frame stays cool and quiet so each farm's own colours carry the market.
export const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** What a finished action says, as a toast (or, without JavaScript, a banner). */
export const DONE = {
  added: 'Added to your cart.',
  placed: 'Order placed. A driver will pick it up soon.',
  claimed: 'Delivery claimed. Pick it up at the farm.',
  picked: 'Marked as picked up. The customer can see you’re on the way.',
  delivered: 'Marked as delivered. Nice work.',
};

const ROLE = { farmer: 'Farmer', customer: 'Shopper', driver: 'Driver' };

const fonts = [
  ['Barlow Condensed', 600, '/fonts/barlow-condensed-latin-600-normal.woff2'],
  ['Barlow Condensed', 700, '/fonts/barlow-condensed-latin-700-normal.woff2'],
  ['Source Sans 3', 400, '/fonts/source-sans-3-latin-400-normal.woff2'],
  ['Source Sans 3', 600, '/fonts/source-sans-3-latin-600-normal.woff2'],
  ['Source Sans 3', 700, '/fonts/source-sans-3-latin-700-normal.woff2'],
];

const STYLE = `
  ${fonts.map(([family, weight, src]) => `@font-face { font-family: "${family}"; font-weight: ${weight}; font-display: swap; src: url(${src}) format("woff2"); }`).join('\n  ')}
  :root {
    --tg-ground: #eef2ef; --tg-ink: #1e2b27; --tg-line: #c5cec9; --tg-pine: #2e5e4e; --tg-amber: #e3a21a; --tg-muted: #56655f;
    --background: var(--tg-ground); --foreground: var(--tg-ink); --card: #ffffff; --card-foreground: var(--tg-ink);
    --primary: var(--tg-pine); --primary-foreground: #ffffff; --ring: var(--tg-pine); --border: var(--tg-line);
    --muted: #e2e8e4; --muted-foreground: var(--tg-muted); --secondary: #e2e8e4; --secondary-foreground: var(--tg-ink);
    --accent: #dfe7e2; --accent-foreground: var(--tg-ink); --radius: 0.5rem;
    --font-heading: "Barlow Condensed", "Arial Narrow", sans-serif; --font-body: "Source Sans 3", system-ui, sans-serif;
    color-scheme: light;
  }
  * { box-sizing: border-box; }
  html { background: var(--tg-ground); }
  body { margin: 0; font-family: var(--font-body); font-size: 1.0625rem; line-height: 1.5; color: var(--tg-ink); background: var(--tg-ground); }
  h1, main.page h2, .app-body h2 { font-family: var(--font-heading); font-weight: 700; line-height: 1.05; letter-spacing: -0.005em; margin: 0; }
  main.page h1 { font-size: clamp(2.25rem, 5vw, 3.5rem); }
  main.page h2 { font-size: 1.75rem; }
  a:not(.action-button) { color: inherit; }
  :focus-visible { outline: 3px solid var(--tg-amber); outline-offset: 2px; }

  .site-head { display: flex; align-items: center; gap: 1.5rem; padding: 0.85rem clamp(1rem, 4vw, 2.5rem); background: var(--tg-ink); color: #f1f5f2; }
  .wordmark { font-family: var(--font-heading); font-weight: 700; font-size: 1.75rem; letter-spacing: 0.01em; color: #fff; text-decoration: none; display: flex; align-items: center; gap: 0.55rem; }
  .wordmark svg { width: 1.9rem; height: 1.9rem; }
  .site-nav { display: flex; gap: 1.25rem; }
  .site-nav a { color: #c9d6cf; text-decoration: none; font-weight: 600; }
  .site-nav a[aria-current] { color: #fff; box-shadow: 0 2px 0 var(--tg-amber); }
  .me { margin-left: auto; display: flex; align-items: center; gap: 0.6rem; font-size: 0.95rem; }
  .me .who { display: grid; line-height: 1.15; }
  .me .who small { color: #a9bab1; }
  .me a.switch { color: #c9d6cf; font-size: 0.9rem; }
  .button-light { display: inline-block; padding: 0.45rem 0.9rem; border-radius: var(--radius); background: var(--tg-amber); color: var(--tg-ink); font-weight: 700; text-decoration: none; }

  main.page { width: min(72rem, 100% - 2 * clamp(1rem, 4vw, 2.5rem)); margin: 0 auto; padding: 2rem 0 4rem; display: grid; gap: 2.75rem; }
  .lede { max-width: 38rem; color: var(--tg-muted); font-size: 1.15rem; margin: 0.6rem 0 0; }
  .stalls { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1.25rem; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .section-head p { margin: 0; color: var(--tg-muted); }
  .stack { display: grid; gap: 1rem; }
  .site-foot { padding: 2rem clamp(1rem, 4vw, 2.5rem); color: var(--tg-muted); font-size: 0.9rem; border-top: 1px solid var(--tg-line); }

  /* Dashboards fill the window; the Zubra UI shell scrolls inside itself. */
  body.app { min-height: 100dvh; padding: clamp(0rem, 1.5vw, 1rem); }
  body.app dashboard-shell { --shell-height: calc(100dvh - 2 * clamp(0rem, 1.5vw, 1rem)); background: var(--card); }
  dashboard-shell h1 { font-family: var(--font-heading); font-size: clamp(1.6rem, 3vw, 2.25rem); letter-spacing: 0; }
  .app-body { display: grid; gap: 2rem; padding: 0.5rem 0 3rem; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: 1rem; }
  .panels { display: grid; grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr)); gap: 1.5rem; align-items: start; }
  .panel { display: grid; gap: 0.75rem; }
  .panel > h2 { font-size: 1.35rem; }
  .board { display: grid; grid-template-columns: repeat(4, minmax(14rem, 1fr)); gap: 1rem; overflow-x: auto; padding-bottom: 0.5rem; }
  .board order-card { display: block; }
  .board kanban-column h2 { font-family: var(--font-body); }
  .delivery { display: grid; gap: 0.6rem; }
  .delivery .route { margin: 0; font-size: 0.95rem; }
  .shell-actions-link { font-weight: 600; text-decoration: none; padding: 0.35rem 0.6rem; border-radius: var(--radius); box-shadow: 0 0 0 1px var(--border); }

  @media (max-width: 40rem) {
    .site-head { flex-wrap: wrap; gap: 0.75rem 1rem; }
    .site-nav { order: 3; width: 100%; }
    .me .who { display: none; }
  }
`;

const MARK = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="2" y="12" width="28" height="12" rx="2" fill="#e3a21a"/><path d="M6 12V7h14l6 5" fill="none" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/><circle cx="9" cy="25" r="3.5" fill="#1e2b27" stroke="#fff" stroke-width="2"/><circle cx="23" cy="25" r="3.5" fill="#1e2b27" stroke="#fff" stroke-width="2"/></svg>`;

const SCRIPT = (done) => `
  <script type="module">
    import { connect } from '@zubra/sync/connect';
    connect();
    const toast = (detail) => document.dispatchEvent(new CustomEvent('toast', { detail }));
    // What the last action did, said once.
    const done = ${JSON.stringify(done ?? '')};
    if (done) {
      customElements.whenDefined('toast-region').then(() => toast({ message: done, variant: 'success' }));
      const url = new URL(location.href);
      url.searchParams.delete('done');
      history.replaceState(null, '', url);
    }
    // Losing the signal is normal out here: say what happens to changes made meanwhile.
    addEventListener('offline', () => toast({ heading: 'You’re offline', message: 'Changes save on this device and go out when you’re back.', variant: 'warning', duration: 0 }));
    addEventListener('online', () => toast({ message: 'Back online. Your changes are going out now.', variant: 'success' }));
    // The dashboard's user menu.
    document.addEventListener('menuselect', (event) => {
      const go = { switch: '/start', market: '/', storefront: event.target.dataset.storefront };
      if (go[event.detail]) location.href = go[event.detail];
    });
  </script>`;

function head(title) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Tailgate</title>
  <meta name="description" content="Food from farms near you, brought to your door by a neighbour.">
  <link rel="preload" href="/fonts/barlow-condensed-latin-700-normal.woff2" as="font" type="font/woff2" crossorigin>
  <link rel="stylesheet" href="/styles/theme.css">
  ${['paper', 'zinc', 'candy', 'midnight', 'terminal'].map((theme) => `<link rel="stylesheet" href="/styles/${theme}.css">`).join('\n  ')}
  <style>${STYLE}</style>
</head>`;
}

/** A public page: the header, the page, a footer. */
export function layout({ title, path, person, banner = '', body, actionsScript, done, avatar = '', cartCount = 0 }) {
  const nav = [['/', 'Market'], ...(person?.role === 'customer' ? [['/cart', cartCount ? `Cart (${cartCount})` : 'Cart'], ['/orders', 'My orders']] : []), ...(person?.role === 'farmer' ? [['/farm', 'My farm']] : []), ...(person?.role === 'driver' ? [['/drive', 'My deliveries']] : [])];
  return `${head(title)}
<body>
  <header class="site-head">
    <a class="wordmark" href="/">${MARK}Tailgate</a>
    <nav class="site-nav" aria-label="Main">${nav.map(([href, label]) => `<a href="${href}"${path === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div class="me">${
      person
        ? `${avatar}<span class="who"><strong>${escape(person.name)}</strong><small>${ROLE[person.role]}</small></span><a class="switch" href="/start">Switch</a>`
        : `<a class="button-light" href="/start">Choose who you are</a>`
    }</div>
  </header>
  <main class="page">
    ${banner}
    ${body}
  </main>
  <footer class="site-foot">Tailgate is a demo by <a href="https://potomac.solutions">Potomac Solutions</a>, built with <a href="https://github.com/journey-to-code-org/zubra">Zubra</a> and Zubra UI. Checkout is in test mode; nothing here is really for sale.</footer>
  <toast-region></toast-region>
  ${actionsScript}
  ${SCRIPT(done)}
</body>
</html>`;
}

/** A dashboard: the Zubra UI shell, already rendered by the page, fills the window. */
export function appLayout({ title, shell, banner = '', actionsScript, done, palette = '' }) {
  return `${head(title)}
<body class="app" style="${palette}">
  ${banner}
  ${shell}
  <toast-region></toast-region>
  ${actionsScript}
  ${SCRIPT(done)}
</body>
</html>`;
}
