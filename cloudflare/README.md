Pokémon Showdown on Cloudflare Workers + D1
========================================================================

This directory runs the Pokémon Showdown **battle simulator** (`sim/`, `data/`, `config/formats.ts`) on Cloudflare's edge:

- **Workers**: an HTTP/JSON API for formats, teams, users, battles and the ladder
- **Durable Objects**: one `BattleRoom` per battle. It owns the simulator instance and the players' and spectators' WebSockets
- **D1**: users, the battle index, replays of finished battles, and ladder ratings

No simulator code is forked. `build.mjs` bundles the existing TypeScript sources unchanged, so every format, mod and Random Battle generator in the repo works.


What is (and isn't) ported
------------------------------------------------------------------------

The main server (`server/`) depends on long-lived Node processes, the filesystem, SockJS and child-process pools, so it doesn't fit the Workers model. This package rebuilds its core battle features on Cloudflare primitives:

| Main server                                   | Here                                                   |
| --------------------------------------------- | ------------------------------------------------------ |
| `RoomBattle` + simulator child processes      | `BattleRoom` Durable Object running `sim/battle.ts`    |
| SockJS connections                            | Hibernatable WebSockets on the Durable Object          |
| Login server / `Users`                        | Name registration with bearer tokens, stored in D1     |
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

**Bundle size.** Every gen and mod is included, which comes to about 3.7 MB gzipped. That needs the Workers Paid plan (10 MB limit). To get under the free plan's 3 MB limit, trim `data/mods` from the registry in `build.mjs`.


Setup
------------------------------------------------------------------------

Requires Node.js 22+ and a Cloudflare account.

```sh
cd cloudflare
npm install

# Create the D1 database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create pokemon-showdown
npm run migrate:remote

npm run deploy
```

Local development uses a local workerd runtime and a local SQLite-backed D1:

```sh
npm run migrate:local
npm run dev          # http://localhost:8787
npm test             # end-to-end tests against `wrangler dev`
npm run tsc          # typecheck
```


API
------------------------------------------------------------------------

Endpoints that require a login take `Authorization: Bearer <token>`. WebSockets can't set headers, so they accept `?token=<token>` instead.

| Method | Path                        | Body / query                                   | Notes |
| ------ | --------------------------- | ---------------------------------------------- | ----- |
| GET    | `/api/formats`              |                                                | Supported formats |
| POST   | `/api/users`                | `{name}`                                       | Registers a name and returns `{userid, name, token}`. The token is shown only once. |
| GET    | `/api/me`                   |                                                | Login required |
| POST   | `/api/teams/validate`       | `{format, team}`                               | `team` can be exported text, packed or JSON |
| POST   | `/api/teams/generate`       | `{format}`                                     | Random Battle formats only |
| POST   | `/api/battles`              | `{format, team?, opponent?, rated?}`           | Login required. You become p1. `opponent` reserves the p2 slot for that user. |
| POST   | `/api/battles/:id/join`     | `{team?}`                                      | Login required. Joins as p2, and the battle starts. |
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
- any other text is posted as chat (logged-in users only)

### Example

```sh
URL=http://localhost:8787
A=$(curl -s -XPOST $URL/api/users -d '{"name":"Alice"}' | jq -r .token)
B=$(curl -s -XPOST $URL/api/users -d '{"name":"Bob"}'   | jq -r .token)
ID=$(curl -s -XPOST $URL/api/battles -H "Authorization: Bearer $A" \
	-d '{"format":"gen9randombattle","opponent":"Bob"}' | jq -r .id)
curl -s -XPOST $URL/api/battles/$ID/join -H "Authorization: Bearer $B" -d '{}'
# then connect to ws://localhost:8787/api/battles/$ID/ws?token=$A (and $B)
```
