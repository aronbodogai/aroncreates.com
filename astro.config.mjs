// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';
import tina from '@tinacms/astro/integration';
import { tinaAdminDevRedirect } from '@tinacms/astro/vite';
import tailwindcss from '@tailwindcss/vite';
import csp from './src/integrations/csp.mjs';

// Every content page prerenders to static HTML; the one on-demand route
// (/tina-island, the visual-editing endpoint) needs a server. Cloudflare
// Workers Builds sets WORKERS_CI, so CI picks the Cloudflare adapter on its
// own. Everything else — local `astro build`, `astro preview` — falls back to
// a portable Node server. Set DEPLOY_ADAPTER to force one.
async function getAdapter() {
	const cloudflare = async () => (await import('@astrojs/cloudflare')).default();
	const nodeStandalone = async () =>
		(await import('@astrojs/node')).default({ mode: 'standalone' });

	switch (process.env.DEPLOY_ADAPTER) {
		case 'cloudflare': return cloudflare();
		case 'node': return nodeStandalone();
		case undefined: break; // no override -> auto-detect below
		default:
			console.warn(`[astro.config] Unknown DEPLOY_ADAPTER "${process.env.DEPLOY_ADAPTER}" - ignoring and auto-detecting.`);
	}
	if (process.env.WORKERS_CI) return cloudflare();

	return nodeStandalone();
}

// Cloudflare Workers injects no deploy-URL variable, so CI builds default to
// the production origin; relying on a dashboard SITE_URL alone let the
// sitemap, RSS, and OpenGraph tags ship localhost canonicals when it was
// missing. SITE_URL still overrides. Local builds fall back to localhost on
// purpose.
function getSiteUrl() {
	if (process.env.SITE_URL) return process.env.SITE_URL;
	return process.env.WORKERS_CI ? 'https://aroncreates.com' : 'http://localhost:4321';
}

// https://astro.build/config
export default defineConfig({
	site: getSiteUrl(),
	output: 'static',
	adapter: await getAdapter(),
	redirects: { '/home': '/' },
	integrations: [
		mdx(),
		sitemap(),
		icon(),
		tina(),
		// Strict, hash-based CSP written into dist/client/_headers at build time.
		// Report-only for now; README.md lists the steps to enforce it.
		csp({
			reportOnly: true,
			directives: {
				'default-src': ["'self'"],
				// Hashes of every inline script are appended. 'strict-dynamic' lets
				// those scripts load the rest; browsers that support it ignore the
				// https: and 'unsafe-inline' fallbacks, which exist for old ones.
				'script-src': ["'strict-dynamic'", "'report-sample'", 'https:', "'unsafe-inline'"],
				// Hash of the inlined stylesheet is appended (build.inlineStylesheets).
				'style-src': ["'self'", "'report-sample'"],
				// Shiki colours tokens, and the starfield and YouTube facade set
				// per-element values, with style="" attributes.
				'style-src-attr': ["'unsafe-inline'"],
				// i.ytimg.com: YouTube facade poster (CSS background-image).
				'img-src': ["'self'", 'https://i.ytimg.com'],
				'font-src': ["'self'"],
				'connect-src': ["'self'"],
				// The facade swaps in the youtube-nocookie player on click.
				'frame-src': ['https://www.youtube-nocookie.com'],
				'object-src': ["'none'"],
				'base-uri': ["'none'"],
				'form-action': ["'self'"],
				'frame-ancestors': ["'none'"],
			},
		}),
	],
	build: {
		// Inline the (~10 KiB) bundled CSS into a <style> in <head> instead of a
		// separate render-blocking <link>. Astro's default ('auto') only inlines
		// stylesheets under ~4 KiB, leaving ours blocking first paint on mobile.
		inlineStylesheets: 'always',
	},
	// Tina Cloud rewrites CMS image src to assets.tina.io; let Astro
	// fetch those URLs at build time so <Image> can transcode + resize them.
	image: {
		// Astro 6 responsive images: auto-emit srcset so the browser picks a
		// variant matched to the rendered box + DPR, not the full intrinsic size.
		layout: 'constrained',
		remotePatterns: [{ protocol: 'https', hostname: 'assets.tina.io' }],
	},
	vite: {
		plugins: [tailwindcss(), tinaAdminDevRedirect()],
		// Bundle @tinacms/astro into the SSR build instead of resolving it
		// per-module on every cold request — otherwise each
		// `import TinaMarkdown from '@tinacms/astro/TinaMarkdown.astro'`
		// triggers a full Vite resolve + Astro-plugin compile of the
		// package's source `.astro` files on the first request.
		ssr: {
			noExternal: ['@tinacms/astro', '@tinacms/bridge'],
		},
		build: {
			rollupOptions: {
				onwarn(warning, warn) {
					if (warning.code === 'UNUSED_EXTERNAL_IMPORT' &&
						warning.exporter === 'tinacms/dist/client') {
						return;
					}
					warn(warning);
				}
			}
		}
	}
});
