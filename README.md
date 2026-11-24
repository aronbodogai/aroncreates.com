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

## Content Security Policy

The site sends a strict, hash-based CSP, currently as
`Content-Security-Policy-Report-Only`. The directives live in
`astro.config.mjs`; `src/integrations/csp.mjs` does the rest after
`astro build`:

- every inline `<script>` and `<style>` in the built HTML is hashed into
  `script-src` / `style-src`, so editing an `is:inline` script or the CSS needs
  no manual step;
- the bundled `<script type="module" src>` tags are swapped for a small hashed
  loader, because `'strict-dynamic'` only trusts scripts that a trusted script
  creates, not external tags in the markup;
- the header is appended to `dist/client/_headers`, which Workers applies to
  static asset responses (not to responses the Worker itself generates).

Things that need a policy change rather than just a rebuild: a new image host
(`img-src`), a new embed such as a Vimeo URL in the Video block (`frame-src`),
and inline `on…=` handler attributes, which are not allowed at all. The build
warns about the last one and about external scripts it cannot cover.

### Switching to enforcing

1. Add a reporting endpoint: set `reportUri` in the `csp()` options. That adds
   `Reporting-Endpoints`, `report-to` and `report-uri`. Not chosen yet.
2. Leave it in report-only for a couple of weeks of real traffic. Check the
   header is live with
   `curl -sI https://aroncreates.com/ | grep -i content-security`, and open the
   home page, a post with code blocks and a page with a YouTube embed in
   Chrome, Firefox and Safari with the console open. There should be no
   `[Report Only]` messages.
3. Triage the reports. Ignore browser-extension noise (`chrome-extension:`,
   `moz-extension:`, `safari-web-extension:` blocked URLs); fix anything else
   by adding the source in `astro.config.mjs` or moving the code into a bundled
   script.
4. Set `reportOnly: false`, run `pnpm build`, confirm
   `dist/client/_headers` now says `Content-Security-Policy:`, and push. Keep
   the reporting on.

## Notes

- `public/og-default.jpg` is the fallback OpenGraph image, inherited from the
  starter. Worth replacing.
- `pnpm-lock.yaml` is committed on purpose so CI installs the same tree.
- Port 9000 is Tina's datalayer. If it is already in use, pass
  `--datalayer-port` rather than killing whatever holds it.
