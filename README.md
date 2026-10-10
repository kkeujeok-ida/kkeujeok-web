# kkeujeok-web

Web client for Kkeujeok (Vite + React + TypeScript).

## Clone location

This repo must be cloned **inside the root `kkeujeok` repo**, as a sibling of
its `spec/` and `test/` folders:

```
kkeujeok/
  spec/
  test/            <- shared fixtures, read unchanged by `npm test`
  kkeujeok-web/    <- this repo
```

`npm test` fails if `../test/` is not there.

## Setup

Requires Node 22.12 or newer and npm.

```sh
npm install
cp .env.example .env.local   # then fill in VITE_GOOGLE_CLIENT_ID
```

`.env.local` holds your Google OAuth web client ID. It is git-ignored; never
commit it. Use a client from your own Google Cloud project, with
`http://localhost:5173` listed as an authorized JavaScript origin.

## Commands

| Command         | What it does                                                     |
| --------------- | ---------------------------------------------------------------- |
| `npm run dev`   | Dev server on http://localhost:5173 (fixed port, fails if taken) |
| `npm run build` | Type-check and build to `dist/`                                  |
| `npm test`      | Run every fixture in `../test/` against this client              |

The dev port is fixed because the OAuth authorized origin includes the port.

Dependencies are pinned to exact versions; `.npmrc` makes `npm install <pkg>`
save an exact version and refuses a Node version outside `engines`.

## Layout

`src/` has exactly these layers: `model/ ops/ sync/ storage/ drive/ render/ ui/`.
The fixture harness lives in `tests/`, outside `src/`, because it uses Node APIs.
A fixture in `../test/` with no entry in the harness's `runners` table fails the run.
