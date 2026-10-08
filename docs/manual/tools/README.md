# Manual demo tooling

Regenerates the 21 screenshots in `docs/manual/images/` from a throwaway DEMO instance with 100% synthetic data
(fake provider, no network, no real data).

```
node docs/manual/tools/capture.mjs
```

Needs Node 24 and `/usr/bin/google-chrome` (override with `CHROME_BIN`). Takes about one minute. Add `CAPTURE_DEBUG=1` to see server logs.

What it does:

1. Creates temp data dirs under `/tmp` and starts `demo-server.ts` on port **3100** (production mode, reuses the existing `.next` build; never runs `next build`).
2. Phase A (empty DB): drives the real UI through first run, connection, discovery and account selection (images 01-04).
3. Phase B: `seed-demo.ts` fills a second temp dir (connection, 60 comments, automations, queue in varied states, a complete scan), the server restarts on it and the rest is captured (05-21), including the switch to real mode and back.
4. Stops only the processes it started and deletes the temp dirs and the Chrome profile.

Files: `demo-provider.ts` (fake provider, never touches the network), `demo-server.ts` (copy of `server.ts` wired to it; refuses to start unless `LOCAL_SOCIAL_DATA_DIR` is under `/tmp`, refuses port 3000), `seed-demo.ts`, `capture.mjs`.

Never point these at `./data` or port 3000. If the UI changes, rebuild the app (`npm run build`, by the owner) and re-run the capture.
