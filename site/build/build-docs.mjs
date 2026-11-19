/**
 * Builds the docs section of the site from the repo's own Markdown.
 *
 *   cd site/build && npm install && npm run build      ->  writes site/docs/
 *
 * docs/*.md stays the single source of truth; nothing is copied by hand and the
 * generated output is not committed. The renderer is markdown-it (the engine Yank
 * Note, our recommended Markdown editor, is built on), with KaTeX for math,
 * highlight.js for code, and Mermaid drawn in the browser.
 *
 * What it does beyond rendering:
 *  - rewrites links: a .md file in the curated set becomes a site page, a
 *    file:///c:/Users/... path (from an old Windows checkout) or any other repo path
 *    becomes a GitHub link, anchors use GitHub's heading slugs so old links keep working;
 *  - builds the sidebar from docs.config.json, an on-page contents list, prev/next
 *    links, and a search index;
 *  - reports links that point at files that do not exist, without failing the build.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const OUT = resolve(here, '../docs');
const cfg = JSON.parse(readFileSync(join(here, 'docs.config.json'), 'utf8'));
const GH = `https://github.com/${cfg.repo}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- Pages ---------- */
const pages = [];
for (const g of cfg.groups) for (const p of g.pages) pages.push({ ...p, group: g, repoPath: 'docs/' + p.file });
const slugByRepoPath = new Map(pages.map((p) => [p.repoPath, p.slug]));

/** GitHub's heading slug, so existing #anchor links in the docs keep working. */
function ghSlug(text) {
    return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}

const warnings = [];

/* ---------- Link rewriting ---------- */
function resolveHref(href, env) {
    if (/^(https?:|mailto:|tel:)/i.test(href) || href === '') return { href };
    if (href.startsWith('#')) return { href };
    let p = href, hash = '';
    const hi = p.indexOf('#');
    if (hi >= 0) { hash = p.slice(hi); p = p.slice(0, hi); }
    p = decodeURI(p);
    let repoPath;
    const fileUrl = /^file:\/+(?:[a-z]:\/)?(.*)$/i.exec(p);
    if (fileUrl) {
        // file:///c:/Users/user/Downloads/mmo-engine-full/apps/edge  ->  apps/edge
        const m = /mmo-engine-full\/(.*)$/i.exec(fileUrl[1]);
        repoPath = m ? m[1] : null;
        if (repoPath === null) { warnings.push(`${env.file}: cannot map ${href}`); return { href: '#' }; }
    } else {
        repoPath = posix.normalize(posix.join(posix.dirname(env.file), p));
    }
    repoPath = repoPath.replace(/\/$/, '');
    if (repoPath.startsWith('..')) { warnings.push(`${env.file}: link leaves the repo: ${href}`); return { href: '#' }; }
    const slug = slugByRepoPath.get(repoPath);
    if (slug) return { href: slug + '.html' + hash };
    const abs = join(ROOT, repoPath);
    if (!existsSync(abs)) {
        warnings.push(`${env.file}: broken link -> ${repoPath}`);
        return { href: `${GH}/blob/${cfg.branch}/${repoPath}${hash}`, broken: true };
    }
    const kind = statSync(abs).isDirectory() ? 'tree' : 'blob';
    return { href: `${GH}/${kind}/${cfg.branch}/${repoPath}${hash}` };
}

function linkRewrite(md) {
    md.core.ruler.push('nexus_links', (state) => {
        for (const blk of state.tokens) {
            if (blk.type !== 'inline' || !blk.children) continue;
            const kids = [];
            for (const t of blk.children) {
                if (t.type === 'link_open') {
                    const r = resolveHref(t.attrGet('href') || '', state.env);
                    t.attrSet('href', r.href);
                    if (r.broken) t.attrJoin('class', 'broken');
                    if (/^https?:/.test(r.href)) { t.attrSet('target', '_blank'); t.attrSet('rel', 'noopener'); }
                } else if (t.type === 'image') {
                    // Screenshots can show licensed art, and are not copied into the site: link to the repo instead.
                    const r = resolveHref(t.attrGet('src') || '', state.env);
                    const h = new state.Token('html_inline', '', 0);
                    h.content = `<a class="img-note" href="${esc(r.href)}" target="_blank" rel="noopener">Image: ${esc(t.content || 'screenshot')} (view on GitHub)</a>`;
                    kids.push(h);
                    continue;
                }
                kids.push(t);
            }
            blk.children = kids;
        }
    });
}

/* ---------- Markdown engine ---------- */
function makeMd() {
    const md = new MarkdownIt({
        html: true,
        linkify: false, // linkify has quadratic paths on large inputs, and the docs link what they mean to
        typographer: false,
        highlight(str, lang) {
            if (lang === 'mermaid') return `<pre class="mermaid">${esc(str)}</pre>`;
            let body;
            try { body = lang && hljs.getLanguage(lang) ? hljs.highlight(str, { language: lang, ignoreIllegals: true }).value : esc(str); }
            catch { body = esc(str); }
            return `<pre class="hl"><code${lang ? ` class="language-${esc(lang)}"` : ''}>${body}</code></pre>`;
        }
    });
    md.use(anchor, { level: [1, 2, 3, 4], slugify: ghSlug, permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'after', ariaHidden: true }) });
    md.use(texmath, { engine: katex, delimiters: 'dollars', katexOptions: { throwOnError: false, output: 'html' } });
    linkRewrite(md);
    // Wide tables scroll instead of stretching the page.
    const defTableOpen = md.renderer.rules.table_open;
    md.renderer.rules.table_open = (t, i, o, e, s) => '<div class="table-wrap">' + (defTableOpen ? defTableOpen(t, i, o, e, s) : s.renderToken(t, i, o));
    md.renderer.rules.table_close = () => '</table></div>';
    return md;
}

const plain = (s) => s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_>#|]/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- Page chrome ---------- */
const NAV = (active) => `
        <nav class="nav" aria-label="Primary">
            <a href="../index.html" class="nav-item">Home</a>
            <a href="../pitch.html" class="nav-item">The tour</a>
            <a href="../architecture.html" class="nav-item">Architecture</a>
            <a href="index.html" class="nav-item${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>Docs</a>
            <a href="roadmap.html" class="nav-item">Roadmap</a>
        </nav>`;

const HEAD = (title, desc, { math, mermaid }) => `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${esc(title)} | Nexus Docs</title>
    <meta name="description" content="${esc(desc)}">
    <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23fbcfe8' stroke-width='2' stroke-linejoin='round'%3E%3Cpath d='M12 2l8.5 5v10L12 22l-8.5-5V7z'/%3E%3Ccircle cx='12' cy='12' r='2.5' fill='%23fbcfe8'/%3E%3C/svg%3E">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wdth,wght@12..96,75..100,200..800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;700&family=Galada&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="../assets/nexus.css">
    <link rel="stylesheet" href="../assets/docs.css">${math ? `
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.css" integrity="sha384-nH0MfJ44wi1dd7w6jinlyBgljjS8EJAh2JBoRad8a3VDw2K69vfaaqm4WnR+gXtA" crossorigin="anonymous">` : ''}
</head>`;

const FOOT = (mermaid) => `
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" integrity="sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu" crossorigin="anonymous"></script>
    <script src="../assets/docs-world.js"></script>${mermaid ? `
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js" integrity="sha384-WmdflGW9aGfoBdHc4rRyWzYuAjEmDwMdGdiPNacbwfGKxBW/SO6guzuQ76qjnSlr" crossorigin="anonymous"></script>` : ''}
    <script src="../assets/docs.js"></script>
</body>
</html>
`;

const HEADER = (active) => `
    <header class="header">
        <a class="logo" href="../index.html">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2L20.5 7V17L12 22L3.5 17V7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /><circle cx="12" cy="12" r="2.5" fill="currentColor" /></svg>
            <span>Nexus</span>
        </a>${NAV(active)}
        <a class="gh-btn" href="${GH}" target="_blank" rel="noopener">View on GitHub</a>
    </header>`;

const SEARCH = `
        <div class="search" role="search">
            <input id="q" type="search" placeholder="Search the docs   ( / )" aria-label="Search the docs" autocomplete="off" spellcheck="false">
            <ul id="results" class="results" role="listbox" hidden></ul>
        </div>`;

function sidebar(currentSlug) {
    return `<nav class="sidebar panel" aria-label="Docs">${cfg.groups.map((g) => `
        <div class="side-group"><div class="side-title">${esc(g.title)}</div><ul>${g.pages.map((p) => {
            const pg = pages.find((x) => x.slug === p.slug);
            return `<li><a href="${p.slug}.html"${p.slug === currentSlug ? ' class="current" aria-current="page"' : ''}>${esc(pg.title)}</a></li>`;
        }).join('')}</ul></div>`).join('')}
    </nav>`;
}

/* ---------- Build ---------- */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const md = makeMd();
const searchIndex = [];

// Pass 1: parse every page for its title and headings (the sidebar needs all titles).
for (const p of pages) {
    let src = readFileSync(join(ROOT, p.repoPath), 'utf8').replace(/^\uFEFF/, '');
    if (/^(<<<<<<<|=======|>>>>>>>)/m.test(src)) warnings.push(`${p.repoPath}: contains merge-conflict markers`);
    p.env = { file: p.repoPath };
    p.tokens = md.parse(src, p.env);
    const h1 = p.tokens.findIndex((t) => t.type === 'heading_open' && t.tag === 'h1');
    p.title = p.title || (h1 >= 0 ? plain(p.tokens[h1 + 1].content).replace(/^\d+\.\s*/, '') : p.slug);
    p.toc = [];
    for (let i = 0; i < p.tokens.length; i++) {
        const t = p.tokens[i];
        if (t.type === 'heading_open' && (t.tag === 'h2' || t.tag === 'h3')) p.toc.push({ level: +t.tag[1], id: t.attrGet('id'), text: plain(p.tokens[i + 1].content) });
    }
    const firstPara = p.tokens.findIndex((t, i) => t.type === 'paragraph_open' && p.tokens[i + 1] && p.tokens[i + 1].content && !/^\[?←/.test(p.tokens[i + 1].content));
    p.desc = firstPara >= 0 ? plain(p.tokens[firstPara + 1].content).slice(0, 200) : p.title;
    p.hasMath = p.tokens.some((t) => t.type === 'inline' && /\$[^$\n]+\$/.test(t.content)) || p.tokens.some((t) => t.type === 'math_block');
    p.hasMermaid = p.tokens.some((t) => t.type === 'fence' && t.info.trim() === 'mermaid');
}

// Pass 2: render and write.
pages.forEach((p, i) => {
    const html = md.renderer.render(p.tokens, md.options, p.env);
    // The page's own H1 is shown in the hero; everything else is the article.
    const prev = pages[i - 1], next = pages[i + 1];
    const toc = p.toc.length ? `<aside class="toc panel" aria-label="On this page"><div class="side-title">On this page</div><ul>${p.toc.map((h) => `<li class="l${h.level}"><a href="#${h.id}">${esc(h.text)}</a></li>`).join('')}</ul></aside>` : '';
    const body = `${HEAD(p.title, p.desc, { math: p.hasMath })}
<body class="docs-page">
    <div id="world" aria-hidden="true"></div>
    ${HEADER(true)}
    <div class="docs-shell">
        ${sidebar(p.slug)}
        <main class="doc">
            <div class="crumbs"><a href="index.html">Docs</a><span>/</span><a href="index.html#${p.group.id}">${esc(p.group.title)}</a></div>
            ${SEARCH}
            <article class="panel prose">
                ${html}
                <footer class="doc-foot">
                    <a class="edit" href="${GH}/edit/${cfg.branch}/${p.repoPath}" target="_blank" rel="noopener">Edit this page on GitHub</a>
                    <div class="pn">${prev ? `<a href="${prev.slug}.html"><small>Previous</small>${esc(prev.title)}</a>` : '<span></span>'}${next ? `<a class="r" href="${next.slug}.html"><small>Next</small>${esc(next.title)}</a>` : ''}</div>
                </footer>
            </article>
        </main>
        ${toc}
    </div>${FOOT(p.hasMermaid)}`;
    writeFileSync(join(OUT, p.slug + '.html'), body);

    // Search index: one entry per section.
    let cur = { h: p.title, id: '', x: [] };
    const flush = () => { if (cur.x.length) searchIndex.push({ t: p.title, h: cur.h, u: p.slug + '.html' + (cur.id ? '#' + cur.id : ''), x: cur.x.join(' ').slice(0, 420), g: p.group.title }); };
    for (let k = 0; k < p.tokens.length; k++) {
        const t = p.tokens[k];
        if (t.type === 'heading_open' && /^h[1-4]$/.test(t.tag)) { flush(); cur = { h: plain(p.tokens[k + 1].content), id: t.attrGet('id'), x: [] }; }
        else if (t.type === 'inline' && p.tokens[k - 1] && p.tokens[k - 1].type !== 'heading_open') cur.x.push(plain(t.content));
    }
    flush();
});

// Landing page.
const landing = `${HEAD('Documentation', 'The Nexus engine documentation: guides, the technical wiki, protocol, editor and status.', {})}
<body class="docs-page docs-home">
    <div id="world" aria-hidden="true"></div>
    ${HEADER(true)}
    <main class="home">
        <section class="home-hero">
            <span class="eyebrow">Nexus documentation</span>
            <h1 class="display">Everything it <em>takes.</em></h1>
            <p class="lead">From a fresh clone to a running world, and the reasoning behind every layer of it.</p>
            ${SEARCH}
            <div class="home-cta">
                <a class="primary-btn" href="getting-started.html">Get started <span class="plus-icon">+</span></a>
                <a class="ghost-link" href="../architecture.html">Explore the architecture in 3D</a>
            </div>
        </section>
        <section class="cards">${cfg.groups.map((g) => `
            <div class="card panel" id="${g.id}">
                <h2>${esc(g.title)}</h2>
                <p>${esc(g.blurb)}</p>
                <ul>${g.pages.map((p) => `<li><a href="${p.slug}.html">${esc(pages.find((x) => x.slug === p.slug).title)}</a></li>`).join('')}</ul>
            </div>`).join('')}
        </section>
    </main>${FOOT(false)}`;
writeFileSync(join(OUT, 'index.html'), landing);
writeFileSync(join(OUT, 'search-index.json'), JSON.stringify(searchIndex));

console.log(`docs: ${pages.length} pages + index -> ${OUT}`);
console.log(`search index: ${searchIndex.length} sections, ${(JSON.stringify(searchIndex).length / 1024).toFixed(0)} KB`);
if (warnings.length) {
    const uniq = [...new Set(warnings)];
    console.log(`\n${uniq.length} link warning(s):`);
    uniq.slice(0, 40).forEach((w) => console.log('  - ' + w));
    if (uniq.length > 40) console.log(`  ... and ${uniq.length - 40} more`);
}
