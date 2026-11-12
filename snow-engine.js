// SnowyTavern — snow-engine.js
// Canvas-based falling snow with an interactive accumulation layer:
// - Snowflakes fall from the top and settle at the bottom edge (and on top of a snowman).
// - Dragging the mouse through settled snow scatters it (and nudges a tiny trail).
// - Clicking and holding on settled snow rolls it into a growing snowball.
// - Dropping a big-enough snowball near another one stacks them into a snowman.
//
// No external deps. Exposes a single global-ish object via the returned API
// so index.js can create/destroy it cleanly when the extension is toggled.

export function createSnowEngine(options = {}) {
    const state = {
        running: false,
        intensity: options.intensity ?? 0.5, // 0..1, controls flake spawn rate & accumulation speed
        canvas: null,
        ctx: null,
        width: 0,
        height: 0,
        dpr: Math.min(window.devicePixelRatio || 1, 2),
        flakes: [],
        heightMap: null, // Uint16Array-ish array: accumulated snow height per x-column (bottom layer)
        columnCount: 0,
        colWidth: 6,
        lastTime: 0,
        rafId: null,
        mouse: { x: -9999, y: -9999, down: false, lastX: -9999, lastY: -9999 },
        ball: null, // currently-being-rolled snowball {x,y,r,vx,vy,rolling}
        snowmen: [],
        maxFlakes: 260,
        resizeObserver: null,
    };

    function spawnRateForIntensity() {
        // intensity 0..1 -> flakes added per second roughly 8..90
        return 8 + state.intensity * 82;
    }

    function maxFlakesForIntensity() {
        return Math.round(90 + state.intensity * 420);
    }

    function setup() {
        const canvas = document.createElement('canvas');
        canvas.id = 'snowytavern-canvas';
        Object.assign(canvas.style, {
            position: 'fixed',
            inset: '0',
            width: '100vw',
            height: '100vh',
            zIndex: '9999',
            pointerEvents: 'none', // canvas never intercepts clicks itself; see pointer handlers below
        });
        document.body.appendChild(canvas);
        state.canvas = canvas;
        state.ctx = canvas.getContext('2d');

        resize();
        window.addEventListener('resize', resize);

        // The canvas stays pointer-events:none by default so it never blocks clicks
        // on the UI underneath. We listen on `window` (capture phase) instead, and
        // only ever call preventDefault()/stopPropagation() when the pointer is
        // actually over settled snow or a snowball — everywhere else the event
        // passes through untouched to the real UI.
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('pointermove', onPointerMove, true);
        window.addEventListener('pointerup', onPointerUp, true);

        state.maxFlakes = maxFlakesForIntensity();
    }

    function resize() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        state.width = w;
        state.height = h;
        state.canvas.width = Math.round(w * state.dpr);
        state.canvas.height = Math.round(h * state.dpr);
        state.ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

        state.colWidth = 6;
        const newColumnCount = Math.ceil(w / state.colWidth) + 1;
        const newMap = new Float32Array(newColumnCount);
        if (state.heightMap) {
            // preserve relative snow depth on resize
            const scale = newColumnCount / Math.max(1, state.columnCount);
            for (let i = 0; i < newColumnCount; i++) {
                const srcIndex = Math.min(state.columnCount - 1, Math.floor(i / scale));
                newMap[i] = state.heightMap[srcIndex] || 0;
            }
        }
        state.heightMap = newMap;
        state.columnCount = newColumnCount;
    }

    function colIndexAt(x) {
        return Math.max(0, Math.min(state.columnCount - 1, Math.floor(x / state.colWidth)));
    }

    function groundYAt(x) {
        const idx = colIndexAt(x);
        return state.height - (state.heightMap[idx] || 0);
    }

    function spawnFlake() {
        const r = 1.2 + Math.random() * 2.6;
        state.flakes.push({
            x: Math.random() * state.width,
            y: -10,
            r,
            vy: 18 + Math.random() * 28 + r * 6,
            vx: (Math.random() - 0.5) * 18,
            sway: Math.random() * Math.PI * 2,
            swaySpeed: 0.6 + Math.random() * 1.2,
            opacity: 0.55 + Math.random() * 0.45,
            settled: false,
        });
    }

    let spawnAccumulator = 0;

    function update(dt) {
        // spawn
        spawnAccumulator += spawnRateForIntensity() * dt;
        while (spawnAccumulator >= 1 && state.flakes.length < state.maxFlakes) {
            spawnFlake();
            spawnAccumulator -= 1;
        }

        for (let i = state.flakes.length - 1; i >= 0; i--) {
            const f = state.flakes[i];
            if (f.settled) continue;
            f.sway += f.swaySpeed * dt;
            f.x += (f.vx + Math.sin(f.sway) * 14) * dt;
            f.y += f.vy * dt;

            if (f.x < -10) f.x = state.width + 10;
            if (f.x > state.width + 10) f.x = -10;

            // check collision with snowmen (approximate circle stacks)
            let landedOnSnowman = false;
            for (const sm of state.snowmen) {
                const dx = f.x - sm.x;
                const topY = sm.topY;
                if (Math.abs(dx) < sm.topR * 1.1 && f.y + f.r >= topY && f.y < topY + 14) {
                    landedOnSnowman = true;
                    break;
                }
            }

            const groundY = groundYAt(f.x);
            if (landedOnSnowman || f.y + f.r >= groundY) {
                // settle into the height map, spread a tiny bit to neighboring columns
                const addAmount = (0.6 + state.intensity * 0.9) * (landedOnSnowman ? 0.15 : 1);
                const idx = colIndexAt(f.x);
                depositSnow(idx, addAmount);
                state.flakes.splice(i, 1);
            }
        }

        // gentle relaxation of the height map so piles don't look too jagged (very subtle)
        relaxHeightMap(dt);

        // rolling snowball physics
        if (state.ball && state.ball.rolling) {
            const b = state.ball;
            const groundY = groundYAt(b.x);
            // gravity toward ground while dragging is handled in pointermove;
            // here we just make sure it doesn't float above ground at rest
            if (!state.mouse.down) {
                b.y = Math.min(b.y, groundY - b.r);
            }
        }
    }

    function depositSnow(idx, amount) {
        state.heightMap[idx] = Math.min(140, (state.heightMap[idx] || 0) + amount);
        const spread = amount * 0.25;
        if (idx > 0) state.heightMap[idx - 1] = Math.min(140, (state.heightMap[idx - 1] || 0) + spread);
        if (idx < state.columnCount - 1) state.heightMap[idx + 1] = Math.min(140, (state.heightMap[idx + 1] || 0) + spread);
    }

    function removeSnowAround(x, radius, amount) {
        const idx = colIndexAt(x);
        const span = Math.ceil(radius / state.colWidth);
        for (let i = -span; i <= span; i++) {
            const j = idx + i;
            if (j < 0 || j >= state.columnCount) continue;
            const falloff = 1 - Math.abs(i) / (span + 1);
            state.heightMap[j] = Math.max(0, state.heightMap[j] - amount * falloff);
        }
    }

    function relaxHeightMap(dt) {
        // tiny smoothing pass, cheap and infrequent
        if (Math.random() > 0.3) return;
        for (let i = 1; i < state.columnCount - 1; i++) {
            const left = state.heightMap[i - 1];
            const right = state.heightMap[i + 1];
            const mine = state.heightMap[i];
            const avg = (left + right + mine * 2) / 4;
            state.heightMap[i] = mine + (avg - mine) * 0.04;
        }
    }

    function draw() {
        const ctx = state.ctx;
        ctx.clearRect(0, 0, state.width, state.height);

        // falling flakes
        ctx.save();
        for (const f of state.flakes) {
            ctx.globalAlpha = f.opacity;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // accumulated snow silhouette along the bottom
        ctx.save();
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.beginPath();
        ctx.moveTo(0, state.height);
        for (let i = 0; i < state.columnCount; i++) {
            const x = i * state.colWidth;
            const y = state.height - (state.heightMap[i] || 0);
            ctx.lineTo(x, y);
        }
        ctx.lineTo(state.width, state.height);
        ctx.closePath();
        ctx.fill();

        // soft shading on top edge of the snow line
        ctx.strokeStyle = 'rgba(200,220,255,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let i = 0; i < state.columnCount; i++) {
            const x = i * state.colWidth;
            const y = state.height - (state.heightMap[i] || 0);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();

        // snowmen
        for (const sm of state.snowmen) {
            drawSnowman(ctx, sm);
        }

        // rolling / held snowball
        if (state.ball) {
            drawBall(ctx, state.ball);
        }
    }

    function drawBall(ctx, b) {
        ctx.save();
        const grad = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, b.r * 0.1, b.x, b.y, b.r);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(1, '#dce6f2');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(160,180,210,0.5)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
    }

    function drawSnowman(ctx, sm) {
        ctx.save();
        const { x, baseY, baseR } = sm;
        const midR = baseR * 0.72;
        const headR = baseR * 0.5;
        const baseCY = baseY - baseR;
        const midCY = baseCY - baseR - midR * 0.85;
        const headCY = midCY - midR - headR * 0.85;
        sm.topY = headCY - headR;
        sm.topR = headR;

        [[baseCY, baseR], [midCY, midR], [headCY, headR]].forEach(([cy, r]) => {
            const grad = ctx.createRadialGradient(x - r * 0.3, cy - r * 0.3, r * 0.1, x, cy, r);
            grad.addColorStop(0, '#ffffff');
            grad.addColorStop(1, '#e3ecf7');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(x, cy, r, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = 'rgba(160,180,210,0.45)';
            ctx.stroke();
        });

        // face
        ctx.fillStyle = '#2b2b2b';
        ctx.beginPath();
        ctx.arc(x - headR * 0.3, headCY - headR * 0.1, headR * 0.09, 0, Math.PI * 2);
        ctx.arc(x + headR * 0.3, headCY - headR * 0.1, headR * 0.09, 0, Math.PI * 2);
        ctx.fill();

        // carrot nose
        ctx.fillStyle = '#ff8c3b';
        ctx.beginPath();
        ctx.moveTo(x, headCY);
        ctx.lineTo(x + headR * 0.9, headCY + headR * 0.08);
        ctx.lineTo(x, headCY + headR * 0.22);
        ctx.closePath();
        ctx.fill();

        // buttons
        ctx.fillStyle = '#2b2b2b';
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.arc(x, midCY - midR * 0.4 + i * midR * 0.4, midR * 0.07, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    function findNearestSnowman(x, y, maxDist) {
        let best = null;
        let bestDist = maxDist;
        for (const sm of state.snowmen) {
            const d = Math.hypot(x - sm.x, y - sm.baseY - sm.baseR * 1.4);
            if (d < bestDist) {
                best = sm;
                bestDist = d;
            }
        }
        return best;
    }

    // --- interaction ---

    function hitTest(x, y) {
        // Returns true only when (x, y) is actually over something interactive:
        // an existing ball, a snowman's body, or a settled snow pile deep enough
        // to grab. Used to decide whether we intercept the event at all.
        if (state.ball && Math.hypot(x - state.ball.x, y - state.ball.y) < state.ball.r + 10) {
            return true;
        }
        for (const sm of state.snowmen) {
            if (Math.hypot(x - sm.x, y - (sm.baseY - sm.baseR)) < sm.baseR * 2.2) {
                return true;
            }
        }
        const groundY = groundYAt(x);
        if (y >= groundY - 30 && y <= state.height && (state.heightMap[colIndexAt(x)] || 0) > 4) {
            return true;
        }
        return false;
    }

    function onPointerDown(e) {
        const x = e.clientX;
        const y = e.clientY;

        if (!hitTest(x, y)) {
            // Nothing interactive here — let the event through to the real UI untouched.
            state.mouse.down = false;
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const groundY = groundYAt(x);

        // if clicking an existing small ball, pick it up; otherwise start rolling a new one
        if (state.ball && Math.hypot(x - state.ball.x, y - state.ball.y) < state.ball.r + 10) {
            state.ball.rolling = true;
        } else if (y >= groundY - 30 && (state.heightMap[colIndexAt(x)] || 0) > 4) {
            // start a fresh snowball near the snow line
            state.ball = { x, y: groundY - 10, r: 9, rolling: true };
            removeSnowAround(x, 20, 6);
        }

        state.mouse.down = true;
        state.mouse.lastX = x;
        state.mouse.lastY = y;
    }

    function onPointerMove(e) {
        const x = e.clientX;
        const y = e.clientY;
        state.mouse.x = x;
        state.mouse.y = y;

        // Only intercept move events while an interaction we already started
        // (mouse down over snow/a ball) is in progress. Otherwise let the
        // event pass through untouched — this is what lets normal hover/drag
        // on the real UI keep working everywhere else on the page.
        if (!state.mouse.down) {
            state.mouse.lastX = x;
            state.mouse.lastY = y;
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const dx = x - state.mouse.lastX;
        const dy = y - state.mouse.lastY;
        const dist = Math.hypot(dx, dy);

        if (state.mouse.down && state.ball && state.ball.rolling) {
            // dragging a ball: move it, grow it if dragging across snow, else just slide
            const groundY = groundYAt(x);
            const nearGround = Math.abs(y - (groundY - state.ball.r)) < 40;

            state.ball.x = x;
            state.ball.y = nearGround ? groundY - state.ball.r : y;

            if (dist > 0.5) {
                const col = state.heightMap[colIndexAt(x)] || 0;
                if (nearGround && col > 2) {
                    const grow = Math.min(0.8, dist * 0.02);
                    state.ball.r = Math.min(70, state.ball.r + grow);
                    removeSnowAround(x, state.ball.r * 0.6, grow * 1.5);
                }
            }

            // snap/merge into a nearby snowman if big enough and close to its top
            const sm = findNearestSnowman(x, y, 60);
            if (sm && state.ball.r > 8) {
                tryStackOntoSnowman(sm);
            }
        } else if (state.mouse.down && dist > 1) {
            // plain drag over snow with no ball picked up: scatter it (brushing effect)
            const groundY = groundYAt(x);
            if (y > groundY - 50 && y < state.height + 50) {
                removeSnowAround(x, 26, Math.min(2.2, dist * 0.08));
                spawnScatterPuff(x, groundY, Math.min(6, Math.floor(dist / 4)));
            }
        }

        state.mouse.lastX = x;
        state.mouse.lastY = y;
    }

    function spawnScatterPuff(x, y, count) {
        for (let i = 0; i < count; i++) {
            if (state.flakes.length >= state.maxFlakes + 40) break;
            state.flakes.push({
                x: x + (Math.random() - 0.5) * 20,
                y: y - Math.random() * 10,
                r: 1 + Math.random() * 1.6,
                vy: -40 - Math.random() * 40, // pop upward briefly, gravity via vy increasing handled loosely
                vx: (Math.random() - 0.5) * 60,
                sway: Math.random() * Math.PI * 2,
                swaySpeed: 1 + Math.random(),
                opacity: 0.8,
                settled: false,
                isPuff: true,
            });
        }
    }

    function tryStackOntoSnowman(sm) {
        const b = state.ball;
        // require the ball be dropped (mouse up) to actually commit; while dragging just show it hovering near
        if (!state.mouse.down) {
            commitBallToSnowman(sm, b);
        }
    }

    function commitBallToSnowman(sm, b) {
        if (sm.parts.length >= 3) return;
        sm.parts.push(b.r);
        sm.parts.sort((a, c) => c - a);
        const [base, mid, head] = sm.parts;
        sm.baseR = base || sm.baseR;
        if (mid) sm.midR = mid;
        if (head) sm.headR = head;
        state.ball = null;
    }

    function onPointerUp(e) {
        const wasInteracting = state.mouse.down;
        state.mouse.down = false;

        if (!wasInteracting) {
            // We never claimed the corresponding pointerdown, so don't
            // swallow this event either — let the UI handle it normally.
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const x = e.clientX;
        const y = e.clientY;

        if (state.ball && state.ball.rolling) {
            const sm = findNearestSnowman(x, y, 70);
            if (sm) {
                commitBallToSnowman(sm, state.ball);
            } else if (state.ball.r > 18) {
                // drop it as the start of a brand-new snowman if it's reasonably big
                const groundY = groundYAt(x);
                state.snowmen.push({
                    x,
                    baseY: groundY,
                    baseR: state.ball.r,
                    parts: [state.ball.r],
                });
                removeSnowAround(x, state.ball.r * 1.3, 10);
                state.ball = null;
            } else {
                // too small to stand alone — settle it back into the snow pile
                removeSnowAroundDeposit(x, state.ball.r);
                state.ball = null;
            }
        }
    }

    function removeSnowAroundDeposit(x, r) {
        const idx = colIndexAt(x);
        depositSnow(idx, r * 0.5);
    }

    function loop(time) {
        if (!state.running) return;
        if (!state.lastTime) state.lastTime = time;
        const dt = Math.min(0.05, (time - state.lastTime) / 1000);
        state.lastTime = time;

        update(dt);
        draw();

        state.rafId = requestAnimationFrame(loop);
    }

    // --- public API ---

    function start() {
        if (state.running) return;
        setup();
        state.running = true;
        state.rafId = requestAnimationFrame(loop);
    }

    function stop() {
        state.running = false;
        if (state.rafId) cancelAnimationFrame(state.rafId);
        window.removeEventListener('resize', resize);
        window.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('pointermove', onPointerMove, true);
        window.removeEventListener('pointerup', onPointerUp, true);
        if (state.canvas) {
            state.canvas.remove();
        }
        state.canvas = null;
        state.ctx = null;
        state.flakes = [];
        state.snowmen = [];
        state.ball = null;
        state.heightMap = null;
    }

    function setIntensity(value) {
        state.intensity = Math.max(0, Math.min(1, value));
        state.maxFlakes = maxFlakesForIntensity();
    }

    function clearSnow() {
        if (state.heightMap) state.heightMap.fill(0);
        state.snowmen = [];
        state.ball = null;
        state.flakes = [];
    }

    return { start, stop, setIntensity, clearSnow };
}
