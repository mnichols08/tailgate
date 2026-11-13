# Tailgate

Farm to door. Farmers list what they have, neighbours fill one cart from several farms and pay once, and drivers carry each farm's order from the farm to the door. All three see each order move as it happens.

Tailgate is a showcase for [Zubra](https://github.com/journey-to-code-org/zubra), built for [Potomac Solutions](https://potomac.solutions). It is one small Node server with no framework, no bundler and no separate database.

## The screens

| Who | Screen | What's on it |
| --- | --- | --- |
| Anyone | **Start** (`/start`) | Pick who you are: a shopper, a farmer or a driver |
| Anyone | **Market** (`/`) | Each farm's stall, in its own colours, logo and theme, and everything for sale, filterable by farm |
| Anyone | **Storefront** (`/farms/:farm`) | One farm's stall and goods, the whole page in the farm's theme |
| Shopper | **Cart** (`/cart`) | What's in the cart, from any number of farms, with a delivery fee per farm and the total |
| Shopper | **Checkout** (`/checkout`) | One payment for the whole cart (test mode: no money moves) |
| Shopper | **My orders** (`/orders`) | Orders on the way, with live status and when the driver has it open; earlier orders |
| Farmer | **Overview** (`/farm`) | Sales this week, orders to fill, stock running low, daily sales, what sold, stock on hand |
| Farmer | **Stock** (`/farm/stock`) | What's for sale, editable offline |
| Farmer | **Orders** (`/farm/orders`) | A board of the farm's orders by where they are, updating as drivers move them |
| Farmer | **Storefront** (`/farm/storefront`) | Name, tagline, logo, colour and theme, with a live preview; shoppers see each change as it's made |
| Driver | **Deliveries** (`/drive`) | Open deliveries to claim, yours in progress with directions, what you've earned |
| Driver | **Earnings** (`/drive/earnings`) | Pay and deliveries this week, by day |

## What each part does

| Zubra piece | Job in Tailgate |
| --- | --- |
| `@zubra/server` | Renders every page. The market, orders and dashboards are complete HTML before any JavaScript runs |
| `@zubra/sync` | A farmer's stock and storefront live on their device first, so they can be edited with no signal and sync on reconnect. Every order's status is a live document, and so is every farm's stall, so pages follow changes without reloading |
| Presence (`@zubra/sync`) | The shopper sees when the driver has their order open |
| `@zubra/actions` | Adding to the cart, claiming a delivery, picking up and delivering are plain form posts to `'use server'` functions. They work with JavaScript off, and their code never reaches the browser |
| [Potomac kit](https://github.com/Potomac-Solutions/kit) (private) | The commerce rules: `catalog` (what's for sale and how many are left), `cart`, `checkout` (stock from every farm taken at once, one charge, one order per farm), `pay` (charged at most once; its test provider), and `stages` (placed → claimed → picked up → delivered). `cart-panel` and `checkout-form` are the kit's components, loaded from the package (`createZubra({ packages })`) |
| [Zubra UI](https://github.com/journey-to-code-org/zubra-ui) | The dashboards, charts, controls and themes: `dashboard-shell`, `stat-card`, `line-chart`, `donut-chart`, `bar-chart`, `kanban-column`, `step-indicator`, `status-badge`, `quantity-stepper`, `money-input`, `text-field`, `file-drop`, `color-swatches`, `choice-cards`, `segmented-control`, `user-avatar`, `action-button`, `alert-banner`, `empty-state`, `toast-region`, and five themes farmers choose from (Paper, Zinc, Candy, Midnight, Terminal) |

The rule behind the split: **Sync for what one person owns, Actions for what two people could both want.** A farmer's price and colours are theirs alone, so last-writer-wins is right. The last crate of squash, or a delivery two drivers tap at once, has to be decided by the server: a delivery is an action, and the squash is decided at checkout, where the whole cart's stock is taken in one step.

## How it works

One SQLite file holds the Sync log. `src/market.js` wraps that log, so every change a device pushes is also applied to the server's view of each document. The server therefore always knows current stock and order status, and needs no second table.

When the server has to decide something, it checks and writes in one synchronous step, so two requests can't interleave. It then pushes its write into the same log, which sends it to every open page. Only the server may write `orders`, `carts`, `checkouts` and `payments`. Each farmer may write only their own farm's stock.

## Zubra UI

The controls are Zubra UI components, installed as `.zb` source with the shadcn CLI into `src/components/`, beside Tailgate's own. Nothing comes from npm:

```sh
R=https://journey-to-code-org.github.io/zubra-ui/r
for c in quantity-stepper money-input step-indicator action-button alert-banner empty-state dashboard-shell \
  stat-card bar-chart donut-chart line-chart kanban-column file-drop color-swatches choice-cards \
  segmented-control text-field user-avatar toast-region status-badge; do npx shadcn add $R/src/$c.json --yes; done
npx shadcn add $R/theme.json $R/themes/paper.json $R/themes/zinc.json $R/themes/candy.json $R/themes/midnight.json $R/themes/terminal.json --yes
```

Add another the same way, then import it from the component that uses it (`import './modal-dialog.zb'`).

## Run it

Needs Node 22.13 or later (Node 24 recommended). `npm install` fetches the Potomac kit from its private GitHub repository, so it needs an account with read access to `Potomac-Solutions/kit`.

```sh
npm install
npm start            # http://localhost:3000
npm test             # the walk below, in Chromium (run `npx playwright install chromium` once)
```

Start at `/start` and pick who you are. Accounts come later; the demo seeds three farms, two shoppers, two drivers, three weeks of order history and a few orders on the way.

## Try it

`npm install`, then `npm start`, and open http://localhost:3000. Use two browser windows (one private), so you can be two people at once.

1. **Shop.** At `/start`, shop as Rosa. Add something from Hilltop Farm and something from Meadow Creek. The cart shows one delivery fee per farm.
2. **Pay once.** Check out with any card number (`4000 0000 0000 0002` is declined, to see that). My orders shows one order per farm, each waiting for a driver.
3. **Deliver.** In the other window, drive as Jules. Claim one of Rosa's orders, then press Picked up and Delivered. Rosa's page follows each step without a reload, and shows when Jules has the order open.
4. **Sell.** Switch to a farmer (Luis at Meadow Creek). Change stock on the Stock page, even offline: the market has it once you reconnect. Restyle the stall on Storefront, and the market changes as you do.
5. **Without JavaScript** (turn it off in the browser's settings), the market, the cart and checkout all still work.

## What the tests prove

1. Without JavaScript, the market is complete, in each farm's order, and an item goes into the cart, through checkout and onto My orders, and each page says what happened.
2. With JavaScript, the quantity stepper sets how many, the cart and the order follow, with toasts.
3. Two shoppers both have the last item in their carts and check out at once; one gets it, the other is told it sold out and their cart marks it.
4. A cart from two farms is paid once and becomes one order per farm, each with its own delivery fee; the same checkout sent twice is still one; stock comes off both farms; each farm and the drivers see their orders.
5. A declined card takes nothing: the stock goes back and the cart stays. A checkout key the server didn't make, and a post another site sends, are refused.
6. A driver claims an order. The shopper's page shows the driver, then that the driver has it open, then "On the way" and "Delivered", with no reload. A second driver's late claim gets a message.
7. A farmer edits stock offline. The market shows the old stock until they reconnect, then the new. A new row reaches the market too.
8. Only what a farm lists, named, priced and counted, is for sale: a listing off the farm's list, or with its count cleared, isn't.
9. A farmer renames their farm, picks a colour and a theme, and uploads a logo. A shopper's market shows each change without a reload, and the server renders it from then on.
10. Each person writes only what is theirs: a farmer can't touch another farm, nobody but the server writes an order, a cart, a checkout or a payment, and only a shopper fills a cart.
11. Every screen renders for the person it is for, and the wrong person gets a way in rather than a broken page.
12. The `'use server'` code is absent from the component modules the browser loads.

## Deploy on Railway

1. Create a service from this repository. `railway.json` sets the start command and a `/health` check.
2. Add a **volume** mounted at `/data`, and set `DATA_DIR=/data` so the SQLite file survives deploys.
3. Set `SESSION_SECRET` to a long random string, and `NODE_ENV=production`.
4. Keep one replica. Live updates go to pages connected to the same process.

## Not yet

- Accounts. A visitor picks who they are; a signed cookie holds the choice.
- Real payments. Checkout uses the kit's test provider: any card works except 4000 0000 0000 0002, which is declined.
- Maps. Drivers get directions links to the farm and the door. An in-app map, using Garrett County Adventures as a reference, is next.
- The market's farm filter and product cards show a farm's new name after a reload; its stall updates live.
- Read rules. Anyone signed in can follow any order's live status.
- Motion. List rows will use Zubra's `animate` once it ships in a release; until then they fade in with CSS.
