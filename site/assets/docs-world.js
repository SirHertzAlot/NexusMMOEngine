/*
 * Docs backdrop: a procedural landscape under the page, with the docs floating above it.
 *
 * It follows the game client's pattern (apps/client/src/render/world-canvas.tsx): a canvas
 * under the UI, a flat-shaded terrain, a frame-rate governor that lowers the resolution when
 * frames drop and raises it again when there is headroom. The client uses React Three Fiber
 * and its own TerrainRenderer; this page has no bundler, so it is plain three.js with the
 * terrain computed in the vertex shader (so it can scroll endlessly at no CPU cost).
 *
 * Reading the page scroll moves the camera down the valley. The far distance fades to
 * transparent, so the terrain melts into the page's own gradient instead of a hard horizon.
 * With prefers-reduced-motion it draws still frames only; without WebGL the gradient remains.
 */
(function () {
    const host = document.getElementById('world');
    if (!host || !window.THREE) return;
    const T = THREE;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let renderer;
    try {
        renderer = new T.WebGLRenderer({ antialias: false, alpha: true, powerPreference: 'low-power' });
    } catch (e) { return; }
    renderer.setClearColor(0x000000, 0);
    host.appendChild(renderer.domElement);

    const MAX_PR = Math.min(window.devicePixelRatio || 1, 1.5);
    let pr = MAX_PR;
    renderer.setPixelRatio(pr);

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(55, 1, 0.5, 420);

    /* ---------- Terrain (GPU) ---------- */
    const NOISE = `
        float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float vnoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        float fbm(vec2 p) {
            float a = 0.5, s = 0.0;
            for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
            return s;
        }
        float terrainHeight(vec2 w, float travel) {
            vec2 p = vec2(w.x, w.y - travel) * 0.05;
            float h = pow(fbm(p), 1.7) * 19.0;
            float valley = smoothstep(5.0, 36.0, abs(w.x));   // a low corridor down the middle, ridges either side
            return h * mix(0.1, 1.0, valley);
        }`;

    const uniforms = {
        uTravel: { value: 0 },
        uLow: { value: new T.Color('#0b6f64') },
        uMid: { value: new T.Color('#12a58f') },
        uHigh: { value: new T.Color('#6fd6c4') },
        uAccent: { value: new T.Color('#fbcfe8') },
        uWire: { value: 0 }
    };

    function terrainMaterial(wire) {
        return new T.ShaderMaterial({
            uniforms: Object.assign({}, uniforms, { uWire: { value: wire ? 1 : 0 } }),
            transparent: true,
            depthWrite: !wire,
            wireframe: !!wire,
            extensions: { derivatives: true },
            vertexShader: `
                uniform float uTravel;
                varying vec3 vWorld; varying float vH; varying float vDist;
                ${NOISE}
                void main() {
                    vec3 pos = position;
                    pos.y = terrainHeight(pos.xz, uTravel) + (uTravel * 0.0);
                    vWorld = pos; vH = pos.y;
                    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
                    vDist = -mv.z;
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                uniform vec3 uLow, uMid, uHigh, uAccent; uniform float uWire;
                varying vec3 vWorld; varying float vH; varying float vDist;
                void main() {
                    float fog = smoothstep(55.0, 235.0, vDist);
                    if (uWire > 0.5) { gl_FragColor = vec4(uAccent, (1.0 - fog) * 0.16); return; }
                    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
                    if (n.y < 0.0) n = -n;
                    vec3 L = normalize(vec3(-0.45, 0.85, 0.4));
                    float diff = clamp(dot(n, L), 0.0, 1.0) * 0.72 + 0.28;
                    vec3 col = mix(uLow, uMid, smoothstep(0.0, 3.5, vH));
                    col = mix(col, uHigh, smoothstep(3.5, 11.0, vH));
                    col = mix(col, uAccent, smoothstep(11.0, 17.0, vH) * 0.8);
                    col *= diff;
                    col += uAccent * pow(1.0 - clamp(n.y, 0.0, 1.0), 2.0) * 0.16;
                    gl_FragColor = vec4(col, (1.0 - fog) * 0.94);
                }`
        });
    }

    const geo = new T.PlaneGeometry(260, 330, 150, 200);
    geo.rotateX(-Math.PI / 2);
    const solid = new T.Mesh(geo, terrainMaterial(false));
    const wire = new T.Mesh(geo, terrainMaterial(true));
    wire.position.y = 0.04;
    [solid, wire].forEach((m) => { m.position.z = -135; m.frustumCulled = false; scene.add(m); });

    /* ---------- Floating "regions": crystals that hover above the valley ---------- */
    const crystals = [];
    const crystalMat = new T.MeshBasicMaterial({ color: 0xfbcfe8, transparent: true, opacity: 0.18, depthWrite: false });
    for (let i = 0; i < 9; i++) {
        const g = new T.Group();
        const s = 1.1 + (i % 3) * 0.6;
        const body = new T.Mesh(new T.OctahedronGeometry(s, 0), crystalMat);
        const edges = new T.LineSegments(new T.EdgesGeometry(new T.OctahedronGeometry(s, 0)), new T.LineBasicMaterial({ color: 0xfbcfe8, transparent: true, opacity: 0.8 }));
        g.add(body, edges);
        g.position.set((i - 4) * 5.2 + ((i * 37) % 7) - 3, 8 + (i % 4) * 2.6, -14 - i * 15);
        g.userData = { base: g.position.clone(), phase: i * 1.7 };
        scene.add(g);
        crystals.push(g);
    }

    /* ---------- Theme ---------- */
    const THEMES = {
        classic: { low: '#0b6f64', mid: '#12a58f', high: '#6fd6c4' },
        blue: { low: '#0b3f78', mid: '#1f7ad0', high: '#8cc2ff' }
    };
    const target = { low: new T.Color(), mid: new T.Color(), high: new T.Color() };
    function readTheme() {
        const t = THEMES[document.body.classList.contains('blue-theme') ? 'blue' : 'classic'];
        target.low.set(t.low); target.mid.set(t.mid); target.high.set(t.high);
    }
    readTheme();
    new MutationObserver(() => { readTheme(); if (reduce) draw(0); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

    /* ---------- Input and sizing ---------- */
    const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
    addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth - 0.5; mouse.y = e.clientY / innerHeight - 0.5; }, { passive: true });

    function resize() {
        renderer.setSize(innerWidth, innerHeight, false);
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        if (reduce) draw(0);
    }
    addEventListener('resize', resize);
    resize();

    /* ---------- Frame loop with a frame-rate governor ---------- */
    let last = performance.now(), ema = 16, slow = 0, fast = 0, t0 = last;
    function scrollProgress() {
        const max = document.documentElement.scrollHeight - innerHeight;
        return max > 0 ? Math.min(1, scrollY / max) : 0;
    }

    function draw(time) {
        mouse.sx += (mouse.x - mouse.sx) * 0.05;
        mouse.sy += (mouse.y - mouse.sy) * 0.05;
        uniforms.uTravel.value = time * 0.9 + scrollProgress() * 160;
        solid.material.uniforms.uTravel.value = wire.material.uniforms.uTravel.value = uniforms.uTravel.value;

        // Colours ease toward the theme.
        ['low', 'mid', 'high'].forEach((k) => {
            const u = k === 'low' ? 'uLow' : k === 'mid' ? 'uMid' : 'uHigh';
            [solid, wire].forEach((m) => m.material.uniforms[u].value.lerp(target[k], 0.06));
        });

        camera.position.set(mouse.sx * 5, 11 - mouse.sy * 3 - scrollProgress() * 2, 26);
        camera.lookAt(mouse.sx * 3, 4.5 - mouse.sy * 2, -42);

        crystals.forEach((c) => {
            const d = c.userData;
            c.position.y = d.base.y + Math.sin(time * 0.6 + d.phase) * 0.9;
            c.rotation.y = time * 0.25 + d.phase;
            c.rotation.x = Math.sin(time * 0.3 + d.phase) * 0.3;
            // crystals drift toward the camera with the terrain, and wrap
            const z = ((d.base.z + uniforms.uTravel.value * 0.55) % 150) - 140;
            c.position.z = z;
        });
        renderer.render(scene, camera);
    }

    function frame(now) {
        const dt = now - last; last = now;
        ema += (dt - ema) * 0.08;
        // Governor: lower the resolution when frames drop, raise it again with headroom.
        if (ema > 30) { slow++; fast = 0; } else if (ema < 17) { fast++; slow = 0; } else { slow = fast = 0; }
        if (slow > 45 && pr > 0.5) { pr = Math.max(0.5, pr - 0.25); renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false); slow = 0; }
        if (fast > 300 && pr < MAX_PR) { pr = Math.min(MAX_PR, pr + 0.25); renderer.setPixelRatio(pr); renderer.setSize(innerWidth, innerHeight, false); fast = 0; }
        if (!document.hidden) draw((now - t0) / 1000);
        requestAnimationFrame(frame);
    }

    if (reduce) {
        draw(0);
        addEventListener('scroll', () => draw(0), { passive: true });
    } else {
        requestAnimationFrame(frame);
    }
})();
