// The page around the components: header, who-am-I bar, and the connection to the Sync log.
export const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const NAV = [
  ['/', 'Market'],
  ['/farm', 'Farm'],
  ['/orders', 'Orders'],
  ['/drive', 'Drive'],
];

export function layout({ title, path, person, people, banner, body, actionsScript }) {
  const options = Object.values(people)
    .map((p) => `<option value="${p.id}"${person?.id === p.id ? ' selected' : ''}>${escape(p.name)} · ${p.role}</option>`)
    .join('');
  return `<!doctype html>
<html lang="en" data-theme="paper">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Tailgate</title>
  <meta name="description" content="Farm to door: local farmers, neighbours and drivers. A Zubra showcase.">
  <link rel="stylesheet" href="/styles/theme.css">
  <link rel="stylesheet" href="/styles/paper.css">
  <style>
    /* Zubra UI's Paper theme, with Tailgate's green as its primary colour. */
    [data-theme="paper"] { --primary: oklch(0.48 0.11 140); --ring: oklch(0.48 0.11 140); }
    :root { --ink: var(--foreground); --muted: var(--muted-foreground); --line: var(--border); --paper: var(--background); --accent: var(--primary); color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: var(--font-body, ui-sans-serif, system-ui, sans-serif); color: var(--ink); background: var(--paper); line-height: 1.45; }
    h1, h2, .brand { font-family: var(--font-heading, var(--font-serif, inherit)); }
    .bar { display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; align-items: center; padding: 0.8rem 1.25rem; background: var(--ink); color: var(--paper); }
    .brand { font-weight: 800; letter-spacing: 0.02em; color: var(--paper); text-decoration: none; font-size: 1.15rem; }
    .bar nav { display: flex; gap: 1rem; }
    .bar nav a { color: #e6dfcd; text-decoration: none; }
    .bar nav a[aria-current] { color: white; font-weight: 700; text-decoration: underline; text-underline-offset: 0.3em; }
    .who { margin-left: auto; display: flex; gap: 0.5rem; align-items: center; font-size: 0.9rem; }
    .who select, .who button { font: inherit; padding: 0.3rem 0.5rem; border-radius: 0.4rem; border: 1px solid #5b5447; }
    main { max-width: 64rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; display: grid; gap: 2rem; }
    h1 { margin: 0 0 0.75rem; font-size: 1.6rem; }
    h2 { margin: 0 0 0.75rem; font-size: 1.2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 1rem; }
    .stack { display: grid; gap: 1rem; }
    .delivery { display: grid; gap: 0.5rem; }
    .hint { color: var(--muted); margin: 0 0 0.75rem; }
    .problem { margin: 0; padding: 0.75rem 1rem; border-radius: 0.6rem; background: #fbe9e4; color: #a5361f; }
    footer { text-align: center; color: var(--muted); font-size: 0.85rem; padding-bottom: 2rem; }
    footer a { color: inherit; }
  </style>
</head>
<body>
  <header class="bar">
    <a class="brand" href="/">Tailgate</a>
    <nav>${NAV.map(([href, label]) => `<a href="${href}"${path === href ? ' aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <form class="who" method="post" action="/who">
      <label for="who">Viewing as</label>
      <select id="who" name="who" onchange="this.form.requestSubmit()"><option value="">Nobody yet</option>${options}</select>
      <input type="hidden" name="back" value="${escape(path)}">
      <noscript><button>Switch</button></noscript>
    </form>
  </header>
  <main>
    ${banner}
    ${body}
  </main>
  <footer>A <a href="https://github.com/journey-to-code-org/zubra">Zubra</a> showcase by <a href="https://potomac.solutions">Potomac Solutions</a>. Demo data; pay on delivery.</footer>
  ${actionsScript}
  <script type="module">
    import { connect } from '@zubra/sync/connect';
    connect();
  </script>
</body>
</html>`;
}
