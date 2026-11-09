// Ambsynth grid: public display mirroring every participant currently playing
// the waiting ambsynth (no pedal). One portrait cell per player, colored with
// their server-assigned background; touches are mirrored with the same
// circle + crosshair and 2s fade-out as on the phone.

const AMBGRID = {
    cellAspect: 9 / 16,      // width / height
    gapRatio: 0.015,         // gap as a fraction of the shorter window side
    fadeMs: 2000,            // matches ambsynth envelope release
    cornerRadiusRatio: 0.04
};

const ambgrid = {
    sessionName: new URLSearchParams(window.location.search).get('session') || '',
    socket: null,
    players: [],             // [{ socketID, initials, color, ink }]
    touches: new Map(),      // socketID -> { x, y, touching, releasedAt } (crosshair)
    ripples: new Map(),      // socketID -> [{ x, y, startedAt }] (short taps, overlap)
    layout: null,
    canvas: document.getElementById('ambgrid'),
    statusEl: document.getElementById('ambgrid-status')
};
ambgrid.ctx = ambgrid.canvas.getContext('2d');

// --- layout -------------------------------------------------------------------

// Picks the column count that yields the largest portrait cell for n players.
function computeLayout(n, width, height) {
    if (n <= 0) return null;
    const gap = Math.round(Math.min(width, height) * AMBGRID.gapRatio);
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const maxW = (width - gap * (cols + 1)) / cols;
        const maxH = (height - gap * (rows + 1)) / rows;
        const cellW = Math.min(maxW, maxH * AMBGRID.cellAspect);
        if (cellW <= 0) continue;
        if (!best || cellW > best.cellW) {
            best = { cols, rows, cellW, cellH: cellW / AMBGRID.cellAspect, gap };
        }
    }
    if (!best) return null;
    best.offsetX = (width - (best.cols * best.cellW + (best.cols - 1) * gap)) / 2;
    best.offsetY = (height - (best.rows * best.cellH + (best.rows - 1) * gap)) / 2;
    return best;
}

function cellRect(layout, index) {
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    return {
        x: layout.offsetX + col * (layout.cellW + layout.gap),
        y: layout.offsetY + row * (layout.cellH + layout.gap),
        w: layout.cellW,
        h: layout.cellH
    };
}

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    ambgrid.canvas.width = Math.round(width * dpr);
    ambgrid.canvas.height = Math.round(height * dpr);
    ambgrid.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ambgrid.layout = computeLayout(ambgrid.players.length, width, height);
}

// --- drawing ------------------------------------------------------------------

function roundedRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

function drawCell(ctx, rect, player, now) {
    ctx.save();
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, rect.w * AMBGRID.cornerRadiusRatio);
    ctx.fillStyle = player.color;
    ctx.fill();
    ctx.clip();
    ctx.translate(rect.x, rect.y);

    window.AmbSynthEmbed.drawInitials(ctx, rect.w, rect.h, player.initials, player.ink);

    const ripples = ambgrid.ripples.get(player.socketID);
    if (ripples) {
        const live = ripples.filter(r => now - r.startedAt < AMBGRID.fadeMs);
        if (live.length === 0) {
            ambgrid.ripples.delete(player.socketID);
        } else {
            ambgrid.ripples.set(player.socketID, live);
            live.forEach((r) => {
                const point = { x: r.x * rect.w, y: r.y * rect.h };
                window.AmbSynthEmbed.drawRipple(ctx, rect.w, rect.h, point,
                    (now - r.startedAt) / AMBGRID.fadeMs, player.ink);
            });
        }
    }

    const touch = ambgrid.touches.get(player.socketID);
    if (touch) {
        let opacity = 1;
        if (!touch.touching) {
            opacity = 1 - (now - touch.releasedAt) / AMBGRID.fadeMs;
            if (opacity <= 0) ambgrid.touches.delete(player.socketID);
        }
        if (opacity > 0) {
            const point = { x: touch.x * rect.w, y: touch.y * rect.h };
            window.AmbSynthEmbed.drawOverlay(ctx, rect.w, rect.h, point, opacity, player.ink, true);
        }
    }
    ctx.restore();
}

function render() {
    const ctx = ambgrid.ctx;
    const now = performance.now();
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    if (ambgrid.layout) {
        ambgrid.players.forEach((player, index) => {
            drawCell(ctx, cellRect(ambgrid.layout, index), player, now);
        });
    }
    requestAnimationFrame(render);
}

function setStatus(text) {
    ambgrid.statusEl.textContent = text || '';
    ambgrid.statusEl.classList.toggle('hidden', !text);
}

function refreshEmptyState() {
    if (ambgrid.socket && ambgrid.socket.connected) {
        setStatus(ambgrid.players.length === 0 ? 'Waiting for ambsynth players...' : '');
    }
}

// --- socket -------------------------------------------------------------------

function onPlayersUpdated(msg) {
    const players = (msg && Array.isArray(msg.players)) ? msg.players : [];
    ambgrid.players = players.map(p => ({
        socketID: p.socketID,
        initials: p.initials || '',
        color: p.color,
        ink: window.AmbSynthEmbed.inkFor(p.color)
    }));
    const present = new Set(ambgrid.players.map(p => p.socketID));
    for (const socketID of ambgrid.touches.keys()) {
        if (!present.has(socketID)) ambgrid.touches.delete(socketID);
    }
    for (const socketID of ambgrid.ripples.keys()) {
        if (!present.has(socketID)) ambgrid.ripples.delete(socketID);
    }
    resizeCanvas();
    refreshEmptyState();
}

function onTouch(msg) {
    if (!msg || !msg.socketID) return;
    const now = performance.now();
    if (msg.phase === 'up' && msg.short) {
        // Short tap: add a ripple (older ones keep going); no crosshair fade.
        ambgrid.touches.delete(msg.socketID);
        const list = ambgrid.ripples.get(msg.socketID) || [];
        list.push({ x: msg.x, y: msg.y, startedAt: now });
        ambgrid.ripples.set(msg.socketID, list.slice(-window.AmbSynthEmbed.MAX_RIPPLES));
        return;
    }
    const touching = msg.phase !== 'up';
    ambgrid.touches.set(msg.socketID, {
        x: msg.x,
        y: msg.y,
        touching,
        releasedAt: touching ? null : now
    });
}

function initSocket() {
    if (!ambgrid.sessionName) {
        setStatus('No session specified. Use /ambgrid?session=<name>');
        return;
    }
    ambgrid.socket = io('', { query: { session: ambgrid.sessionName, role: 'public' } });
    ambgrid.socket.on('connect', () => {
        setStatus('');
        ambgrid.socket.emit('request-ambsynth-players');
    });
    ambgrid.socket.on('disconnect', () => setStatus('Disconnected'));
    ambgrid.socket.on('session-unavailable', msg => setStatus((msg && msg.reason) || 'Session unavailable.'));
    ambgrid.socket.on('session-ended', () => setStatus('Session ended.'));
    ambgrid.socket.on('ambsynth-players-updated', onPlayersUpdated);
    ambgrid.socket.on('ambsynth-touch', onTouch);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
requestAnimationFrame(render);
initSocket();
