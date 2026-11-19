// @ts-check
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Hash-based Content Security Policy for a prerendered site, delivered as a
 * real response header through the static assets `_headers` file.
 *
 * Why not Astro's own `security.csp`: it only emits a `<meta>` tag (no
 * report-only mode, no `frame-ancestors`, no reporting), and it does not
 * support `<ClientRouter />` or Shiki, both of which this site uses.
 *
 * What it does after `astro build`:
 *
 * 1. Rewrites each parser-inserted `<script type="module" src="…">` into a
 *    small inline loader that inserts the same script with `createElement`.
 *    Under `'strict-dynamic'` a hash only covers the inline text of a script,
 *    and browsers ignore `'self'`, so an external script in the markup would be
 *    blocked. Scripts a trusted script creates are allowed; the loader is
 *    trusted by its hash. This is the "hashes plus 'strict-dynamic' so those
 *    scripts can load the rest" pattern for static sites.
 * 2. Hashes every inline `<script>` and `<style>` in every HTML page and adds
 *    the union to `script-src` and `style-src`. Pages share one layout, so one
 *    site-wide policy is enough, and a rule for `/*` stays simple.
 * 3. Appends the policy to `_headers` in the client output, keeping whatever
 *    is already there (the Cloudflare adapter writes the `/_astro/*`
 *    Cache-Control rule into the same file).
 *
 * `_headers` only applies to static asset responses. Responses the Worker
 * generates, such as the on-demand `/tina-island` route, do not get the
 * header. (Locally, `wrangler dev` did add it to the 404 page, which the
 * Worker serves from the asset store; check production before relying on it.)
 *
 * @param {object} options
 * @param {Record<string, string[]>} options.directives Directives in order.
 *   Hashes are appended to `script-src` and `style-src`.
 * @param {boolean} [options.reportOnly] Send `Content-Security-Policy-Report-Only`
 *   instead of the enforcing header. Defaults to true.
 * @param {string} [options.reportUri] Collector URL. When set, adds a
 *   `Reporting-Endpoints` header plus `report-to` and `report-uri` directives.
 * @returns {import('astro').AstroIntegration}
 */
export default function csp({ directives, reportOnly = true, reportUri }) {
	return {
		name: 'aroncreates:csp',
		hooks: {
			'astro:build:done': async ({ dir, logger }) => {
				const clientDir = fileURLToPath(dir);
				// Tina's admin build is still in the output at this point; `pnpm
				// strip-admin` deletes it after the build, so it never ships and must
				// not add hashes to the policy.
				const adminDir = join(clientDir, 'admin');
				const pages = (await listFiles(clientDir)).filter(
					(file) => file.endsWith('.html') && !file.startsWith(adminDir + sep),
				);

				const scriptHashes = new Set();
				const styleHashes = new Set();
				let loaders = 0;

				for (const page of pages) {
					const original = await readFile(page, 'utf8');
					const html = original.replace(EXTERNAL_MODULE_SCRIPT, (_, src) => {
						loaders++;
						return `<script>${moduleLoader(src)}</script>`;
					});
					if (html !== original) await writeFile(page, html);

					const where = page.slice(clientDir.length);
					for (const [, attrs, body] of html.matchAll(SCRIPT)) {
						if (/\ssrc\s*=/i.test(` ${attrs}`)) {
							logger.warn(`${where}: external <script${attrs}> is parser-inserted, so 'strict-dynamic' will block it.`);
							continue;
						}
						if (!isExecutable(attrs)) continue; // JSON-LD, import maps of data, etc.
						scriptHashes.add(sha256(body));
					}
					for (const [, body] of html.matchAll(STYLE)) styleHashes.add(sha256(body));
					for (const [, handler] of html.matchAll(EVENT_HANDLER_ATTR)) {
						logger.warn(`${where}: inline ${handler} handler is blocked without 'unsafe-hashes'.`);
					}
				}

				const policy = Object.entries(directives).map(([name, values]) => {
					const extra =
						name === 'script-src' ? scriptHashes : name === 'style-src' ? styleHashes : new Set();
					return [name, ...values, ...[...extra].map((h) => `'${h}'`)].join(' ');
				});
				if (reportUri) policy.push('report-to csp', `report-uri ${reportUri}`);

				const header = reportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
				const lines = [`  ${header}: ${policy.join('; ')}`];
				if (reportUri) lines.unshift(`  Reporting-Endpoints: csp="${reportUri}"`);

				// Cloudflare drops `_headers` lines over 2,000 characters. Fail the
				// build instead of shipping a site without its policy.
				for (const line of lines) {
					if (line.length > 2000) {
						throw new Error(
							`[csp] ${header} line is ${line.length} characters; Cloudflare's _headers limit is 2,000. ` +
								'Too many distinct inline scripts/styles — move some into bundled files.',
						);
					}
				}

				const headersPath = join(clientDir, '_headers');
				let existing = '';
				try {
					existing = await readFile(headersPath, 'utf8');
				} catch {}
				if (existing && !existing.endsWith('\n')) existing += '\n';
				await writeFile(headersPath, `${existing}/*\n${lines.join('\n')}\n`);

				logger.info(
					`${header}: ${scriptHashes.size} script and ${styleHashes.size} style hashes from ` +
						`${pages.length} pages, ${loaders} module loaders, ${lines.at(-1)?.length} chars.`,
				);
			},
		},
	};
}

// Astro emits bundled scripts exactly in this shape. Anything else with a
// `src` is left alone and reported by the warning above.
const EXTERNAL_MODULE_SCRIPT = /<script type="module" src="([^"<>]+)"><\/script>/g;
// End tags as the HTML parser reads them: the tag name followed by whitespace,
// `/` or `>`, then anything up to `>` (`</script foo>` still closes the element).
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi;
const STYLE = /<style\b[^>]*>([\s\S]*?)<\/style(?=[\s/>])[^>]*>/gi;
// Only inside a tag: text such as a code sample is escaped (`&lt;`), so it
// never starts with a literal `<`.
const EVENT_HANDLER_ATTR = /<[a-z][^>]*?\s(on[a-z]+)\s*=/gi;

/** @param {string} src */
function moduleLoader(src) {
	const url = JSON.stringify(src).replace(/</g, '\\u003c');
	return `(function(s){s.type="module";s.src=${url};document.head.appendChild(s)})(document.createElement("script"))`;
}

/**
 * Only these script types execute, so only they are checked against `script-src`.
 * @param {string} attrs
 */
function isExecutable(attrs) {
	const type = attrs.match(/\stype\s*=\s*["']?([^"'\s>]+)/i)?.[1].toLowerCase();
	return !type || type === 'module' || type === 'text/javascript' || type === 'application/javascript';
}

/**
 * Hash the text the browser sees: the HTML parser turns CRLF and lone CR into
 * LF before a script or style body is hashed, so a build on a CRLF checkout
 * must do the same or every hash misses.
 * @param {string} text
 */
function sha256(text) {
	const normalized = text.replace(/\r\n?/g, '\n');
	return `sha256-${createHash('sha256').update(normalized, 'utf8').digest('base64')}`;
}

/** @param {string} dir @returns {Promise<string[]>} */
async function listFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const path = join(dir, entry.name);
			return entry.isDirectory() ? listFiles(path) : [path];
		}),
	);
	return nested.flat();
}
