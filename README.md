# Tailgate

Farm to door. Farmers list what they have, neighbours order it, and drivers carry it from the farm to the door. All three see each order move as it happens.

Tailgate is a showcase for [Zubra](https://github.com/journey-to-code-org/zubra), built for [Potomac Solutions](https://potomac.solutions). It is one small Node server with no framework, no bundler and no separate database.

## What each part does

| Zubra piece | Job in Tailgate |
| --- | --- |
| `@zubra/server` | Renders every page. The market, orders and deliveries are complete HTML before any JavaScript runs |
| `@zubra/sync` | A farmer's stock lives on their device first, so it can be edited in a field with no signal and syncs on reconnect. Every order's status is a live document, so the customer sees "Driver assigned", "On the way" and "Delivered" without reloading |
| Presence (`@zubra/sync`) | The customer sees when the driver is looking at their order |
| `@zubra/actions` | Ordering, claiming a delivery, picking up and delivering are plain form posts to `'use server'` functions. They work with JavaScript off, and their code never reaches the browser |
| [Zubra UI](https://github.com/journey-to-code-org/zubra-ui) | Every control: quantity stepper, money input, step indicator, buttons, alerts and empty states, themed with Zubra UI's Paper theme in Tailgate's green |

The rule behind the split: **Sync for what one person owns, Actions for what two people could both want.** A farmer's price is theirs alone, so last-writer-wins is right. The last crate of squash, or a delivery two drivers tap at once, has to be decided by the server, so it is an action.

## How it works

One SQLite file holds the Sync log. `src/market.js` wraps that log, so every change a device pushes is also applied to the server's view of each document. The server therefore always knows current stock and order status, and needs no second table.

When the server has to decide something, it checks and writes in one synchronous step, so two requests can't interleave. It then pushes its write into the same log, which sends it to every open page. Only the server may write `orders`. Each farmer may write only their own farm's stock.

## Zubra UI

The controls are Zubra UI components, installed as `.zb` source with the shadcn CLI into `src/components/`, beside Tailgate's own. Nothing comes from npm:

```sh
R=https://journey-to-code-org.github.io/zubra-ui/r
npx shadcn add $R/src/quantity-stepper.json $R/src/money-input.json $R/src/step-indicator.json \
  $R/src/action-button.json $R/src/alert-banner.json $R/src/empty-state.json $R/theme.json $R/themes/paper.json
```

Add another the same way, then import it from the component that uses it (`import './modal-dialog.zb'`).

## Run it

Needs Node 22.13 or later (Node 24 recommended).

```sh
npm install
npm start            # http://localhost:3000
npm test             # the walk below, in Chromium (run `npx playwright install chromium` once)
```

Pick who you are in the bar at the top. Accounts come later; the demo seeds two farmers, two customers and two drivers.

## What the tests prove

1. Without JavaScript, the market is complete and an order goes through (post, redirect, orders page).
2. Two customers order the last item at once; one gets it, the other is told it sold out.
3. A driver claims an order. The customer's page shows the driver's name and the driver looking at it, then "On the way" and "Delivered", with no reload. A second driver's late claim gets a message.
4. A farmer edits stock offline. The market shows the old stock until they reconnect, then the new. A new row reaches the market too.
5. A farmer can write only their own farm. Nobody but the server can write an order.
6. The `'use server'` code is absent from the component modules the browser loads.

## Deploy on Railway

1. Create a service from this repository. `railway.json` sets the start command and a `/health` check.
2. Add a **volume** mounted at `/data`, and set `DATA_DIR=/data` so the SQLite file survives deploys.
3. Set `SESSION_SECRET` to a long random string, and `NODE_ENV=production`.
4. Keep one replica. Live updates go to pages connected to the same process.

## Not yet

- Accounts. A visitor picks who they are; a signed cookie holds the choice.
- Payments. Every order is pay on delivery.
- Maps. Drivers get a directions link. An in-app map, using Garrett County Adventures as a reference, is next.
- Read rules. Anyone signed in can follow any order's live status.
- Motion. List rows will use Zubra's `animate` once it ships in a release; until then they fade in with CSS.
