const fs = require('fs');
const path = require('path');

// Chaotic Pedalboard's app-specific server logic as a beatlink-core plugin:
// device catalog + slot-to-device assignments, per-device CC runtime state,
// host takeover, QR base URL, the public-display snapshot, and participant
// colors + ambsynth touch mirroring for the /grid display. Everything
// generic (sessions, roles, queue, slot timers, veil, MIDI transport) lives
// in beatlink-core.

// --- session state helpers (stored in the session attribute bag) -----------

function getAssignments(session) {
    return session.getAttribute('deviceAssignments');
}

function getConfiguredDevices(session) {
    return session.getAttribute('configuredDevices') || [];
}

function getTakeover(session) {
    return session.getAttribute('takeover');
}

function isTakeoverEnabled(session) {
    return Boolean(getTakeover(session).enabled);
}

function getRuntimeStates(session) {
    return session.getAttribute('deviceRuntimeStates');
}

function assignDeviceToSlot(session, slot, device, userInitials, userColor) {
    getAssignments(session)[slot] = {
        deviceId: device.id,
        deviceName: device.name || 'Unknown Device',
        userInitials: userInitials || '',
        userColor: userColor || null
    };
}

function clearAssignment(session, slot) {
    delete getAssignments(session)[slot];
}

function getRandomUnassignedDevice(session) {
    const devices = getConfiguredDevices(session);
    if (devices.length === 0) return null;

    const assignedIds = Object.values(getAssignments(session)).map(a => a.deviceId);
    const available = devices.filter(device => !assignedIds.includes(device.id));
    if (available.length === 0) return null;

    return available[Math.floor(Math.random() * available.length)];
}

function setConfiguredDevices(session, devices) {
    session.setAttribute('configuredDevices', devices || []);

    // Drop assignments and runtime state for devices no longer configured.
    const validIds = new Set((devices || []).map(device => device.id));
    const assignments = getAssignments(session);
    for (const slot of Object.keys(assignments)) {
        if (!validIds.has(assignments[slot].deviceId)) {
            delete assignments[slot];
        }
    }
    const validKeys = new Set((devices || []).map(device => String(device.id)));
    const runtimeStates = getRuntimeStates(session);
    for (const key of Object.keys(runtimeStates)) {
        if (!validKeys.has(key)) {
            delete runtimeStates[key];
        }
    }
}

function setDeviceControllerValue(session, deviceId, ccNumber, value) {
    if (deviceId === null || deviceId === undefined) return;
    const parsedCC = parseInt(ccNumber, 10);
    const parsedValue = parseInt(value, 10);
    if (!Number.isFinite(parsedCC) || !Number.isFinite(parsedValue)) return;

    const states = getRuntimeStates(session);
    const key = String(deviceId);
    if (!states[key]) {
        states[key] = { controllers: {}, updatedAt: Date.now() };
    }
    states[key].controllers[`cc:${parsedCC}`] = Math.min(127, Math.max(0, parsedValue));
    states[key].updatedAt = Date.now();
}

function getDeviceRuntimeState(session, deviceId) {
    const state = getRuntimeStates(session)[String(deviceId)];
    if (!state) return { controllers: {}, updatedAt: null };
    return { controllers: { ...state.controllers }, updatedAt: state.updatedAt || null };
}

function applyTakeoverValueToConfiguredControllers(session, value) {
    const takeoverValue = Math.min(127, Math.max(0, parseInt(value, 10) || 0));
    getConfiguredDevices(session).forEach((device) => {
        const controllers = Array.isArray(device.controllers) ? device.controllers : [];
        controllers.forEach((controller) => {
            const ccNumber = parseInt(
                controller?.ccNumber !== undefined ? controller.ccNumber : controller?.cc_number,
                10
            );
            if (!Number.isFinite(ccNumber)) return;
            setDeviceControllerValue(session, device.id, ccNumber, takeoverValue);
        });
    });
    getTakeover(session).value = takeoverValue;
}

function normalizeQrBaseUrl(rawValue) {
    const value = `${rawValue || ''}`.trim();
    if (!value) return null;
    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        const sanitizedPath = parsed.pathname && parsed.pathname !== '/'
            ? parsed.pathname.replace(/\/+$/, '')
            : '';
        return `${parsed.origin}${sanitizedPath}`;
    } catch (error) {
        return null;
    }
}

// --- participant colors + ambsynth players ----------------------------------

// Background colors for participants' ambsynth; mirrored on the /grid view.
const PARTICIPANT_COLORS = [
    '#e4572e', // coral
    '#f2a541', // amber
    '#8cb33a', // leaf
    '#1f9e89', // teal
    '#3a7bd5', // azure
    '#6c4ab6', // violet
    '#b8407a', // magenta
    '#4a5160'  // graphite
];

function getParticipantColors(session) {
    return session.getAttribute('participantColors');
}

// Least-used palette index (lowest on ties); colors repeat past 8 people.
function assignParticipantColor(session, socketID) {
    const colors = getParticipantColors(session);
    if (colors[socketID] !== undefined) return PARTICIPANT_COLORS[colors[socketID]];
    const counts = PARTICIPANT_COLORS.map(() => 0);
    Object.values(colors).forEach((index) => { counts[index] += 1; });
    const index = counts.indexOf(Math.min(...counts));
    colors[socketID] = index;
    return PARTICIPANT_COLORS[index];
}

function getAmbsynthPlayers(session) {
    return session.getAttribute('ambsynthPlayers');
}

function ambsynthPlayerList(session) {
    return Object.entries(getAmbsynthPlayers(session))
        .map(([socketID, player]) => ({ socketID, ...player }));
}

// App rule: initials are uppercase, no spaces, max 3 chars (track.js enforces
// the same; this guards the ambsynth list against old/hand-made URLs).
function handshakeInitials(socket) {
    const raw = socket.handshake && socket.handshake.query ? socket.handshake.query.initials : '';
    const cleaned = typeof raw === 'string' ? raw.replace(/\s+/g, '').toUpperCase().slice(0, 3) : '';
    return cleaned || '?';
}

function clampUnit(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.min(1, Math.max(0, number));
}

function getSessionMode(session) {
    if (isTakeoverEnabled(session)) return 'takeover';
    return session.isPlaying() ? 'play' : 'pause';
}

// --- emit helpers -----------------------------------------------------------

function emitDeviceAssignments(ctx, session) {
    ctx.emitToHost(session, 'device-assignments-updated', {
        assignments: getAssignments(session)
    });
    ctx.emitToRole(session.name, 'public', 'public-device-assignments-updated', {
        configuredDevices: getConfiguredDevices(session),
        assignments: getAssignments(session)
    });
}

function emitRuntimeDiagnostics(ctx, session) {
    ctx.emitToHost(session, 'device-runtime-state-updated', {
        deviceStates: getRuntimeStates(session)
    });
}

function emitTakeoverState(ctx, session) {
    ctx.emitToSession(session.name, 'takeover-state-updated', {
        takeover: { ...getTakeover(session) }
    });
}

function emitSessionMode(ctx, session) {
    ctx.emitToSession(session.name, 'session-mode-updated', {
        mode: getSessionMode(session)
    });
}

function emitTrackAssignment(ctx, session, socketID, slot) {
    const assignment = getAssignments(session)[slot];
    if (!assignment) return false;

    const fullDevice = getConfiguredDevices(session).find(d => d.id === assignment.deviceId) || null;
    const participant = session.participants.get(slot);

    ctx.io.to(socketID).emit('track-assignment', {
        socketID,
        device: fullDevice,
        deviceState: fullDevice
            ? getDeviceRuntimeState(session, fullDevice.id)
            : { controllers: {}, updatedAt: null },
        channel: (fullDevice && Number.isInteger(fullDevice.assignedChannel))
            ? (fullDevice.assignedChannel - 1)
            : 0,
        trackId: slot.toString(),
        trackNumber: slot + 1,
        slotDurationSec: session.config.turnTaking.threshold,
        slotExpiresAt: participant ? participant.expiresAt : null
    });
    return true;
}

function emitAmbsynthPlayers(ctx, session, socketID) {
    const payload = { players: ambsynthPlayerList(session) };
    if (socketID) {
        ctx.io.to(socketID).emit('ambsynth-players-updated', payload);
    } else {
        ctx.emitToRole(session.name, 'public', 'ambsynth-players-updated', payload);
    }
}

// Tells displays a pedal just received a participant message (drives the
// glow on /grid). Throttled per device: a slider drag sends dozens of
// messages per second, displays only need ~10 events/s to stay lit.
const DEVICE_ACTIVITY_MIN_INTERVAL_MS = 100;

function emitDeviceActivity(ctx, session, deviceId) {
    const lastAt = session.getAttribute('deviceActivityAt');
    const now = Date.now();
    if (now - (lastAt[deviceId] || 0) < DEVICE_ACTIVITY_MIN_INTERVAL_MS) return;
    lastAt[deviceId] = now;
    ctx.emitToRole(session.name, 'public', 'device-activity', { deviceId });
}

function emitPublicSnapshot(ctx, session, socketID) {
    ctx.io.to(socketID).emit('public-session-snapshot', {
        configuredDevices: getConfiguredDevices(session),
        assignments: getAssignments(session),
        queue: session.queue.snapshot(),
        length: session.queue.length(),
        activeSlots: session.participants.activeCount(),
        slotDurationSec: session.config.turnTaking.threshold,
        isPlaying: session.isPlaying(),
        qrBaseUrl: session.getAttribute('qrBaseUrl') || null
    });
}

// Keeps the server-side device map aligned with the controller's
// authoritative routing when the host reassigns a track.
function syncDeviceAssignmentFromHostMessage(session, msg) {
    if (!session || !msg) return;
    const slot = session.participants.slotOf(msg.socketID);
    if (slot < 0) return;

    const nextDeviceId = msg.device && msg.device.id !== undefined ? msg.device.id : null;
    const assignments = getAssignments(session);

    if (nextDeviceId !== null) {
        for (const [assignedSlot, assignment] of Object.entries(assignments)) {
            if (parseInt(assignedSlot, 10) !== slot && assignment && assignment.deviceId === nextDeviceId) {
                delete assignments[assignedSlot];
            }
        }
        const initials = session.participants.initialsOf(msg.socketID)
            || (assignments[slot] ? assignments[slot].userInitials : '');
        assignDeviceToSlot(session, slot, msg.device, initials, assignParticipantColor(session, msg.socketID));
    } else if (assignments[slot]) {
        delete assignments[slot];
    }
}

// --- the plugin -------------------------------------------------------------

module.exports = function midiPlugin(ctx) {
    ctx.defineAttributes({
        configuredDevices: [],
        deviceAssignments: {},   // slot -> { deviceId, deviceName, userInitials, userColor }
        deviceRuntimeStates: {}, // deviceId -> { controllers: {"cc:<n>": value}, updatedAt }
        takeover: { enabled: false, value: 127 },
        qrBaseUrl: null,
        participantColors: {},   // socketID -> PARTICIPANT_COLORS index
        ambsynthPlayers: {},     // socketID -> { initials, color } while on ambsynth
        deviceActivityAt: {},    // deviceId -> last 'device-activity' emit (ms), for throttling
        qrOverlayVisible: false, // join QR overlay on /grid, toggled from controller or grid
        camera: { visible: false, flipped: false }, // /grid webcam band, toggled from controller or grid
        publicDisplays: {}       // socketID -> true for connected public displays
    });

    // Participants only get a slot when a pedal is free and no takeover is on.
    ctx.activationGate(session =>
        !isTakeoverEnabled(session) && Boolean(getRandomUnassignedDevice(session))
    );

    // Slot taken (direct join or queue promotion) -> hand out a pedal.
    ctx.onActivate((session, { slot, socketID, initials }) => {
        const device = getRandomUnassignedDevice(session);
        if (device) {
            // Direct joins activate before onConnect, so assign the color here too.
            assignDeviceToSlot(session, slot, device, initials, assignParticipantColor(session, socketID));
        }
        emitTrackAssignment(ctx, session, socketID, slot);
        emitDeviceAssignments(ctx, session);
    });

    // Slot freed (disconnect/eviction/takeover) -> pedal back in the pool.
    ctx.onRelease((session, { slot }) => {
        clearAssignment(session, slot);
        emitDeviceAssignments(ctx, session);
    });

    // MIDI over the routed transport: maintain per-device CC state so newly
    // assigned users inherit the latest values; drop everything during takeover.
    ctx.onRoutedMessage((socket, session, envelope) => {
        if (envelope.type !== 'MIDI') return;
        if (isTakeoverEnabled(session)) return false; // blocked: no glow on /grid either

        const slot = session.participants.slotOf(socket.id);
        const assignment = slot >= 0 ? getAssignments(session)[slot] : null;
        const deviceId = (assignment && assignment.deviceId !== undefined && assignment.deviceId !== null)
            ? assignment.deviceId
            : null;

        const message = envelope.message;
        if (deviceId !== null && Array.isArray(message) && message.length >= 3 && (message[0] >> 4) === 0xB) {
            setDeviceControllerValue(session, deviceId, message[1], message[2]);
            emitRuntimeDiagnostics(ctx, session);
        }
        if (deviceId !== null) emitDeviceActivity(ctx, session, deviceId);
    });

    // Give host and public their current state on (re)connect.
    ctx.onConnect((socket, session, role) => {
        if (!session) return;
        if (role === 'host') {
            emitDeviceAssignments(ctx, session);
            emitRuntimeDiagnostics(ctx, session);
            emitTakeoverState(ctx, session);
            emitSessionMode(ctx, session);
            socket.emit('turn-duration-updated', { seconds: session.config.turnTaking.threshold });
            socket.emit('qr-overlay-updated', { visible: session.getAttribute('qrOverlayVisible') });
            socket.emit('camera-updated', session.getAttribute('camera'));
        } else if (role === 'public') {
            session.getAttribute('publicDisplays')[socket.id] = true;
            emitPublicSnapshot(ctx, session, socket.id);
            socket.emit('qr-overlay-updated', { visible: session.getAttribute('qrOverlayVisible') });
            socket.emit('camera-updated', session.getAttribute('camera'));
        } else if (role === 'participant') {
            socket.emit('participant-color', { color: assignParticipantColor(session, socket.id) });
        }
    });

    ctx.onDisconnect((socket, session, role) => {
        if (session && role === 'public') delete session.getAttribute('publicDisplays')[socket.id];
        if (!session || role !== 'participant') return;
        delete getParticipantColors(session)[socket.id];
        if (getAmbsynthPlayers(session)[socket.id]) {
            delete getAmbsynthPlayers(session)[socket.id];
            emitAmbsynthPlayers(ctx, session);
        }
    });

    ctx.on('request-public-session-snapshot', (socket, session) => {
        if (session) emitPublicSnapshot(ctx, session, socket.id);
    });

    // --- ambsynth mirroring (participants without a pedal -> /grid) ---

    ctx.on('request-ambsynth-players', (socket, session) => {
        if (session) emitAmbsynthPlayers(ctx, session, socket.id);
    });

    // Track page reports when its embedded ambsynth is shown or hidden.
    ctx.on('ambsynth-active', (socket, session, msg) => {
        if (!session) return;
        const colors = getParticipantColors(session);
        if (colors[socket.id] === undefined) return; // participants only
        const players = getAmbsynthPlayers(session);
        const active = Boolean(msg && msg.active);
        if (active === Boolean(players[socket.id])) return;
        if (active) {
            players[socket.id] = {
                initials: handshakeInitials(socket),
                color: PARTICIPANT_COLORS[colors[socket.id]]
            };
        } else {
            delete players[socket.id];
        }
        emitAmbsynthPlayers(ctx, session);
    });

    // Touch events (normalized 0..1) relayed to public displays.
    ctx.on('ambsynth-touch', (socket, session, msg) => {
        if (!session || !msg || !getAmbsynthPlayers(session)[socket.id]) return;
        if (!['down', 'move', 'up'].includes(msg.phase)) return;
        const x = clampUnit(msg.x);
        const y = clampUnit(msg.y);
        if (x === null || y === null) return;
        const relayed = { socketID: socket.id, phase: msg.phase, x, y };
        if (msg.phase === 'up') relayed.short = Boolean(msg.short); // short tap -> ripple
        ctx.emitToRole(session.name, 'public', 'ambsynth-touch', relayed);
    });

    // Track asks for its current device assignment (e.g. after reconnect).
    ctx.on('request-track-assignment', (socket, session) => {
        if (!session) return;
        const slot = session.participants.slotOf(socket.id);

        if (slot >= 0 && emitTrackAssignment(ctx, session, socket.id, slot)) {
            return;
        }

        const position = session.queue.positionOf(socket.id);
        if (position > 0) {
            socket.emit('queue-status', {
                position,
                total: session.queue.length(),
                message: isTakeoverEnabled(session)
                    ? 'Session is temporarily suspended by the host.'
                    : `You are #${position} in line.`
            });
            return;
        }

        socket.emit('track-assignment', {
            socketID: socket.id,
            device: null,
            channel: 0,
            trackId: slot >= 0 ? slot.toString() : '-1',
            trackNumber: slot >= 0 ? slot + 1 : -1
        });
    });

    // Host is the routing authority: it can (re)assign a device to a track.
    ctx.on('track-assignment', (socket, session, msg) => {
        if (!ctx.requireHost(socket, session)) return;
        if (!msg || !msg.socketID) return;

        syncDeviceAssignmentFromHostMessage(session, msg);

        const slot = session.participants.slotOf(msg.socketID);
        if (slot >= 0) {
            const participant = session.participants.get(slot);
            msg.slotDurationSec = session.config.turnTaking.threshold;
            msg.slotExpiresAt = participant ? participant.expiresAt : null;
        }
        const assignment = slot >= 0 ? getAssignments(session)[slot] : null;
        msg.deviceState = assignment
            ? getDeviceRuntimeState(session, assignment.deviceId)
            : { controllers: {}, updatedAt: null };

        emitDeviceAssignments(ctx, session);
        ctx.io.to(msg.socketID).emit('track-assignment', msg);
    });

    // Host publishes its configured device list.
    ctx.on('devices-configured', (socket, session, msg) => {
        if (!ctx.requireHost(socket, session)) return;
        setConfiguredDevices(session, (msg && msg.devices) || []);

        const assignments = getAssignments(session);
        Object.keys(assignments).forEach((slot) => {
            const participant = session.participants.get(parseInt(slot, 10));
            if (participant) {
                emitTrackAssignment(ctx, session, participant.socketID, parseInt(slot, 10));
            }
        });

        emitDeviceAssignments(ctx, session);
        emitRuntimeDiagnostics(ctx, session);
        ctx.turnTaking.tryPromote(session.name); // new devices may unblock the queue
    });

    ctx.on('set-takeover-state', (socket, session, msg) => {
        if (!ctx.requireHost(socket, session)) return;

        const takeover = getTakeover(session);
        takeover.enabled = Boolean(msg?.enabled);
        const value = parseInt(msg?.value, 10);
        if (Number.isFinite(value)) {
            takeover.value = Math.min(127, Math.max(0, value));
        }

        if (takeover.enabled) {
            if (session.isPlaying()) {
                session.pause();
                socket.broadcast.to(session.name).emit('veil-on', {
                    socketID: socket.id,
                    reason: 'takeover-enabled'
                });
            }
            ctx.turnTaking.forceAllToQueue(session.name, 'Session is temporarily suspended by the host.');
        }

        emitDeviceAssignments(ctx, session);
        emitRuntimeDiagnostics(ctx, session);
        emitTakeoverState(ctx, session);
        emitSessionMode(ctx, session);

        if (!takeover.enabled) {
            ctx.turnTaking.tryPromote(session.name);
        }
    });

    ctx.on('set-takeover-value', (socket, session, msg) => {
        if (!ctx.requireHost(socket, session)) return;
        if (!isTakeoverEnabled(session)) return;

        const value = parseInt(msg?.value, 10);
        if (!Number.isFinite(value)) return;

        applyTakeoverValueToConfiguredControllers(session, value);
        emitRuntimeDiagnostics(ctx, session);
        emitTakeoverState(ctx, session);
    });

    ctx.on('set-qr-base-url', (socket, session, msg) => {
        if (!ctx.requireHost(socket, session)) return;
        const normalized = normalizeQrBaseUrl(msg?.baseUrl);
        if (!normalized) return;
        session.setAttribute('qrBaseUrl', normalized);
        ctx.emitToSession(session.name, 'qr-base-url-updated', { baseUrl: normalized });
    });

    // Join QR overlay on /grid: host (controller button / 'q') or a public
    // display (grid 'q', click, Esc) sets it; everyone gets the new state so
    // the controller button and all grids stay in sync.
    ctx.on('set-qr-overlay', (socket, session, msg) => {
        if (!session) return;
        const isDisplay = Boolean(session.getAttribute('publicDisplays')[socket.id]);
        if (!ctx.requireHost(socket, session) && !isDisplay) return;
        const visible = Boolean(msg && msg.visible);
        session.setAttribute('qrOverlayVisible', visible);
        ctx.emitToHost(session, 'qr-overlay-updated', { visible });
        ctx.emitToRole(session.name, 'public', 'qr-overlay-updated', { visible });
    });

    // Webcam band on /grid (the grid machine's own camera): host (controller
    // buttons / 'c') or a public display (grid 'c') sets visible and/or
    // flipped; everyone gets the new state, like the QR overlay.
    ctx.on('set-camera', (socket, session, msg) => {
        if (!session) return;
        const isDisplay = Boolean(session.getAttribute('publicDisplays')[socket.id]);
        if (!ctx.requireHost(socket, session) && !isDisplay) return;
        const camera = { ...session.getAttribute('camera') };
        if (msg && typeof msg.visible === 'boolean') camera.visible = msg.visible;
        if (msg && typeof msg.flipped === 'boolean') camera.flipped = msg.flipped;
        session.setAttribute('camera', camera);
        ctx.emitToHost(session, 'camera-updated', camera);
        ctx.emitToRole(session.name, 'public', 'camera-updated', camera);
    });

    // Play/Pause leave takeover mode (the controller relies on this) and keep
    // its mode indicator in sync with core play/pause.
    function exitTakeover(session) {
        if (!isTakeoverEnabled(session)) return false;
        const takeover = getTakeover(session);
        takeover.enabled = false;
        takeover.value = 127;
        emitTakeoverState(ctx, session);
        emitDeviceAssignments(ctx, session);
        return true;
    }

    ctx.on('session-play', (socket, session) => {
        if (!ctx.requireHost(socket, session)) return;
        const exited = exitTakeover(session);
        emitSessionMode(ctx, session);
        // Core's own play handler already tried to promote, but the takeover
        // gate blocked it; retry now that takeover is off.
        if (exited) ctx.turnTaking.tryPromote(session.name);
    });
    ctx.on('session-pause', (socket, session) => {
        if (!ctx.requireHost(socket, session)) return;
        exitTakeover(session);
        emitSessionMode(ctx, session);
    });

    ctx.route('get', '/api/pedal-images', (req, res) => {
        try {
            const pedalsDir = path.join(__dirname, '..', 'images', 'pedals');
            const allowedExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'];
            const images = fs.readdirSync(pedalsDir, { withFileTypes: true })
                .filter(entry => entry.isFile())
                .map(entry => entry.name)
                .filter(name => allowedExtensions.some(ext => name.toLowerCase().endsWith(ext)))
                .sort((a, b) => a.localeCompare(b))
                .map(name => `/images/pedals/${name}`);
            res.json({ images });
        } catch (error) {
            ctx.logger.error(`Failed to list pedal images: ${error.message}`);
            res.status(500).json({ images: [], error: 'Failed to list pedal images' });
        }
    });
};
