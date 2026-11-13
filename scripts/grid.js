// Grid: public display split in two halves.
//  - Devices (left): one portrait cell per configured pedal, in configuration
//    order (same as /public). The cell takes the controlling participant's
//    color and initials; unassigned pedals stay in place, grey and dimmed.
//    The cell glows (lightens) briefly whenever its participant sends a message.
//  - Ambsynth (right): one cell per participant currently playing the waiting
//    ambsynth (no pedal), colored with their background; touches are mirrored
//    with the same circle + crosshair while touching and the 2s ripple on lift.
//  - Camera: when enabled from the controller (or 'c'), the bottom band of the
//    devices half shows this machine's default webcam as a 16:9 cell; pedals
//    re-flow into the space above it.

const GRID = {
    cellAspect: 9 / 16,      // width / height
    gapRatio: 0.015,         // gap as a fraction of the shorter window side
    fadeMs: 2000,            // ripple duration; matches ambsynth envelope release
    cornerRadiusRatio: 0.04,
    labelRatio: 0.03,        // half label strip height, fraction of window height
    labelMinPx: 18,
    imageWidthRatio: 0.9,    // pedal photo width relative to the cell
    tallImageWidthRatio: 0.6, // same, for photos taller than wide
    nameSizeRatio: 0.075,    // device name font size, fraction of the cell width
    nameStripRatio: 1.8,     // name strip height (top, mirrored at the bottom), x font size
    idleColor: '#2a2d33',    // unassigned pedal cell
    idleImageAlpha: 0.35,
    glowLighten: 0.30,       // pedal cell lightens this much toward white on activity...
    glowFadeMs: 300,         // ...and fades back over this long after the last message
    cameraBandRatio: 0.4,    // share of the devices half's height given to the camera
    cameraAspect: 16 / 9     // camera cell width / height (webcam native)
};

const grid = {
    sessionName: new URLSearchParams(window.location.search).get('session') || '',
    socket: null,
    devices: [],                 // configured pedals, in configuration order
    assignmentsByDevice: new Map(), // deviceId -> { userInitials, userColor }
    images: new Map(),           // image url -> HTMLImageElement
    activityAt: new Map(),       // deviceId -> performance.now() of last 'device-activity'
    players: [],                 // [{ socketID, initials, color, ink }]
    touches: new Map(),          // socketID -> { x, y } while touching (circle + crosshair)
    ripples: new Map(),          // socketID -> [{ x, y, startedAt }] after lift (overlap)
    areas: null,                 // { devices, pedals, camera, ambsynth, labelH }
    layouts: { devices: null, ambsynth: null },
    qrBaseUrl: null,             // from the controller's QR Base URL setting
    qrVisible: false,            // join QR overlay (server-held, shared with the controller)
    qrRenderedFor: null,         // join URL the current QR image encodes
    camera: { visible: false, flipped: false }, // server-held, set from the controller
    cameraStream: null,          // MediaStream while the webcam is on
    cameraStarting: false,
    cameraError: null,           // message shown in the camera cell when it can't start
    cameraVideo: document.getElementById('camera-feed'),
    canvas: document.getElementById('grid'),
    statusEl: document.getElementById('grid-status')
};
grid.ctx = grid.canvas.getContext('2d');

const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// --- layout -------------------------------------------------------------------

// Picks the column count that yields the largest portrait cell for n cells.
function computeLayout(n, width, height) {
    if (n <= 0) return null;
    const gap = Math.round(Math.min(window.innerWidth, window.innerHeight) * GRID.gapRatio);
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const maxW = (width - gap * (cols + 1)) / cols;
        const maxH = (height - gap * (rows + 1)) / rows;
        const cellW = Math.min(maxW, maxH * GRID.cellAspect);
        if (cellW <= 0) continue;
        if (!best || cellW > best.cellW) {
            best = { cols, rows, cellW, cellH: cellW / GRID.cellAspect, gap };
        }
    }
    if (!best) return null;
    best.offsetX = (width - (best.cols * best.cellW + (best.cols - 1) * gap)) / 2;
    best.offsetY = (height - (best.rows * best.cellH + (best.rows - 1) * gap)) / 2;
    return best;
}

function cellRect(layout, area, index) {
    const col = index % layout.cols;
    const row = Math.floor(index / layout.cols);
    return {
        x: area.x + layout.offsetX + col * (layout.cellW + layout.gap),
        y: area.y + layout.offsetY + row * (layout.cellH + layout.gap),
        w: layout.cellW,
        h: layout.cellH
    };
}

function updateLayout() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const labelH = Math.max(GRID.labelMinPx, Math.round(height * GRID.labelRatio));
    const half = width / 2;
    const devices = { x: 0, y: labelH, w: half, h: height - labelH };
    let pedals = devices;
    let camera = null;
    if (grid.camera.visible) {
        // Bottom band of the devices half; a centered 16:9 cell inside it.
        const gap = Math.round(Math.min(width, height) * GRID.gapRatio);
        const bandH = Math.round(devices.h * GRID.cameraBandRatio);
        pedals = { x: devices.x, y: devices.y, w: devices.w, h: devices.h - bandH };
        const maxW = devices.w - gap * 2;
        const maxH = bandH - gap * 2;
        const camW = Math.min(maxW, maxH * GRID.cameraAspect);
        const camH = camW / GRID.cameraAspect;
        if (camW > 0) {
            camera = {
                x: devices.x + (devices.w - camW) / 2,
                y: pedals.y + pedals.h + (bandH - camH) / 2,
                w: camW,
                h: camH
            };
        }
    }
    grid.areas = {
        labelH,
        devices,
        pedals,
        camera,
        ambsynth: { x: half, y: labelH, w: width - half, h: height - labelH }
    };
    grid.layouts.devices = computeLayout(grid.devices.length, pedals.w, pedals.h);
    grid.layouts.ambsynth = computeLayout(grid.players.length, grid.areas.ambsynth.w, grid.areas.ambsynth.h);
}

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    grid.canvas.width = Math.round(window.innerWidth * dpr);
    grid.canvas.height = Math.round(window.innerHeight * dpr);
    grid.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    updateLayout();
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

// Fills the rounded cell, clips to it and moves the origin to its corner.
// Caller must ctx.restore().
function beginCell(ctx, rect, color) {
    ctx.save();
    roundedRectPath(ctx, rect.x, rect.y, rect.w, rect.h, rect.w * GRID.cornerRadiusRatio);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.clip();
    ctx.translate(rect.x, rect.y);
}

function getImage(url) {
    if (!url) return null;
    let img = grid.images.get(url);
    if (!img) {
        img = new Image();
        img.src = url;
        grid.images.set(url, img);
    }
    return (img.complete && img.naturalWidth > 0) ? img : null;
}

// Mixes a #rrggbb color toward white by amount (0..1).
function lighten(hex, amount) {
    const match = /^#?([0-9a-f]{6})$/i.exec(`${hex || ''}`.trim());
    if (!match || amount <= 0) return hex;
    const value = parseInt(match[1], 16);
    const mix = c => Math.round(c + (255 - c) * amount);
    return `rgb(${mix((value >> 16) & 255)}, ${mix((value >> 8) & 255)}, ${mix(value & 255)})`;
}

// 1 right after a message, fading linearly to 0 over glowFadeMs. Throttled
// events keep arriving during a slider drag, so the cell stays lit.
function glowLevel(deviceId, now) {
    const at = grid.activityAt.get(deviceId);
    if (at === undefined) return 0;
    const level = 1 - (now - at) / GRID.glowFadeMs;
    if (level <= 0) {
        grid.activityAt.delete(deviceId);
        return 0;
    }
    return level;
}

function drawDeviceCell(ctx, rect, device, now) {
    const assignment = grid.assignmentsByDevice.get(device.id) || null;
    const color = (assignment && assignment.userColor) || GRID.idleColor;
    const ink = window.AmbSynthEmbed.inkFor(color); // from the base color: no ink flicker
    const glow = assignment ? glowLevel(device.id, now) : 0;
    beginCell(ctx, rect, lighten(color, GRID.glowLighten * glow));

    const img = getImage(device.image);
    const nameSize = Math.max(10, rect.w * GRID.nameSizeRatio);
    const nameStrip = nameSize * GRID.nameStripRatio;
    ctx.save();
    ctx.globalAlpha = assignment ? 1 : GRID.idleImageAlpha;
    if (img) {
        // 90% of the cell width (60% for portrait photos), centered; shrink if
        // a tall photo would reach the name strip (kept clear top and bottom
        // so the photo stays centered in the cell).
        const widthRatio = img.naturalHeight > img.naturalWidth
            ? GRID.tallImageWidthRatio
            : GRID.imageWidthRatio;
        const scale = Math.min(
            (rect.w * widthRatio) / img.naturalWidth,
            Math.min(rect.h * GRID.imageWidthRatio, rect.h - nameStrip * 2) / img.naturalHeight
        );
        const w = img.naturalWidth * scale;
        const h = img.naturalHeight * scale;
        ctx.drawImage(img, (rect.w - w) / 2, (rect.h - h) / 2, w, h);
    }
    // Device name, centered at the top; shrinks to fit long names.
    ctx.fillStyle = ink;
    ctx.font = `600 ${nameSize}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(device.name || 'Device', rect.w / 2, nameStrip / 2, rect.w * GRID.imageWidthRatio);
    ctx.restore();

    if (assignment) {
        window.AmbSynthEmbed.drawInitials(ctx, rect.w, rect.h, assignment.userInitials, ink);
    }
    ctx.restore();
}

function drawPlayerCell(ctx, rect, player, now) {
    beginCell(ctx, rect, player.color);

    window.AmbSynthEmbed.drawInitials(ctx, rect.w, rect.h, player.initials, player.ink);

    const ripples = grid.ripples.get(player.socketID);
    if (ripples) {
        const live = ripples.filter(r => now - r.startedAt < GRID.fadeMs);
        if (live.length === 0) {
            grid.ripples.delete(player.socketID);
        } else {
            grid.ripples.set(player.socketID, live);
            live.forEach((r) => {
                const point = { x: r.x * rect.w, y: r.y * rect.h };
                window.AmbSynthEmbed.drawRipple(ctx, rect.w, rect.h, point,
                    (now - r.startedAt) / GRID.fadeMs, player.ink);
            });
        }
    }

    const touch = grid.touches.get(player.socketID);
    if (touch) {
        const point = { x: touch.x * rect.w, y: touch.y * rect.h };
        window.AmbSynthEmbed.drawOverlay(ctx, rect.w, rect.h, point, 1, player.ink, true);
    }
    ctx.restore();
}

// Webcam frame, cover-fitted into the rounded cell (rotated 180° when
// flipped); a dimmed status line until frames arrive or if it failed.
function drawCameraCell(ctx, rect) {
    beginCell(ctx, rect, GRID.idleColor);
    const video = grid.cameraVideo;
    if (grid.cameraStream && video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.max(rect.w / video.videoWidth, rect.h / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        if (grid.camera.flipped) {
            ctx.translate(rect.w / 2, rect.h / 2);
            ctx.rotate(Math.PI);
            ctx.translate(-rect.w / 2, -rect.h / 2);
        }
        ctx.drawImage(video, (rect.w - w) / 2, (rect.h - h) / 2, w, h);
    } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.font = `${Math.max(12, Math.round(rect.w * 0.03))}px ${FONT_STACK}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(grid.cameraError || 'Starting camera...', rect.w / 2, rect.h / 2, rect.w * 0.9);
    }
    ctx.restore();
}

// Small, discreet half title in the label strip.
function drawLabel(ctx, area, text) {
    const labelH = grid.areas.labelH;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.font = `600 ${Math.round(labelH * 0.55)}px ${FONT_STACK}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text.toUpperCase(), area.x + area.w / 2, labelH * 0.6);
    ctx.restore();
}

function drawEmptyMessage(ctx, area, text) {
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = `${Math.max(14, Math.round(area.w * 0.025))}px ${FONT_STACK}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, area.x + area.w / 2, area.y + area.h / 2, area.w * 0.9);
    ctx.restore();
}

function render() {
    const ctx = grid.ctx;
    const now = performance.now();
    const width = window.innerWidth;
    const height = window.innerHeight;
    ctx.clearRect(0, 0, width, height);

    if (grid.socket && grid.socket.connected && grid.areas) {
        const { devices: devArea, pedals: pedalArea, camera: cameraRect, ambsynth: ambArea } = grid.areas;

        // Hairline divider between the halves.
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.fillRect(Math.round(ambArea.x), 0, 1, height);

        drawLabel(ctx, devArea, 'Devices');
        drawLabel(ctx, ambArea, 'Ambient synth');

        if (grid.layouts.devices) {
            grid.devices.forEach((device, index) => {
                drawDeviceCell(ctx, cellRect(grid.layouts.devices, pedalArea, index), device, now);
            });
        } else {
            drawEmptyMessage(ctx, pedalArea, 'No devices configured');
        }

        if (cameraRect) drawCameraCell(ctx, cameraRect);

        if (grid.layouts.ambsynth) {
            grid.players.forEach((player, index) => {
                drawPlayerCell(ctx, cellRect(grid.layouts.ambsynth, ambArea, index), player, now);
            });
        } else {
            drawEmptyMessage(ctx, ambArea, 'Waiting for Ambient Synth players...');
        }
    }
    requestAnimationFrame(render);
}

function setStatus(text) {
    grid.statusEl.textContent = text || '';
    grid.statusEl.classList.toggle('hidden', !text);
}

// --- join QR overlay -----------------------------------------------------------

const qrOverlayEl = document.getElementById('qr-overlay');
const qrImageEl = document.getElementById('qr-image');

// Same join link as /public: QR base URL (or this origin) + /track?session=.
function buildJoinUrl() {
    const base = `${(grid.qrBaseUrl || window.location.origin).replace(/\/+$/, '')}/track`;
    return `${base}?session=${encodeURIComponent(grid.sessionName)}`;
}

function renderQrImage() {
    const url = buildJoinUrl();
    if (url === grid.qrRenderedFor || typeof window.QRCode !== 'function') return;
    const temp = document.createElement('div');
    temp.style.position = 'fixed';
    temp.style.left = '-9999px';
    document.body.appendChild(temp);
    try {
        new window.QRCode(temp, {
            text: url,
            width: 1024,
            height: 1024,
            correctLevel: window.QRCode.CorrectLevel.M
        });
        const canvas = temp.querySelector('canvas');
        const img = temp.querySelector('img');
        const dataUrl = (canvas && canvas.toDataURL) ? canvas.toDataURL('image/png') : (img && img.src);
        if (dataUrl) {
            qrImageEl.src = dataUrl;
            grid.qrRenderedFor = url;
        }
    } finally {
        document.body.removeChild(temp);
    }
}

function applyQrOverlay() {
    if (grid.qrVisible) renderQrImage();
    qrOverlayEl.classList.toggle('hidden', !grid.qrVisible);
}

function setQrOverlay(visible) {
    if (grid.socket && grid.socket.connected) {
        grid.socket.emit('set-qr-overlay', { visible }); // server echoes the new state
    }
}

qrOverlayEl.addEventListener('click', () => setQrOverlay(false));
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (e.key === 'q' || e.key === 'Q') setQrOverlay(!grid.qrVisible);
    else if (e.key === 'c' || e.key === 'C') setCameraVisible(!grid.camera.visible);
    else if (e.key === 'Escape' && grid.qrVisible) setQrOverlay(false);
});

// --- camera ---------------------------------------------------------------------

function setCameraVisible(visible) {
    if (grid.socket && grid.socket.connected) {
        grid.socket.emit('set-camera', { visible }); // server echoes the new state
    }
}

async function startCamera() {
    if (grid.cameraStream || grid.cameraStarting) return;
    grid.cameraError = null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        grid.cameraError = 'Camera unavailable (open the grid via localhost or https)';
        return;
    }
    grid.cameraStarting = true;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false
        });
        if (!grid.camera.visible) {
            // Hidden again while the permission prompt / startup was pending.
            stream.getTracks().forEach(track => track.stop());
            return;
        }
        grid.cameraStream = stream;
        grid.cameraVideo.srcObject = stream;
        grid.cameraVideo.play().catch(() => {});
    } catch (error) {
        grid.cameraError = (error && error.name === 'NotAllowedError')
            ? 'Camera permission denied'
            : `Camera error: ${(error && error.message) || error}`;
    } finally {
        grid.cameraStarting = false;
    }
}

// Releases the webcam entirely (its light goes off).
function stopCamera() {
    if (grid.cameraStream) {
        grid.cameraStream.getTracks().forEach(track => track.stop());
        grid.cameraStream = null;
    }
    grid.cameraVideo.srcObject = null;
    grid.cameraError = null;
}

function onCameraUpdated(msg) {
    grid.camera = { visible: Boolean(msg && msg.visible), flipped: Boolean(msg && msg.flipped) };
    if (grid.camera.visible) startCamera();
    else stopCamera();
    updateLayout();
}

// --- socket -------------------------------------------------------------------

function onDevicesUpdated(data) {
    if (!data) return;
    if (Array.isArray(data.configuredDevices)) {
        grid.devices = data.configuredDevices;
    }
    grid.assignmentsByDevice = new Map();
    Object.values(data.assignments || {}).forEach((assignment) => {
        if (assignment && assignment.deviceId !== undefined && assignment.deviceId !== null) {
            grid.assignmentsByDevice.set(assignment.deviceId, assignment);
        }
    });
    updateLayout();
}

function onPlayersUpdated(msg) {
    const players = (msg && Array.isArray(msg.players)) ? msg.players : [];
    grid.players = players.map(p => ({
        socketID: p.socketID,
        initials: p.initials || '',
        color: p.color,
        ink: window.AmbSynthEmbed.inkFor(p.color)
    }));
    const present = new Set(grid.players.map(p => p.socketID));
    for (const socketID of grid.touches.keys()) {
        if (!present.has(socketID)) grid.touches.delete(socketID);
    }
    for (const socketID of grid.ripples.keys()) {
        if (!present.has(socketID)) grid.ripples.delete(socketID);
    }
    updateLayout();
}

function onTouch(msg) {
    if (!msg || !msg.socketID) return;
    if (msg.phase === 'up') {
        // Lift: crosshair goes away, a ripple starts (older ones keep going).
        grid.touches.delete(msg.socketID);
        const list = grid.ripples.get(msg.socketID) || [];
        list.push({ x: msg.x, y: msg.y, startedAt: performance.now() });
        grid.ripples.set(msg.socketID, list.slice(-window.AmbSynthEmbed.MAX_RIPPLES));
        return;
    }
    grid.touches.set(msg.socketID, { x: msg.x, y: msg.y });
}

function initSocket() {
    if (!grid.sessionName) {
        setStatus('No session specified. Use /grid?session=<name>');
        return;
    }
    grid.socket = io('', { query: { session: grid.sessionName, role: 'public' } });
    grid.socket.on('connect', () => {
        setStatus('');
        grid.socket.emit('request-public-session-snapshot');
        grid.socket.emit('request-ambsynth-players');
    });
    grid.socket.on('disconnect', () => setStatus('Disconnected'));
    grid.socket.on('session-unavailable', msg => setStatus((msg && msg.reason) || 'Session unavailable.'));
    grid.socket.on('session-ended', () => setStatus('Session ended.'));
    grid.socket.on('public-session-snapshot', onDevicesUpdated);
    grid.socket.on('public-session-snapshot', (data) => {
        grid.qrBaseUrl = (data && data.qrBaseUrl) || null;
        applyQrOverlay();
    });
    grid.socket.on('qr-base-url-updated', (data) => {
        grid.qrBaseUrl = (data && data.baseUrl) || null;
        applyQrOverlay();
    });
    grid.socket.on('qr-overlay-updated', (msg) => {
        grid.qrVisible = Boolean(msg && msg.visible);
        applyQrOverlay();
    });
    grid.socket.on('camera-updated', onCameraUpdated);
    grid.socket.on('public-device-assignments-updated', onDevicesUpdated);
    grid.socket.on('device-activity', (msg) => {
        if (msg && msg.deviceId !== undefined && msg.deviceId !== null) {
            grid.activityAt.set(msg.deviceId, performance.now());
        }
    });
    grid.socket.on('ambsynth-players-updated', onPlayersUpdated);
    grid.socket.on('ambsynth-touch', onTouch);
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();
requestAnimationFrame(render);
initSocket();
