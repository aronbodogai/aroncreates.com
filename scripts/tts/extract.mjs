/**
 * Turns a blog post's MDX source into a narration script: an ordered list of
 * short text chunks, each followed by a pause in milliseconds.
 *
 * What gets read: the title, headings, paragraphs, lists, blockquotes, and
 * tables whose cells are words. What does not: code blocks, images, embeds,
 * raw HTML, and a trailing "Reference" section of links. Where skipping
 * something would leave the listener hanging ("...like this:"), a short
 * spoken cue points them at the written post instead.
 *
 * The output is deterministic, so its hash tells `generate.mjs` whether a
 * post's audio is stale.
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMdx from 'remark-mdx';
import { parse as parseYaml } from 'yaml';
import { applyLexicon } from './lexicon.mjs';

/** Silence after each kind of chunk, in ms. */
const PAUSE = {
	sentence: 80, // between chunks of one paragraph; Kokoro adds its own breath
	item: 350,
	paragraph: 650,
	heading: 900,
	title: 1200,
};

/** Group sentences into chunks of at most this many characters. */
const MAX_CHUNK = 260;

const CUE = {
	code: 'The code is in the written post.',
	table: 'There is a table here in the written post.',
	references: 'The references are linked in the written post.',
	opaque: 'the value shown in the post',
};

/** Headings that introduce a list of links, not prose. */
const REFERENCE_HEADING = /^(references?|sources|further reading|links|see also)$/i;

const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm).use(remarkMdx);

/**
 * @typedef {{ text: string, pause: number }} Chunk
 * @param {string} source MDX file contents
 * @returns {{ title: string, chunks: Chunk[] }}
 */
export function extractNarration(source) {
	const tree = processor.parse(source);
	/** @type {Chunk[]} */
	const blocks = [];
	let title = '';
	/** Depth of the reference heading being skipped, or 0. */
	let skipping = 0;

	const push = (text, pause) => {
		text = tidy(text);
		if (text) blocks.push({ text: endSentence(text), pause });
	};
	const pauseAtLeast = (ms) => {
		const last = blocks.at(-1);
		if (last) last.pause = Math.max(last.pause, ms);
	};
	/** Stand in for something visual. Only when a sentence introduced it, unless `always`. */
	const cue = (text, always = false) => {
		const last = blocks.at(-1);
		if (last?.text === text) return;
		if (last?.text.endsWith(':')) last.text = last.text.replace(/:$/, '.');
		else if (!always) return pauseAtLeast(PAUSE.paragraph);
		push(text, PAUSE.paragraph);
	};

	/** @param {any[]} nodes */
	const walk = (nodes, pause = PAUSE.paragraph) => {
		for (const node of nodes) {
			if (skipping) {
				if (node.type !== 'heading' || node.depth > skipping) continue;
				skipping = 0;
			}
			switch (node.type) {
				case 'yaml':
					title = String(parseYaml(node.value)?.title ?? '');
					break;
				case 'heading': {
					const text = tidy(inline(node));
					pauseAtLeast(PAUSE.heading);
					if (REFERENCE_HEADING.test(text)) {
						skipping = node.depth;
						push(CUE.references, PAUSE.heading);
						break;
					}
					// "### 1. Create the widget" -> "Step 1. Create the widget."
					push(text.replace(/^(\d+)\.\s+/, 'Step $1. '), PAUSE.heading);
					break;
				}
				case 'paragraph':
					push(inline(node), pause);
					break;
				case 'blockquote':
					walk(node.children, pause);
					break;
				case 'list':
					for (const item of node.children) walk(item.children, PAUSE.item);
					pauseAtLeast(PAUSE.paragraph);
					break;
				case 'code':
					cue(CUE.code);
					break;
				case 'table':
					table(node);
					break;
				case 'thematicBreak':
					pauseAtLeast(PAUSE.heading);
					break;
				// html, mdxJsxFlowElement (embeds), mdxjsEsm, mdxFlowExpression,
				// definition, footnoteDefinition: nothing to say.
			}
		}
	};

	/**
	 * Read row by row ("first cell: the rest.") when every cell is words; a
	 * table of keys or hashes gets a cue instead.
	 */
	const table = (node) => {
		const [, ...rows] = node.children;
		const cells = rows.map((row) => row.children.map((cell) => tidy(inline(cell))));
		if (!cells.every((row) => row.every((c) => c && !c.includes(CUE.opaque)))) {
			cue(CUE.table, true);
			return;
		}
		for (const [first, ...rest] of cells) push(rest.length ? `${first}: ${rest.join(', ')}` : first, PAUSE.item);
		pauseAtLeast(PAUSE.paragraph);
	};

	walk(tree.children);

	const chunks = [];
	if (title) chunks.push({ text: endSentence(applyLexicon(title)), pause: PAUSE.title });
	for (const block of blocks) chunks.push(...split(applyLexicon(block.text), block.pause));
	return { title, chunks };
}

/** Flatten inline markdown to plain text. */
function inline(node) {
	switch (node.type) {
		case 'text':
			return speakUrls(node.value);
		case 'inlineCode':
			return speakCode(node.value);
		case 'break':
			return ' ';
		case 'image':
		case 'imageReference':
		case 'html':
		case 'footnoteReference':
		case 'mdxTextExpression':
			return '';
		default:
			return 'children' in node ? node.children.map(inline).join('') : '';
	}
}

/** A URL or a bare domain, with or without a path. */
const URLISH = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:\/[^\s)]*)?/gi;

/** "https://github.com/x/y" and "github.com/x/y" -> "github dot com". */
function speakUrls(text) {
	return text.replace(URLISH, (_, host) => host.replace(/^www\./i, '').replaceAll('.', ' dot '));
}

/**
 * Inline code is usually an identifier the prose is talking about. Read it
 * the way a person would: `challenge_ts` as "challenge ts", `cData` as
 * "c Data", `!token` as "not token", a URL as its hostname. Keys and hashes
 * become a placeholder rather than forty characters of noise.
 */
function speakCode(code) {
	const spoken = speakUrls(code)
		.replace(/^['"`]|['"`]$/g, '')
		.replace(/!==?/g, ' not equals ')
		.replace(/===?/g, ' equals ')
		.replace(/!/g, ' not ')
		.replace(/&&/g, ' and ')
		.replace(/\|\|/g, ' or ')
		.replace(/=/g, ' equals ')
		.replace(/\+/g, ' plus ')
		.replace(/(\w)\.(?=\w)/g, '$1 dot ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/[_\-/<>(){}[\]"'`;*#$|\\]+/g, ' ')
		.replace(/\s+:/g, ':')
		.replace(/\s+/g, ' ')
		.trim();
	return spoken.split(' ').some((w) => w.length >= 20 || /\d{8}/.test(w)) ? CUE.opaque : spoken;
}

function tidy(text) {
	return text.replace(/\s+/g, ' ').trim();
}

function endSentence(text) {
	return /[.!?:;]["')\]]?$/.test(text) ? text : `${text}.`;
}

/** Split a block into sentence-group chunks of at most MAX_CHUNK chars. */
function split(text, pause) {
	const sentences = text.split(/(?<=[.!?]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/);
	const chunks = [];
	let current = '';
	for (const s of sentences) {
		if (current && current.length + 1 + s.length > MAX_CHUNK) {
			chunks.push({ text: current, pause: PAUSE.sentence });
			current = s;
		} else {
			current = current ? `${current} ${s}` : s;
		}
	}
	if (current) chunks.push({ text: current, pause });
	return chunks;
}
