/* Docs page behaviour: theme toggle, search, contents tracking, copy buttons, Mermaid. */
(function () {
    const $ = (s, r = document) => r.querySelector(s);
    const $$ = (s, r = document) => [...r.querySelectorAll(s)];
    const store = {
        get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode: fine */ } }
    };

    /* ---------- Theme ---------- */
    const body = document.body;
    if (store.get('nexus-theme') === 'blue') body.classList.add('blue-theme');
    const header = $('.header');
    if (header) {
        const gh = $('.gh-btn', header);
        const right = document.createElement('div');
        right.className = 'right';
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'theme-btn'; btn.textContent = '◐';
        btn.setAttribute('aria-label', 'Switch between the green and blue theme');
        btn.addEventListener('click', () => {
            const blue = body.classList.toggle('blue-theme');
            store.set('nexus-theme', blue ? 'blue' : 'classic');
        });
        gh.replaceWith(right);
        right.append(btn, gh);
    }

    /* ---------- Search ---------- */
    const input = $('#q'), list = $('#results');
    let index = null, loading = null, sel = -1;
    const rx = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    function load() {
        if (index) return Promise.resolve(index);
        if (!loading) loading = fetch('search-index.json').then((r) => r.json()).then((d) => (index = d)).catch(() => (index = []));
        return loading;
    }

    // Text with the search terms wrapped in <mark>, built from nodes (no HTML strings).
    function highlight(text, terms) {
        const frag = document.createDocumentFragment();
        const re = new RegExp('(' + terms.map(rx).join('|') + ')', 'ig');
        let last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) frag.append(text.slice(last, m.index));
            const mk = document.createElement('mark');
            mk.textContent = m[0];
            frag.append(mk);
            last = m.index + m[0].length;
            if (m[0].length === 0) re.lastIndex++;
        }
        if (last < text.length) frag.append(text.slice(last));
        return frag;
    }

    function el(tag, cls, ...kids) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        kids.forEach((k) => n.append(k));
        return n;
    }

    function run(q) {
        const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
        if (!terms.length) { list.hidden = true; return; }
        const out = [];
        for (const e of index) {
            const t = e.t.toLowerCase(), h = e.h.toLowerCase(), x = e.x.toLowerCase();
            let score = 0, ok = true;
            for (const w of terms) {
                const inT = t.includes(w), inH = h.includes(w), inX = x.includes(w);
                if (!inT && !inH && !inX) { ok = false; break; }
                score += (inT ? 4 : 0) + (inH ? 6 : 0) + (inX ? 1 : 0) + (h.startsWith(w) ? 3 : 0);
            }
            if (ok) out.push({ e, score });
        }
        out.sort((a, b) => b.score - a.score);
        list.replaceChildren();
        const top = out.slice(0, 8);
        if (!top.length) {
            list.append(el('li', 'none', 'Nothing found. Try fewer or different words.'));
        } else {
            top.forEach((r, i) => {
                const e = r.e;
                const at = Math.max(0, e.x.toLowerCase().indexOf(terms[0]));
                const from = Math.max(0, at - 40);
                const a = el('a', null,
                    el('div', 'r-top', el('span', 'r-title', highlight(e.h === e.t ? e.t : e.t + ' › ' + e.h, terms)), el('span', 'r-group', e.g)),
                    el('div', 'r-snip', highlight(e.x.slice(from, from + 150), terms), '…'));
                a.setAttribute('href', e.u);
                const li = el('li', null, a);
                li.setAttribute('role', 'option');
                li.dataset.i = String(i);
                list.append(li);
            });
        }
        list.hidden = false; sel = -1;
    }

    if (input) {
        input.addEventListener('focus', load);
        input.addEventListener('input', () => load().then(() => run(input.value)));
        input.addEventListener('keydown', (e) => {
            const items = $$('li[role=option]', list);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (!items.length) return;
                sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                items.forEach((li, i) => li.classList.toggle('sel', i === sel));
                items[sel].scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                const li = items[sel] || items[0];
                if (li) location.href = $('a', li).getAttribute('href');
            } else if (e.key === 'Escape') { list.hidden = true; input.blur(); }
        });
        document.addEventListener('click', (e) => { if (!e.target.closest('.search')) list.hidden = true; });
        addEventListener('keydown', (e) => {
            if (e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); }
        });
    }

    /* ---------- Contents list follows the scroll ---------- */
    const tocLinks = $$('.toc a');
    if (tocLinks.length && 'IntersectionObserver' in window) {
        const byId = new Map(tocLinks.map((a) => [a.getAttribute('href').slice(1), a]));
        const heads = [...byId.keys()].map((id) => document.getElementById(id)).filter(Boolean);
        const obs = new IntersectionObserver((entries) => {
            entries.forEach((en) => {
                if (!en.isIntersecting) return;
                tocLinks.forEach((a) => a.classList.remove('active'));
                const a = byId.get(en.target.id);
                if (a) { a.classList.add('active'); a.scrollIntoView({ block: 'nearest' }); }
            });
        }, { rootMargin: '-15% 0px -75% 0px' });
        heads.forEach((h) => obs.observe(h));
    }
    const cur = $('.sidebar a.current');
    if (cur) cur.scrollIntoView({ block: 'center' });

    /* ---------- Copy buttons on code ---------- */
    $$('.prose pre.hl').forEach((pre) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'copy-btn'; b.textContent = 'Copy';
        b.addEventListener('click', () => {
            const code = pre.querySelector('code').innerText;
            const done = () => { b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); };
            if (navigator.clipboard) navigator.clipboard.writeText(code).then(done).catch(() => (b.textContent = 'Press Ctrl+C'));
            else b.textContent = 'Press Ctrl+C';
        });
        pre.appendChild(b);
    });

    /* ---------- Mermaid ---------- */
    if (window.mermaid) {
        try {
            mermaid.initialize({
                startOnLoad: false, securityLevel: 'strict', theme: 'dark', fontFamily: 'Inter, sans-serif',
                themeVariables: { primaryColor: '#0b4f6a', primaryTextColor: '#ffffff', primaryBorderColor: '#fbcfe8', lineColor: '#fbcfe8', secondaryColor: '#0b3f78', tertiaryColor: '#04294e', background: 'transparent' }
            });
            mermaid.run({ nodes: $$('pre.mermaid') }).catch((e) => console.warn('mermaid:', e));
        } catch (e) { console.warn('mermaid failed', e); }
    }
})();
