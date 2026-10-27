Pokémon Showdown on Cloudflare Workers + D1
========================================================================

This directory runs the Pokémon Showdown **battle simulator** (`sim/`, `data/`, `config/formats.ts`) on Cloudflare's edge:

- **Workers**: a web client at `/`, plus an HTTP/JSON API for formats, teams, accounts, battles and the ladder
- **better-auth**: Google sign-in and guest sessions, stored in D1
- **Durable Objects**: one `BattleRoom` per battle. It owns the simulator instance and the players' and spectators' WebSockets
- **D1**: accounts and sessions, Showdown names, the battle index, replays of finished battles, and ladder ratings

No simulator code is forked. `build.mjs` bundles the existing TypeScript sources unchanged, so every format, mod and Random Battle generator in the repo works.


What is (and isn't) ported
------------------------------------------------------------------------

The main server (`server/`) depends on long-lived Node processes, the filesystem, SockJS and child-process pools, so it doesn't fit the Workers model. This package rebuilds its core battle features on Cloudflare primitives:

| Main server                                   | Here                                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| `RoomBattle` + simulator child processes      | `BattleRoom` Durable Object running `sim/battle.ts`    |
| SockJS connections                            | Hibernatable WebSockets on the Durable Object          |
| Login server / `Users`                        | [better-auth](https://better-auth.com): Google sign-in or guest, then claim a name |
| `ladders-local.ts` (TSV files)                | `ladder` table in D1, using the same Elo formula       |
| Replay upload                                 | Finished battles store their spectator log in D1       |
| `/challenge`, `/accept`                       | `POST /api/battles` (optionally reserved for an opponent), `POST /api/battles/:id/join` |

Not ported yet: chat rooms, chat plugins, moderation, tournaments, matchmaking search, the battle timer, and four-player formats (multi or free-for-all).


How it works
------------------------------------------------------------------------

**Bundling.** The Dex loads data with `fs.readdirSync` and `require(computedPath)`, and Workers have neither. At build time, `build.mjs`:
- replaces `__dirname` with a virtual path
- rewrites the dynamic `require`s in `sim/dex*.ts` and `sim/teams.ts` to a registry that statically bundles every data file they can request. Each module is evaluated lazily, on first use, which keeps cold starts cheap.
- swaps `fs` and `lib/index.ts` for small Worker-safe shims

**Durable battles.** The simulator is deterministic given its input log (`>start`, `>player`, `>p1 move 1`, ...). Each choice is applied to the in-memory `Battle`, and then the input log is written to Durable Object storage. If the object is evicted, for example while every WebSocket is hibernating, the next message rebuilds the battle by replaying that log. Only the `|t:|` timestamps are regenerated.

**Accounts.** better-auth handles sign-in (`/api/auth/*`) and stores its `user`, `session`, `account` and `verification` tables in the same D1 database. Signing in only creates an account. Before battling, each account claims one Showdown name, stored in `users`. Guests (better-auth's anonymous plugin) can play unrated battles only.

**Bundle size.** Every gen and mod is included, which comes to about 3.8 MB gzipped. That needs the Workers Paid plan (10 MB limit; `[limits] cpu_ms` in `wrangler.toml` is also a Paid-plan setting). To get under the free plan's 3 MB limit, trim `data/mods` from the registry in `build.mjs`.


Setup
------------------------------------------------------------------------

Requires Node.js 22+ and a Cloudflare account on the Workers Paid plan.

### 1. Google OAuth client

In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), go to **Create credentials → OAuth client ID** and choose **Web application**. Add these authorized redirect URIs:

- `https://<your-worker>.<your-subdomain>.workers.dev/api/auth/callback/google` (or your custom domain)
- `http://localhost:8787/api/auth/callback/google` for local development

### 2. Deploy

```sh
cd cloudflare
npm install
npx wrangler login                     # or export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID

npx wrangler secret put BETTER_AUTH_SECRET     # e.g. the output of `openssl rand -base64 32`
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET

npm run deploy    # wrangler deploy (creates the D1 database on first run) + remote D1 migrations
```

If the first `wrangler secret put` complains that the Worker doesn't exist yet, run `npx wrangler deploy` once first. After deploying, set `BETTER_AUTH_URL` to the Worker's public URL (`npx wrangler secret put BETTER_AUTH_URL`) so Google's redirect URI always matches.

### Local development

Local development uses a local workerd runtime and a local SQLite-backed D1:

```sh
cp .dev.vars.example .dev.vars        # then fill in the Google client (optional)
npm run migrate:local
npm run dev          # http://localhost:8787
npm test             # end-to-end tests against `wrangler dev`
npm run tsc          # typecheck
```

Without Google credentials, the sign-in page only offers guest play. `EMAIL_PASSWORD_LOGIN=true` adds email/password accounts, which the tests use to create rated players.


API
------------------------------------------------------------------------

Browsers authenticate with better-auth's session cookie, so the web client needs nothing extra. Other clients can sign in through better-auth, read the session token from the `set-auth-token` response header, and send it as `Authorization: Bearer <token>`. WebSockets can't set headers, so they accept a URL-encoded `?token=<token>` instead. better-auth rejects sign-in requests without an `Origin` header, so non-browser clients must send one that matches the Worker's URL.

| Method | Path                        | Body / query                                   | Notes |
| ------ | --------------------------- | ---------------------------------------------- | ----- |
| *      | `/api/auth/*`               |                                                | better-auth, e.g. `POST /api/auth/sign-in/social {provider: "google", callbackURL}`, `POST /api/auth/sign-in/anonymous`, `POST /api/auth/sign-out` |
| GET    | `/api/config`               |                                                | Which sign-in methods are enabled |
| GET    | `/api/formats`              |                                                | Supported formats |
| POST   | `/api/users`                | `{name}`                                       | Claims a Showdown name for the signed-in account (once per account) |
| GET    | `/api/me`                   |                                                | The signed-in account: name, email, guest flag |
| POST   | `/api/teams/validate`       | `{format, team}`                               | `team` can be exported text, packed or JSON |
| POST   | `/api/teams/generate`       | `{format}`                                     | Random Battle formats only |
| POST   | `/api/battles`              | `{format, team?, opponent?, rated?}`           | Name required. You become p1. `opponent` reserves the p2 slot for that user. Guests' battles are always unrated. |
| POST   | `/api/battles/:id/join`     | `{team?}`                                      | Name required. Joins as p2, and the battle starts. Guests can't join rated battles. |
| GET    | `/api/battles`              | `?status=&format=&user=&limit=`                | Most recent first |
| GET    | `/api/battles/:id`          |                                                | Includes `log` (the replay) and `input_log` once the battle has ended |
| GET    | `/api/battles/:id/ws`       | `?token=`                                      | WebSocket. Players need a token; spectators can connect without one. |
| GET    | `/api/ladder/:format`       | `?limit=`                                      | Ladder, sorted by Elo |

### WebSocket protocol

The server sends standard battle protocol lines (see [sim/SIM-PROTOCOL.md](../sim/SIM-PROTOCOL.md)), already split for the viewer. Players see their own private HP and `|request|` messages. Spectators see the public log. On connect, the server replays the log so far, plus the player's pending request.

The client sends one command per message:

- `/choose <choice>`, for example `/choose move 1`, `/choose switch 3` or `/choose team 123456`
- `/undo`
- `/forfeit`
- any other text is posted as chat (signed-in users only; start with `//` to send a message that begins with `/`)
