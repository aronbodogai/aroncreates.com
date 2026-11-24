/**
 * Spoken-form rewrites applied to the narration text before it reaches the
 * TTS model. Kokoro's G2P (misaki) already spells out acronyms (CSP, XSS,
 * PCI DSS) and knows most tech vocabulary, so this list is only for what it
 * gets wrong. Fix a mispronunciation by adding a row, then `pnpm tts`
 * regenerates only the posts whose narration text changed.
 *
 * Each row is [pattern, replacement]. A string pattern matches a whole word,
 * case-sensitively; use a RegExp for anything else. The replacement can be a
 * function, as with String.prototype.replace. Rows apply in order.
 *
 * Check how a post will be read without generating audio:
 *   pnpm tts --text <slug>       the text Kokoro receives
 *   pnpm tts --phonemes <slug>   the phonemes it turns that into
 */
const MONTHS = [
	'January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December',
];

export const lexicon = [
	// Abbreviations and symbols
	[/\be\.g\.,?/g, 'for example,'],
	[/\bi\.e\.,?/g, 'that is,'],
	[/\betc\./g, 'and so on.'],
	[/\bvs\.?(?=\s)/g, 'versus'],
	[/\s&\s/g, ' and '],
	[/\s*(?:→|->)\s*/g, ' to '],
	[/(\d)\s?–\s?(\d)/g, '$1 to $2'], // en-dash ranges: 1–3, 0.1–2%
	[/\(\s*>\s*(\d[\d,.]*)\s*\)/g, 'over $1'], // (>2048)
	[/(?<=\s)>\s?(?=\d)/g, 'over '],
	[/≈\s*|~(?=\d)/g, 'about '],

	// 2025.09.23 (dates written as version numbers) -> September 23, 2025
	[/\b(\d{4})\.(\d{2})\.(\d{2})\b/g, (m, y, mo, d) => (MONTHS[mo - 1] ? `${MONTHS[mo - 1]} ${Number(d)}, ${y}` : m)],
	// Nobody wants 261980999226229 read out in full.
	[/\b\d{10,}\b/g, (m) => `a ${m.length}-digit number`],

	// Words misaki reads wrong
	['nginx', 'engine x'],
	['JSON', 'jason'],
	['JSONP', 'jason P'],
	['openssl', 'open S S L'],
	['OpenSSL', 'open S S L'],
	['OWASP', 'oh-wasp'],
	['CNAME', 'C name'],
	['CNAMEs', 'C names'],
	[/\ba SPA\b/g, 'an S P A'],
	['SPA', 'S P A'],
	['uuidv5', 'UUID v5'],
	[/\bsha256\b/gi, 'sha two fifty-six'],
	['bruteforce', 'brute force'],
	['Fermat', 'fer-mah'],
	['siteverify', 'site verify'],
	['src', 'source'], // script-src, default-src, ...
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compiled = lexicon.map(([pattern, replacement]) => [
	typeof pattern === 'string' ? new RegExp(`(?<!\\w)${escape(pattern)}(?!\\w)`, 'g') : pattern,
	replacement,
]);

/** @param {string} text */
export function applyLexicon(text) {
	return compiled.reduce((t, [re, rep]) => t.replace(re, rep), text);
}
