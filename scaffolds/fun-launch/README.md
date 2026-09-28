# DBC Config Preset Marketplace

A Next.js proof-of-concept for launching **Meteora Dynamic Bonding Curve (DBC)** tokens with a
configurable preset marketplace UI, built on the official
[`@meteora-ag/dynamic-bonding-curve-sdk`](https://www.npmjs.com/package/@meteora-ag/dynamic-bonding-curve-sdk).

Pick a curve profile, tune the economics with live SDK-computed readouts, and launch a
bonding-curve pool that **graduates to DAMM v2** when the quote reserve crosses the migration
threshold.

Built on top of the [Meteora `invent`](https://github.com/MeteoraAg/meteora-invent) `fun-launch`
scaffold, so it inherits the repo's Tailwind v4 theme, `ky` fetch layer, Sonner toasts and
TanStack Query setup.

---

## Contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Environment](#environment)
- [The three presets](#the-three-presets)
- [How a launch works](#how-a-launch-works)
- [Project structure](#project-structure)
- [Available scripts](#available-scripts)
- [Token metadata](#token-metadata)
- [Security notes](#security-notes)
- [SDK quirks worked around](#sdk-quirks-worked-around)
- [One-minute demo script](#one-minute-demo-script)
- [Reviewer access](#reviewer-access)
- [Troubleshooting](#troubleshooting)

---

## What it does

| Feature | Detail |
| --- | --- |
| Preset marketplace | Three named profiles — **Flat**, **Exponential**, **Custom** — each with a curated default config |
| Live configuration | Every field recomputes real `ConfigParameters` through the SDK as you type; no mock maths |
| Honest validation | Domain rules (LP splits, fee floors, locked-liquidity minimum) block the launch button with the reason |
| On-chain launch | `createConfigAndPool` on Devnet, signed by the user's wallet |
| Graduation to DAMM v2 | Configurable migration fee + full DAMM v2 pool parameters |
| Pool progress | Polls the created pool and renders curve completion, quote reserve and threshold |
| Transaction log | Live, per-launch audit trail in the side rail |

---

## Quick start

> **Note on package managers**
> `invent` is a **pnpm monorepo** (`pnpm-workspace.yaml` at the repo root) with `workspace:*`
> dependencies, so **pnpm is required** — `npm install` will fail on the workspace protocol.
> Commands below are shown for pnpm; npm equivalents are in [Available scripts](#available-scripts).

```bash
# 1. From the repo root
git clone --depth 1 https://github.com/topixyoussef-lab/meteora-invent.git
cd meteora-invent

# 2. Install (Node >= 22.12, pnpm >= 10)
corepack enable
pnpm install --filter @meteora-invent/scaffold/fun-launch...

# 3. Configure
cd scaffolds/fun-launch
cp .env.example .env.local

# 4. Run
pnpm dev
```

Then open **<http://localhost:3000/presets>**.

Fund your wallet with **Devnet SOL** before launching:

```bash
solana config set --url devnet
solana airdrop 2
```

---

## Environment

Everything has a working default except the R2 credentials. See [`.env.example`](./.env.example).

| Variable | Required | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SOLANA_CLUSTER` | no | `devnet` (default) or `mainnet-beta` |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | no | Public RPC override. **Inlined into the browser bundle — never put a secret key here** |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_ACCOUNT_ID` / `R2_BUCKET` | for metadata upload | Token metadata JSON hosting |
| `RPC_URL` | no | Server-side RPC for any future server-side script. `scripts/verify-presets.ts` is **fully offline** and never reads it |
| `POOL_CONFIG_KEY` | no | Pre-registered config PDA to reuse instead of creating a new one |

The DBC SDK needs **no API key**. Public endpoints are rate-limited, so for anything beyond
local development point `NEXT_PUBLIC_SOLANA_RPC_URL` at a dedicated or proxied endpoint.

---

## The three presets

All three build a **two-sided** curve: an initial pre-curve segment from the token's launch
price, followed by the bonding curve itself. Total token supply defaults to 1B, and the residual
(`leftover`) is the portion that migrates to the post-migration pool.

### 1. Flat — `buildCurve`

Linear price progression.

| | |
| --- | --- |
| Start price | 0.0000000031 SOL/token |
| Graduation price | 0.00000005 SOL/token |
| Price multiple | 16x |
| Migration threshold | ~10 SOL |
| Fees | 100 bps flat |

### 2. Exponential — `buildCurveWithCustomSqrtPrices`

Multi-segment curve built from an explicit geometric price ladder, controlled by two knobs:

- `exponentialSegments` — number of ladder points (3–12)
- `exponentialRamp` — per-step multiplier (1.2–2.5)

| ramp | points | segments | multiple | threshold |
| --- | --- | --- | --- | --- |
| 1.5 | 8 | 7 | 17.1x | 3.32 SOL |
| 1.9 | 8 | 7 | 89.4x | 8.54 SOL |
| 2.4 | 8 | 7 | 458.6x | 20.44 SOL |
| 1.9 | 4 | 3 | 6.9x | 1.89 SOL |
| 1.9 | 12 | 11 | 1164.9x | 33.13 SOL |

Fees decay 250 bps → 100 bps across the curve.

### 3. Custom — `buildCurveWithMarketCap`

The most flexible preset. You specify the market cap at launch and at graduation, and the SDK
solves the price range.

| | |
| --- | --- |
| Initial market cap | 200,000 SOL |
| Graduation market cap | 600,000 SOL |
| Migration threshold | ~93 SOL |
| Fees | 400 bps → 30 bps (customizable, logarithmic decay) |
| Migration | DAMM v2, **Customizable** fee |

> **Sanity check against Meteora's docs.** Their reference example uses
> `initialMarketCap: 200_000` → `migrationMarketCap: 600_000` and reports a
> **92.632 SOL** threshold. This PoC computes **93.353 SOL** for the same market caps. The
> small delta is expected: the migration threshold depends on the LP split, and this preset uses
> 60 / 20 / 10 / 10 (partner LP / creator LP / partner locked / creator locked) where the docs
> use 50 / 40 / 5 / 5.

### Domain rules enforced before launch

The launch button stays disabled, with the reason shown, until all of these hold:

- LP distribution totals **exactly 100%**
- At least **10%** of LP is permanently locked (`MIN_LOCKED_LIQUIDITY_PERCENTAGE`)
- Starting and ending fees are within `MIN_FEE_BPS` (25) and `MAX_FEE_BPS`
- Ending fee is at or below the starting fee
- Graduation market cap is greater than the initial market cap
- Migration fee stays within the DAMM v2 caps

---

## How a launch works

`prepareLaunchTransaction` in [`src/lib/meteora.ts`](./src/lib/meteora.ts):

1. Regenerates the curve through the SDK from the current UI input — the same call the preview
   uses, so **preview and submission cannot drift**.
2. Creates an in-memory keypair for the **config account** and one for the **base mint**,
   unless an existing config or mint was supplied.
3. Builds a `ConfigAndPool` instruction from the freshly generated `ConfigParameters`, with
   compute-budget instructions and the user's wallet as fee payer.
4. `partialSign`s the generated keypairs, leaving the user signature for the wallet.
5. Sends via the wallet adapter, then confirms against the **blockhash captured before
   submission** — re-reading the expiry height afterwards can return a window that no longer
   covers the landed block.

The generated keypairs exist only in memory for the duration of the transaction. They are never
persisted, logged or transmitted; see [Security notes](#security-notes).

---

## Project structure

```
scaffolds/fun-launch/
├── scripts/
│   └── verify-presets.ts              # offline preset/domain-rule verification
├── src/
│   ├── components/
│   │   ├── BondingCurveConfigurator.tsx   # preset picker + live parameter forms
│   │   ├── LaunchpadForm.tsx               # metadata form, signing, confirmation
│   │   └── WalletProvider.tsx              # Phantom + Solflare, Devnet-pinned
│   ├── lib/
│   │   ├── meteora.ts                      # SDK integration: presets, builders, tx
│   │   └── utils.ts                        # cn(), shortenAddress()
│   └── pages/
│       └── presets.tsx                     # the marketplace page
├── .env.example
├── next.config.ts
├── tsconfig.json
└── tsconfig.scripts.json               # build config for scripts/verify-presets.ts
```

The original scaffold's `index.tsx` and `Explore` components are left intact — the PoC lives at
**`/presets`** so nothing existing is broken.

---

## Available scripts

Run from `scaffolds/fun-launch`.

| pnpm | npm equivalent | Description |
| --- | --- | --- |
| `pnpm dev` | `npm run dev` | Dev server with Turbopack |
| `pnpm build` | `npm run build` | Production build |
| `pnpm start` | `npm start` | Serve the production build |
| `pnpm typecheck` | `npm run typecheck` | `tsc --noEmit` — **run this** |
| `pnpm verify:presets` | `npm run verify:presets` | Offline preset + rule checks |
| `pnpm lint` | `npm run lint` | ESLint |
| `pnpm format` | `npm run format` | Prettier |

> **`pnpm typecheck` is not optional.**
> [`next.config.ts`](./next.config.ts) sets `typescript.ignoreBuildErrors` and
> `eslint.ignoreDuringBuilds`, so `pnpm build` will happily ship type errors. Always run
> `pnpm typecheck` in CI.
>
> **Known baseline:** `pnpm typecheck` currently reports **56 pre-existing errors**, all in
> scaffold code that ships with this template and none in the files added for this
> marketplace (`src/lib/meteora.ts`, `src/components/WalletProvider.tsx`,
> `src/components/BondingCurveConfigurator.tsx`, `src/components/LaunchpadForm.tsx`,
> `src/pages/presets.tsx`, `scripts/verify-presets.ts` — all six are clean). They live in
> `src/components/Explore/`, `src/components/TokenTable/`, `src/components/Terminal/`,
> `src/pages/token/`, and some scaffold hooks. Until they are fixed the command exits
> non-zero, so gate CI on a baseline diff rather than a zero exit code.

`pnpm verify:presets` compiles `scripts/verify-presets.ts` and runs it with no network or wallet.
It asserts, for every preset, that the SDK produces a sane curve and that invalid input is
rejected. Expected output ends with `RESULT: ALL CHECKS PASSED`.

---

## Token metadata

DBC tokens need a metadata JSON document at an HTTPS URI. The PoC accepts any HTTPS URL, and the
scaffold's R2 integration is the intended way to host one. The bucket must allow public reads
**and** a `HEAD` request, since the SDK and wallets fetch the URI:

```jsonc
// CORS on the R2 bucket
[
  {
    "allowedOrigins": ["*"],
    "allowedMethods": ["GET", "HEAD"],
    "exposeHeaders": ["ETag"],
    "allowedHeaders": ["*"]
  }
]
```

The document itself is the standard Metaplex shape:

```json
{
  "name": "Virtual Curve",
  "symbol": "VRTL",
  "description": "A token launched from the DBC preset marketplace.",
  "image": "https://<your-bucket>/virtual-curve.png",
  "properties": {
    "files": [{ "uri": "https://<your-bucket>/virtual-curve.json", "cid": "<ipfs-cid>", "type": "application/json" }],
    "category": "token"
  }
}
```

The launch form validates that the URI is `https://`, that the symbol is 2–10 characters, and
that the name is non-empty — plain `http://` is rejected because wallets refuse to render it.

---

## Security notes

- **No private keys are stored.** The config and mint keypairs are generated per launch with
  `Keypair.generate()`, used to `partialSign`, and dropped. Nothing is written to disk, storage
  or a log.
- **No secret RPC keys in the browser.** `NEXT_PUBLIC_*` values are inlined into the client
  bundle by Next.js. Use a rate-limited public endpoint or proxy through your own server.
- **Devnet by default.** The cluster resolves to `devnet` unless explicitly overridden, so a
  misconfigured deploy cannot accidentally spend mainnet SOL.
- **The UI cannot silently mis-launch.** Invalid configurations are blocked with a stated reason,
  and the submitted parameters are regenerated from the same input the preview renders.

---

## SDK quirks worked around

These were found by reading SDK 1.5.11's source and by runtime diagnostics. They are the reason
several things look defensive.

1. **`createTokenWithDynamicCurve` does not exist.** The partner API is
   `dbc.partner.createConfigAndPool(...)`. An existing config uses
   `dbc.creator.createPool(...)`.

2. **`buildCurveWithLiquidityWeights` hardcodes 16 segments in 1.5.11.** Its `liquidityWeights`
   array is indexed `liquidityWeights[i - 1]` across a `for (let i = 1; i < 17; i++)` loop, so
   exactly **16** weights are required and consumed. The Exponential preset instead builds an
   explicit geometric ladder with `buildCurveWithCustomSqrtPrices`, which takes a `sqrtPrices`
   array and so lets the number of segments follow directly from the UI slider rather than being
   pinned to 16.

3. **Multi-segment builders reject `leftover: 0`.** They throw
   `leftOverDelta must be less than totalLeftover` when the residual is zero. The Exponential
   preset uses `leftover: 1_000_000`; a small positive residual also works where zero does not.

4. **`validateConfigParameters(preview.params)` throws.** On the `ConfigParameters` return value
   it fails with `Cannot read properties of undefined (reading '_bn')`. Validation is done by
   rebuilding the params and checking the derived values, not by calling that helper.

5. **The last `sqrtPrice` in a curve is not the graduation price.** It is a sentinel for the
   post-migration segment. Use `getMigrationThresholdPrice(...)` instead.

6. **`tokenSupply.*TokenSupply` is in base units.** Not human-readable token counts.

7. **`poolFees.baseFee` is derived fee state.** It is not a copy of the fee scheduler inputs, so
   the UI shows the configured BPS values rather than reading them back from the response.

8. **`ConnectionProvider` needs an HTTP endpoint.** Passing a `wss://` URL type-checks but fails
   at runtime, because `Connection` speaks HTTP JSON-RPC. `WalletProvider` takes the WebSocket
   URL separately when subscription support is needed.

---

## One-minute demo script

Target: 60 seconds. Screen record at 1920x1080, cursor enlarged.

| Time | Action | Say |
| --- | --- | --- |
| 0:00–0:06 | Open `/presets`. Show header, cluster pill reading **devnet**, empty launch panel. | "This is a Meteora Dynamic Bonding Curve launchpad running on Devnet. Three curve presets, live SDK-computed economics, and automatic graduation to DAMM v2." |
| 0:06–0:14 | Click **Flat**. Point at the start price, graduation price, 16x multiple, ~10 SOL threshold. | "Flat is a two-segment linear curve. Sixteen times price multiple, graduating at about ten SOL. Every number here is computed by the SDK, not hard-coded." |
| 0:14–0:24 | Click **Exponential**. Drag `exponentialRamp` from 1.5 to 2.4. Watch segments, multiple and threshold move together. | "Exponential builds a multi-segment curve from a geometric ladder. Bumping the ramp from 1.5 to 2.4 takes the price multiple from seventeen to over four hundred, and the migration threshold from three to twenty SOL." |
| 0:24–0:34 | Click **Custom**. Change graduation market cap to 600k SOL. Point at the ~93 SOL threshold and the DAMM v2 migration row. | "Custom lets you specify market caps directly. Two hundred thousand to six hundred thousand SOL gives a ninety-three SOL migration threshold — matching Meteora's reference within rounding. It graduates into a DAMM v2 pool." |
| 0:34–0:44 | Toggle the LP split so it doesn't total 100%. Show the launch button disabled and the reason. | "Validation is enforced before you can launch. Break the LP split and the button locks with the reason, rather than letting you waste a transaction." |
| 0:44–0:56 | Connect Phantom, fill in name / symbol / metadata URL, click **Launch**, approve in the wallet. Show the toast and the transaction log entries appearing. | "Connect a wallet, name the token, and launch. The app creates the config and base mint, the wallet signs, and you get live status plus Solscan links." |
| 0:56–1:00 | Show the pool progress panel and the DBC program ID link. | "The pool is live on Devnet, tracking curve completion against the threshold. Same program ID on mainnet — the code is network-agnostic." |

**Capture notes**

- Pre-load a funded Devnet wallet so the Phantom prompt is instant.
- Have the metadata JSON already in R2 and paste it in rather than typing.
- Narrate the number changes as you drag — the whole point is live recomputation.
- Keep the console closed; nothing interesting happens there.

---

## Reviewer access

This fork is a **public** repository — anyone can clone, read, and run it without an
invitation. No access needs to be granted.

Because the upstream (`MeteoraAg/meteora-invent`) is itself public, a fork of it cannot be
private: GitHub does not allow private forks of public repositories. If this PoC needs to be
confidential, it has to live in a **separate private repository** rather than a fork, and the
`Reviewer access` instructions below would then apply.

To still track specific reviewers, or to add someone as a collaborator:

1. Go to **Settings → Collaborators** on your fork.
2. Click **Add people** and add the reviewer's GitHub handle.
3. Send the invitation, and have them accept it.

Or with the GitHub CLI (must be run by an owner/admin who is already authenticated):

```bash
gh api -X PUT repos/<you>/meteora-invent/collaborators/<reviewer-username> \
  -f permission=read
```

> On a public repository this only adds *collaborator* status (push rights, issue
> notifications). It is **not** an access control — the code stays readable by everyone
> regardless.

---

## Troubleshooting

**`pnpm install` fails with "specifier not found: workspace:*"**
You are not in the monorepo root, or you used `npm install`. Run `pnpm install` from the repository
root.

**`tsc` runs out of memory**
The SDK's type surface is large. Try `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck`.
On a machine with a small commit limit, run it with nothing else open.

**Wallet button does nothing**
Check the cluster pill says `devnet` and that the browser is on `localhost` (Phantom blocks
`localhost` from some contexts). Try Solflare as a cross-check.

**"Metadata URI must be a valid https:// URL"**
`http://` is rejected by design — wallets will not render it. Make sure R2 serves over HTTPS and
that the bucket's CORS policy includes `GET` and `HEAD`.

**`leftOverDelta must be less than totalLeftover`**
An SDK constraint on multi-segment builders. The Exponential preset already uses a small positive
`leftover`; if you construct your own params, do the same.

**Transaction is not landing on Devnet**
Devnet congestion is common. Confirm the signature in the toast's Solscan link, then retry. A
`BlockhashNotFound` error means the confirmation window expired during signing — retry.

---

## License

ISC, matching the upstream `invent` scaffold.
