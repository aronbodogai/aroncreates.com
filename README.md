# aroncreates.com

Personal site. [Astro](https://astro.build) for the build, [TinaCMS](https://tina.io/)
for editing, Markdown in Git for storage, [Cloudflare Workers](https://workers.cloudflare.com/)
for hosting.

## How editing works

There is **no CMS backend and no admin page in production**. The Tina admin UI is
built and served only by the local dev server, on a machine that already has the
repo. Publishing is a `git push`.

```sh
pnpm install
pnpm dev
```

Then edit visually at <http://localhost:4321/admin/>. Saves write Markdown into
`src/content`. Commit and push, and Cloudflare Workers Builds deploys.

This is a deliberate trade: no hosted admin means nothing to authenticate, no
CMS vendor in the path, and no attack surface to lock down — at the cost of not
being able to edit from a device without the repo.

`pnpm build` runs `pnpm strip-admin` afterwards, which deletes `dist/admin`. If
you change the build command, keep that step, or the admin UI ships publicly.

## Content

| Path | What it is |
| --- | --- |
| `src/content/page` | Block-composed pages (`home`, `about`) |
| `src/content/blog` | Blog posts, MDX |
| `src/content/config` | Site title, nav, footer links |

Collections are defined in `tina/collections`. Page blocks live in
`src/components/blocks` — each has a `.astro` renderer and a `.template.ts`
schema, and both must be registered for a block to appear in the editor.

## Audio narration

Every blog post can carry a "Listen to this post" player. The audio is
generated locally with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
(an open-weights TTS model, Apache 2.0) and committed like any other asset;
nothing calls a TTS service at build or request time.

```sh
pnpm tts             # generate audio for new or edited posts
pnpm tts --check     # list posts whose audio is missing or stale
```

Run it after writing or editing a post, then commit `public/audio/blog/` and
`src/data/blog-audio.json` with the post. Unchanged posts are skipped: the
manifest stores a hash of the narration text and voice settings, so a typo fix
regenerates one file and a layout change regenerates none.

- **Needs** [`uv`](https://docs.astral.sh/uv/). The first run provisions
  Python, CPU PyTorch and Kokoro (about 1.5 GB of downloads, cached by uv and
  Hugging Face). Generation runs at roughly 5× real time on CPU, so a
  25-minute post takes about five minutes. For a GPU, switch the torch index
  in `scripts/tts/synth.py` to `cu128`. Python dependencies are pinned in
  `scripts/tts/synth.py.lock`; refresh with
  `uv lock --script scripts/tts/synth.py --upgrade`.
- **What is read**: title, headings, prose, lists, and word tables. Code
  blocks, images and the trailing "Reference" link list are skipped, with a
  short spoken cue where the text introduces them. `pnpm tts --text <slug>`
  prints exactly what will be read.
- **Pronunciation**: fix a misread word in `scripts/tts/lexicon.mjs`.
  `pnpm tts --phonemes <slug>` shows what Kokoro will say.
- **Voice and quality**: `SETTINGS` in `scripts/tts/generate.mjs` (voice
  `af_heart`, 64 kbps mono MP3). Changing them regenerates every post.

Workers static assets ignore `Range` headers, and Safari will not play media
without them, so the player loads audio through `src/pages/listen/[file].ts`,
which serves byte ranges from the same files.

## Deploying

Cloudflare Workers Builds deploys `main` on push. It needs:

- **Build command** `pnpm build`
- **Deploy command** `npx wrangler deploy`
- Nothing else. Workers injects no deploy-URL variable, so `astro.config.mjs`
  uses `https://aroncreates.com` as the canonical origin whenever `WORKERS_CI`
  is set. Set `SITE_URL` in the build environment only to override it (for
  example, a staging domain).

`wrangler.jsonc` serves `./dist` from the asset store and falls through to
`dist/_worker.js` for the one on-demand route (`/tina-island`, which backs
visual editing and is inert in production).

`astro.config.mjs` picks the Cloudflare adapter when `WORKERS_CI` is set and a
Node server otherwise, so a local `pnpm build && pnpm preview` still works.
Override with `DEPLOY_ADAPTER`.

## Notes

- `public/og-default.jpg` is the fallback OpenGraph image, inherited from the
  starter. Worth replacing.
- `pnpm-lock.yaml` is committed on purpose so CI installs the same tree.
- Port 9000 is Tina's datalayer. If it is already in use, pass
  `--datalayer-port` rather than killing whatever holds it.
