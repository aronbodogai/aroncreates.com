// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import icon from 'astro-icon';
import tina from '@tinacms/astro/integration';
import { tinaAdminDevRedirect } from '@tinacms/astro/vite';
import tailwindcss from '@tailwindcss/vite';

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

// Cloudflare Workers injects no deploy-URL variable, so SITE_URL has to be set
// in the build environment or the sitemap, RSS, and OpenGraph tags all emit
// localhost canonicals. Local builds fall back to localhost on purpose.
function getSiteUrl() {
	return process.env.SITE_URL ?? 'http://localhost:4321';
}

// https://astro.build/config
export default defineConfig({
	site: getSiteUrl(),
	output: 'static',
	adapter: await getAdapter(),
	redirects: { '/home': '/' },
	integrations: [mdx(), sitemap(), icon(), tina()],
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
