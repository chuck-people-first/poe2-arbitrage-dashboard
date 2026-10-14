# Toolkit page (`/tools.html`)

A second page next to the market scanner, modelled on the everyday helpers in
desktop overlays like PoE2 MultiTool, built from the public feature list only.

| Tool | What it does | Data |
|---|---|---|
| Price check | Paste a Ctrl+C item (or type a name) → value each and × stack, 7-day trend | poe.ninja exchange |
| Stash value | `12 Divine Orb` / `Exalted Orb x340` lines → total in Div / Ex / Chaos (saved in browser) | poe.ninja exchange |
| Economy | All 532 exchange items, filter/sort, sparkline, any-to-any converter | poe.ninja exchange |
| EV calculator | Cost per attempt vs. outcomes × odds → EV, ROI (crafting, Desecration reveals, gambles) | book prices or typed values |
| Regex builder | Waystone tier range, "Stat: +N%" / "N% increased stat" thresholds, include/exclude; 250-char counter; saved searches | none |
| Trade links | Pasted item → official trade2 search URL (uniques by name+base, rares by base); saved links | none |
| Favourites | Built-in resource links plus your own | none |

## Pieces

- `api/prices.js`: Vercel function. poe.ninja sends no CORS headers, so it
  proxies the same 12 categories the ingest uses and flattens them to one
  name→Divine price book. CDN-cached 15 min.
- `public/tools-core.js`: pure logic, tested in `test/tools-core.test.ts`
  (regex output is checked by behaviour over 0–1199, not by string).
- `public/tools.js`, `public/tools.css`, `public/tools.html`: UI.
- `public/tools-sample-prices.json`: fallback when `/api/prices` is unavailable
  (local `dashboard:serve`, or poe.ninja down). Regenerate with
  `node scripts/generate-tools-fixture.mjs`. The page labels it "Sample prices".

## Limits (be honest about them)

- In-game overlays, hotkeys and screen reading need a desktop app; a website
  cannot draw over the game. These tools work on a second monitor or phone.
- Unique/rare gear is not on the exchange. Price check never prices gear from a
  base-type name collision; it sends you to trade instead.
- Regex stat labels are starter text. GGG renames lines between patches, so
  every label is editable.

## REA

`.mcp.json` registers [REA](https://github.com/morluto/rea) (`rea-agents@6.4.0`)
as a project MCP server, so Claude Code opened in this repo can use it. REA is a
reverse-engineering toolkit: use it only on software you own or are authorized
to analyse (for example this app's own bundles). Do not point it at
third-party tools such as PoE2 MultiTool. Native-binary analysis also needs
Ghidra, IDA or Hopper installed locally; run `npx rea-agents@6.4.0 doctor` to check.
