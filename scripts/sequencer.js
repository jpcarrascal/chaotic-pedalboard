/**
 * MIDI Routing Sequencer
 * Main application logic for the routing matrix interface
 */

// Global application state
let app = {
    // Core components
    midiDeviceManager: null,
    routingMatrix: null,
    midiRouter: null,
    socket: null,
    
    // Session info
    sessionName: null,
    qrBaseUrl: window.location.origin,
    isPlaying: false,
    sessionMode: 'pause',
    deviceAssignments: {}, // Maps trackNumber -> {deviceId, deviceName, userInitials}
    deviceRuntimeStates: {},
    qrOverlayVisible: false,
    takeover: {
        value: 127
    },
    slotDurationSec: 60,
    
    // UI elements
    elements: {},
    
    // Statistics
    lastStatsUpdate: 0,
    statsUpdateInterval: 1000 // Update every second
};

const QR_BASE_URL_STORAGE_KEY = 'midisocket.qrBaseUrl.v1';

// Global device configuration instance
let deviceConfig = null;

function syncConfiguredDevicesToServer() {
    if (!app.socket || !app.socket.connected || !deviceConfig) {
        return;
    }

    const configuredDevices = deviceConfig.getConfiguredDevices().map(device => ({
        id: device.id,
        name: device.name,
        color: device.color,
        image: device.image || '',
        assignedChannel: device.assignedChannel,
        assignedInterface: device.assignedInterface,
        controllers: device.controllers || []
    }));

    app.socket.emit('devices-configured', {
        devices: configuredDevices
    });
    console.log('Sent configured devices to server:', configuredDevices.length);
}

function normalizeQrBaseUrl(rawValue) {
    const fallback = window.location.origin;
    const value = `${rawValue || ''}`.trim();
    if (!value) {
        return fallback;
    }

    const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;

    let parsed;
    try {
        parsed = new URL(withProtocol);
    } catch (error) {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
    }

    const sanitizedPath = parsed.pathname && parsed.pathname !== '/'
        ? parsed.pathname.replace(/\/+$/, '')
        : '';

    return `${parsed.origin}${sanitizedPath}`;
}

function buildTrackUrlFromBase(baseUrl) {
    const sanitizedBase = normalizeQrBaseUrl(baseUrl) || window.location.origin;
    const trackPath = `${sanitizedBase}/track`;

    if (!app.sessionName) {
        return trackPath;
    }

    return `${trackPath}?session=${encodeURIComponent(app.sessionName)}`;
}

function loadQrBaseUrlFromStorage() {
    let storedValue = '';
    try {
        storedValue = window.localStorage.getItem(QR_BASE_URL_STORAGE_KEY) || '';
    } catch (error) {
        storedValue = '';
    }

    app.qrBaseUrl = normalizeQrBaseUrl(storedValue) || window.location.origin;
}

function saveQrBaseUrlToStorage(baseUrl) {
    try {
        window.localStorage.setItem(QR_BASE_URL_STORAGE_KEY, baseUrl);
    } catch (error) {
        // Ignore storage failures.
    }
}

function emitQrBaseUrlToServer() {
    if (!app.socket || !app.socket.connected) {
        return;
    }

    app.socket.emit('set-qr-base-url', {
        baseUrl: app.qrBaseUrl
    });
}

function applyQrBaseUrlFromInput() {
    const rawInput = app.elements.qrBaseUrlInput ? app.elements.qrBaseUrlInput.value : '';
    const normalized = normalizeQrBaseUrl(rawInput);
    if (!normalized) {
        showError('QR Base URL must be a valid http(s) URL.');
        if (app.elements.qrBaseUrlInput) {
            app.elements.qrBaseUrlInput.value = app.qrBaseUrl;
        }
        return;
    }

    app.qrBaseUrl = normalized;
    if (app.elements.qrBaseUrlInput) {
        app.elements.qrBaseUrlInput.value = app.qrBaseUrl;
    }

    saveQrBaseUrlToStorage(app.qrBaseUrl);
    updateTrackUrl();
    emitQrBaseUrlToServer();
    showInfo('QR Base URL updated.');
}

function resetQrBaseUrlToDefault() {
    app.qrBaseUrl = window.location.origin;

    if (app.elements.qrBaseUrlInput) {
        app.elements.qrBaseUrlInput.value = app.qrBaseUrl;
    }

    saveQrBaseUrlToStorage(app.qrBaseUrl);
    updateTrackUrl();
    emitQrBaseUrlToServer();
    showInfo('QR Base URL reset to the current host.');
}

// Initialize application when page loads
document.addEventListener('DOMContentLoaded', async function() {
    console.log('Initializing MIDI Routing Sequencer...');
    
    // Get DOM elements
    initializeElements();
    loadQrBaseUrlFromStorage();

    if (app.elements.qrBaseUrlInput) {
        app.elements.qrBaseUrlInput.value = app.qrBaseUrl;
    }
    
    // Debug: Check initial panel states
    console.log('Device config panel hidden?', document.getElementById('device-config-panel')?.classList.contains('hidden'));
    console.log('Device panel hidden?', document.getElementById('device-panel')?.classList.contains('hidden'));
    console.log('Device selection modal hidden?', document.getElementById('device-selection-modal')?.classList.contains('hidden'));
    
    // Initialize core components
    await initializeMidi();
    
    // Initialize device configuration system
    await initializeDeviceConfiguration();
    
    // Initialize socket connection
    initializeSocket();
    
    // Set up event listeners
    setupEventListeners();
    
    // Update UI
    updateSessionInfo();
    updateTrackUrl();
    
    console.log('MIDI Routing Sequencer initialized successfully');
});

/**
 * Initialize DOM element references
 */
function initializeElements() {
    app.elements = {
        // Session info
        sessionName: document.getElementById('session-name'),
        sessionStatus: document.getElementById('session-status'),
        midiStatus: document.getElementById('midi-status'),
        queueLength: document.getElementById('queue-length'),
        activeSlots: document.getElementById('active-slots'),
        nextInQueue: document.getElementById('next-in-queue'),
        
        // Controls
        playButton: document.getElementById('play-button'),
        pauseButton: document.getElementById('pause-button'),
        takeoverButton: document.getElementById('takeover-button'),
        panicAllButton: document.getElementById('panic-all'),
        qrOverlayToggle: document.getElementById('qr-overlay-toggle'),
        slotDurationInput: document.getElementById('slot-duration'),
        slotDurationApplyButton: document.getElementById('slot-duration-apply'),
        deviceConfigToggle: document.getElementById('device-config-toggle'),
        infoToggle: document.getElementById('info-toggle'),
        statsToggle: document.getElementById('stats-toggle'),
        
        // Panels
        devicePanel: document.getElementById('device-panel'),
        statsPanel: document.getElementById('stats-panel'),
        deviceStatus: document.getElementById('device-status'),
        deviceList: document.getElementById('device-list'),
        
        // Routing matrix
        routingTable: document.getElementById('routing-table'),
        routingTableBody: document.getElementById('routing-table-body'),
        noTracksMessage: document.getElementById('no-tracks-message'),
        trackUrl: document.getElementById('track-url'),
        copyUrlButton: document.getElementById('copy-url'),
        qrBaseUrlInput: document.getElementById('qr-base-url-input'),
        qrBaseUrlApplyButton: document.getElementById('qr-base-url-apply'),
        qrBaseUrlResetButton: document.getElementById('qr-base-url-reset'),
        
        // Statistics
        statActiveTracks: document.getElementById('stat-active-tracks'),
        statRoutedTracks: document.getElementById('stat-routed-tracks'),
        statMessagesRouted: document.getElementById('stat-messages-routed'),
        statRoutingErrors: document.getElementById('stat-routing-errors'),
        runtimeStatesEmpty: document.getElementById('runtime-states-empty'),
        runtimeStatesList: document.getElementById('runtime-states-list'),
        takeoverFader: document.getElementById('takeover-fader'),
        takeoverValue: document.getElementById('takeover-value'),
        takeoverHint: document.getElementById('takeover-hint'),
        
        // Messages
        errorMessage: document.getElementById('error-message'),
        infoMessage: document.getElementById('info-message')
    };
}

/**
 * Initialize MIDI system
 */
async function initializeMidi() {
    try {
        // Initialize MIDI Interface Manager
        app.midiDeviceManager = new MidiDeviceManager();
        const midiSupported = await app.midiDeviceManager.initialize();
        
        if (!midiSupported) {
            showError('Web MIDI API not supported in this browser');
            app.elements.midiStatus.innerHTML = '<strong>Not Supported</strong>';
            return;
        }
        
        // Initialize Routing Matrix
        app.routingMatrix = new RoutingMatrix();
        
        // Initialize MIDI Router
        app.midiRouter = new MidiRouter(app.midiDeviceManager, app.routingMatrix);
        
        // Set up callbacks
        app.midiDeviceManager.setDeviceChangeCallback(onDeviceChange);
        app.routingMatrix.setTrackChangeCallback(onTrackChange);
        app.routingMatrix.setRoutingChangeCallback(onRoutingChange);
        
        // Update UI
        app.elements.midiStatus.innerHTML = '<strong>Ready</strong>';
        updateDeviceList();
        
        console.log('MIDI system initialized successfully');
        
    } catch (error) {
        console.error('Failed to initialize MIDI system:', error);
        showError('Failed to initialize MIDI system: ' + error.message);
        app.elements.midiStatus.innerHTML = '<strong>Error</strong>';
    }
}

/**
 * Initialize device configuration system
 */
async function initializeDeviceConfiguration() {
    try {
        // Create and initialize device configuration
        deviceConfig = new DeviceConfiguration();
        await deviceConfig.initialize();
        
        // Update available interfaces when MIDI devices change
        deviceConfig.updateAvailableInterfaces(app.midiDeviceManager.getOutputDevicesList());
        
        // Expose globally for other modules
        window.deviceConfig = deviceConfig;
        
        console.log('Device configuration system initialized');
        
    } catch (error) {
        console.error('Failed to initialize device configuration:', error);
        showError('Failed to initialize device configuration: ' + error.message);
    }
}

/**
 * Initialize socket connection
 */
function initializeSocket() {
    // Get session name from URL
    const urlParams = new URLSearchParams(window.location.search);
    app.sessionName = urlParams.get('session') || 'default';

    // Point the public/grid page links at this session
    const sessionQuery = `?session=${encodeURIComponent(app.sessionName)}`;
    const publicLink = document.getElementById('public-link');
    const gridLink = document.getElementById('grid-link');
    if (publicLink) publicLink.href = `/public${sessionQuery}`;
    if (gridLink) gridLink.href = `/grid${sessionQuery}`;
    const testbedLink = document.getElementById('testbed-link');
    if (testbedLink) testbedLink.href = `/testbed${sessionQuery}&n=8`;

    // Initialize socket connection
    app.socket = io('', {
        query: {
            session: app.sessionName,
            role: 'host'
        }
    });

    // Socket event handlers
    app.socket.on('connect', onSocketConnect);
    app.socket.on('disconnect', onSocketDisconnect);
    app.socket.on('participant-joined', onTrackJoined);
    app.socket.on('participant-left', onTrackLeft);
    app.socket.on('routed-message', onTrackMidiMessage);
    app.socket.on('get-track-assignment', onGetTrackAssignment);
    app.socket.on('device-assignments-updated', onDeviceAssignmentsUpdated);
    app.socket.on('device-runtime-state-updated', onDeviceRuntimeStateUpdated);
    app.socket.on('queue-updated', onQueueUpdated);
    app.socket.on('session-mode-updated', onSessionModeUpdated);
    app.socket.on('qr-overlay-updated', onQrOverlayUpdated);
    app.socket.on('takeover-state-updated', onTakeoverStateUpdated);
    app.socket.on('takeover-error', onTakeoverError);
    app.socket.on('turn-duration-updated', onSlotDurationUpdated);
    app.socket.on('host-exists', onSequencerExists);
    app.socket.on('error', onSocketError);
}

function updateSessionStatus() {
    if (!app.elements.sessionStatus) return;

    const isConnected = Boolean(app.socket?.connected);

    let statusClass = 'session-status-not-ready';
    let statusLabel = 'Not Ready';

    if (isConnected) {
        if (app.sessionMode === 'play') {
            statusClass = 'session-status-running';
            statusLabel = 'Running';
        } else if (app.sessionMode === 'takeover') {
            statusClass = 'session-status-ready';
            statusLabel = 'Takeover';
        } else {
            statusClass = 'session-status-ready';
            statusLabel = 'Ready';
        }
    }

    app.elements.sessionStatus.innerHTML = `Status: <strong class="session-status-badge ${statusClass}">${statusLabel}</strong>`;

    const buttons = [app.elements.pauseButton, app.elements.playButton, app.elements.takeoverButton];
    buttons.forEach((button) => {
        if (button) button.disabled = !isConnected;
    });

    if (app.elements.pauseButton) {
        app.elements.pauseButton.classList.toggle('mode-active', app.sessionMode === 'pause');
        app.elements.pauseButton.classList.remove('mode-active-play', 'mode-active-takeover');
    }

    if (app.elements.playButton) {
        app.elements.playButton.classList.toggle('mode-active', app.sessionMode === 'play');
        app.elements.playButton.classList.toggle('mode-active-play', app.sessionMode === 'play');
        app.elements.playButton.classList.remove('mode-active-takeover');
    }

    if (app.elements.takeoverButton) {
        app.elements.takeoverButton.classList.toggle('mode-active', app.sessionMode === 'takeover');
        app.elements.takeoverButton.classList.toggle('mode-active-takeover', app.sessionMode === 'takeover');
        app.elements.takeoverButton.classList.remove('mode-active-play');
    }

    updateTakeoverControls();
}

/**
 * Set up event listeners for UI elements
 */
function setupEventListeners() {
    // Session controls
    app.elements.playButton.addEventListener('click', () => setSessionMode('play'));
    app.elements.pauseButton.addEventListener('click', () => setSessionMode('pause'));
    app.elements.takeoverButton.addEventListener('click', () => setSessionMode('takeover'));
    app.elements.panicAllButton.addEventListener('click', onPanicAll);
    app.elements.qrOverlayToggle.addEventListener('click', toggleQrOverlay);
    app.elements.slotDurationApplyButton.addEventListener('click', onApplySlotDuration);
    app.elements.slotDurationInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            onApplySlotDuration();
        }
    });
    
    // Panel toggles
    app.elements.deviceConfigToggle.addEventListener('click', () => {
        deviceConfig.toggleVisibility();
    });
    
    app.elements.infoToggle.addEventListener('click', () => {
        app.elements.devicePanel.classList.toggle('hidden');
    });
    
    app.elements.statsToggle.addEventListener('click', () => {
        app.elements.statsPanel.classList.toggle('hidden');
    });
    
    // Copy URL button
    app.elements.copyUrlButton.addEventListener('click', onCopyUrl);

    if (app.elements.qrBaseUrlApplyButton) {
        app.elements.qrBaseUrlApplyButton.addEventListener('click', applyQrBaseUrlFromInput);
    }

    if (app.elements.qrBaseUrlInput) {
        app.elements.qrBaseUrlInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                applyQrBaseUrlFromInput();
            }
        });
    }

        if (app.elements.qrBaseUrlResetButton) {
            app.elements.qrBaseUrlResetButton.addEventListener('click', resetQrBaseUrlToDefault);
        }

    if (app.elements.takeoverFader) {
        app.elements.takeoverFader.value = '127';
        app.elements.takeoverFader.addEventListener('input', onTakeoverFaderInput);
    }
    
    // 'q' toggles the join QR overlay on the grid display (not while typing).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'q' && e.key !== 'Q') return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        const target = e.target;
        if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
        toggleQrOverlay();
    });
}

function parseDurationToSeconds(inputValue) {
    const value = (inputValue || '').trim();

    // Numeric shorthand support:
    // - <= 59 means seconds (00:SS)
    // - > 59 means total seconds converted to MM:SS
    if (/^\d+$/.test(value)) {
        const total = parseInt(value, 10);
        if (!Number.isFinite(total) || total <= 0) return null;
        return total;
    }

    const match = value.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) return null;

    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
    if (seconds < 0 || seconds > 59) return null;

    const total = (minutes * 60) + seconds;
    if (total <= 0) return null;
    return total;
}

function formatSecondsAsMMSS(totalSeconds) {
    const value = Math.max(0, parseInt(totalSeconds || 0, 10));
    const minutes = Math.floor(value / 60).toString().padStart(2, '0');
    const seconds = (value % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function onApplySlotDuration() {
    if (!app.socket || !app.socket.connected) {
        showError('Connect to the session before applying slot time.');
        return;
    }

    const seconds = parseDurationToSeconds(app.elements.slotDurationInput.value);
    if (!seconds) {
        showError('Slot time must use MM:SS format (example: 01:00).');
        return;
    }

    // Normalize any accepted input format back to MM:SS in the UI.
    app.elements.slotDurationInput.value = formatSecondsAsMMSS(seconds);

    app.socket.emit('set-turn-duration', { seconds });
}

function onSlotDurationUpdated(data) {
    const seconds = parseInt(data?.seconds, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return;

    app.slotDurationSec = seconds;
    if (app.elements.slotDurationInput) {
        app.elements.slotDurationInput.value = formatSecondsAsMMSS(seconds);
    }
}

// ===== SOCKET EVENT HANDLERS =====

function onSocketConnect() {
    console.log('Socket connected:', app.socket.id);
    updateSessionStatus();
    showInfo('Connected to session: ' + app.sessionName);

    // Send current devices to server for auto-assignment
    syncConfiguredDevicesToServer();
    emitQrBaseUrlToServer();
}

function onSocketDisconnect() {
    console.log('Socket disconnected');
    app.sessionMode = 'pause';
    app.isPlaying = false;
    updateSessionStatus();
    showError('Disconnected from server');
}

function onTrackJoined(data) {
    console.log('Track joined:', data);
    const trackId = data.slot.toString();
    
    // Add track to routing matrix
    app.routingMatrix.addTrack(trackId, data.socketID, data.initials);

    // If server assignment arrived before this track row existed, apply it now.
    applyServerAssignmentsToRoutingMatrix();
    
    // Update UI
    updateRoutingMatrix();
    updateStatistics();
}

function onTrackLeft(data) {
    console.log('Track left:', data);
    const trackId = data.slot.toString();
    
    // Handle disconnect in MIDI router (sends note offs)
    if (app.midiRouter) {
        app.midiRouter.handleTrackDisconnect(trackId);
    }
    
    // Remove track from routing matrix
    app.routingMatrix.removeTrack(trackId);
    
    // Update UI
    updateRoutingMatrix();
    updateStatistics();
}

function onTrackMidiMessage(data) {
    if (!app.midiRouter) return;
    if (data.type && data.type !== 'MIDI') return; // routed transport is protocol-neutral

    // Find track by socket ID
    const trackId = app.routingMatrix.findTrackBySocketId(data.socketID);
    if (!trackId) {
        console.warn('Received MIDI message from unknown track:', data.socketID);
        return;
    }
    
    // Route the MIDI message
    const success = app.midiRouter.routeMessage(
        trackId, 
        new Uint8Array(data.message), 
        data.timestamp || performance.now()
    );
    
    if (success) {
        // Flash visual feedback for the track
        flashTrackActivity(trackId);
    }
    
    // Update statistics periodically
    if (Date.now() - app.lastStatsUpdate > app.statsUpdateInterval) {
        updateStatistics();
        app.lastStatsUpdate = Date.now();
    }
}

function onGetTrackAssignment(data) {
    console.log('=== onGetTrackAssignment called ===');
    console.log('Track assignment request:', data);
    
    try {
        // Find track information
        const trackId = data.track.toString();
        const routing = app.routingMatrix ? app.routingMatrix.getRouting(trackId) : null;
        const track = app.routingMatrix ? app.routingMatrix.getTrack(trackId) : null;
        
        if (!track) {
            console.warn('Track assignment request for unknown track:', trackId);
            // Still send a response with no device
            app.socket.emit('track-assignment', {
                socketID: data.socketID,
                device: null,
                channel: 0,
                trackId: trackId,
                trackNumber: parseInt(trackId) + 1
            });
            return;
        }
        
        // Get actual device assignment from routing
        let deviceInfo = null;
        if (routing && routing.device) {
            console.log('Found device assignment in routing:', routing.device);
            // Get device info from deviceConfig
            deviceInfo = deviceConfig.getDeviceInfo(routing.device);
            console.log('Device info retrieved:', deviceInfo);
            console.log('Device controllers from deviceConfig:', deviceInfo?.controllers);
            console.log('Device controls from deviceConfig:', deviceInfo?.controls);
        }
        
        // Send assignment data with actual device info
        const assignmentData = {
            socketID: data.socketID,
            device: deviceInfo,
            channel: routing ? routing.channel : 0,
            trackId: trackId,
            trackNumber: parseInt(trackId) + 1
        };
        
        console.log('Sending track assignment:', assignmentData);
        app.socket.emit('track-assignment', assignmentData);
        
    } catch (error) {
        console.error('Error in onGetTrackAssignment:', error);
    }
}

function onSequencerExists(data) {
    showError('Session already has a sequencer: ' + data.reason);
    setTimeout(() => {
        window.location.href = '/';
    }, 3000);
}

function onSocketError(error) {
    console.error('Socket error:', error);
    updateSessionStatus();
    showError('Socket error: ' + error.message);
}

function applyServerAssignmentsToRoutingMatrix() {
    if (!app.routingMatrix || !deviceConfig) return;

    const assignments = app.deviceAssignments || {};
    const assignedTrackIds = new Set(Object.keys(assignments).map(id => id.toString()));

    app.isApplyingServerAssignments = true;

    try {
        // Apply authoritative server assignments to the routing matrix.
        Object.entries(assignments).forEach(([trackId, assignment]) => {
            if (!assignment || assignment.deviceId === undefined || assignment.deviceId === null) return;

            const configuredDevice = deviceConfig.getDeviceConfig(assignment.deviceId);
            const channel = (configuredDevice && Number.isInteger(configuredDevice.assignedChannel))
                ? configuredDevice.assignedChannel - 1
                : 0;

            app.routingMatrix.updateRouting(trackId.toString(), {
                deviceId: `device:${assignment.deviceId}`,
                channel,
                enabled: true,
                channelLocked: true
            });
        });

        // Clear routing for active tracks that no longer have an assignment.
        const activeTracks = app.routingMatrix.getAllTracks();
        for (const [trackId] of activeTracks) {
            if (!assignedTrackIds.has(trackId.toString())) {
                app.routingMatrix.updateRouting(trackId.toString(), {
                    deviceId: null,
                    enabled: false,
                    channelLocked: false
                });
            }
        }
    } finally {
        app.isApplyingServerAssignments = false;
    }
}

function onDeviceAssignmentsUpdated(data) {
    console.log('Device assignments updated:', data.assignments);
    
    // Store assignments in app for UI updates
    app.deviceAssignments = data.assignments || {};

    // Keep routing matrix in sync with server-side assignment truth.
    applyServerAssignmentsToRoutingMatrix();
    
    // Update device configuration table to show assigned users
    if (deviceConfig) {
        deviceConfig.updateAssignedUsers(app.deviceAssignments);
    }

    updateRoutingMatrix();
    renderRuntimeStateDiagnostics();
}

function onDeviceRuntimeStateUpdated(data) {
    app.deviceRuntimeStates = data?.deviceStates || {};
    renderRuntimeStateDiagnostics();
}

function onQueueUpdated(data) {
    const queueLength = Number.isFinite(parseInt(data?.length, 10)) ? parseInt(data.length, 10) : 0;
    const activeSlots = Number.isFinite(parseInt(data?.activeSlots, 10)) ? parseInt(data.activeSlots, 10) : 0;
    const nextInitials = (data?.nextInitials && `${data.nextInitials}`.trim().length > 0)
        ? `${data.nextInitials}`
        : '---';

    if (app.elements.queueLength) {
        app.elements.queueLength.innerHTML = `Queue: <strong>${queueLength}</strong>`;
    }
    if (app.elements.activeSlots) {
        app.elements.activeSlots.innerHTML = `Active Slots: <strong>${activeSlots}</strong>`;
    }
    if (app.elements.nextInQueue) {
        app.elements.nextInQueue.innerHTML = `Next: <strong>${nextInitials}</strong>`;
    }
}

function onTakeoverStateUpdated(data) {
    const takeover = data?.takeover || {};
    const value = clampMidiValue(takeover.value);

    app.takeover.value = value;

    updateTakeoverControls();
}

function onSessionModeUpdated(data) {
    const incomingMode = data?.mode;
    if (incomingMode === 'play' || incomingMode === 'pause' || incomingMode === 'takeover') {
        app.sessionMode = incomingMode;
        app.isPlaying = incomingMode === 'play';
    }

    updateSessionStatus();
}

function onTakeoverError(data) {
    showError(data?.reason || 'Unable to apply Takeover change.');
    updateTakeoverControls();
}

// ===== MIDI EVENT HANDLERS =====

function onDeviceChange(data) {
    console.log('MIDI interface change:', data);
    updateDeviceList();
    
    if (data.type === 'connected') {
        showInfo('MIDI interface connected: ' + data.device.name);
    } else if (data.type === 'disconnected') {
        showInfo('MIDI interface disconnected: ' + data.device.name);
    }
}

function onTrackChange(action, trackId, track) {
    console.log('Track change:', action, trackId, track);
    updateRoutingMatrix();
}

function onRoutingChange(trackId, routing) {
    console.log('Routing change:', trackId, routing);

    if (app.isApplyingServerAssignments) {
        console.log('Routing change suppressed while applying server assignments');
        return;
    }
    
    // Send updated assignment to the track when routing changes
    const track = app.routingMatrix.getTrack(trackId);
    console.log('Track info for routing change:', track);
    
    if (track && track.socketId) {
        // Get device information if assigned
        let deviceInfo = null;
        if (routing && routing.deviceId && routing.enabled) {
            console.log('Routing change - device assigned:', routing.deviceId, 'enabled:', routing.enabled);
            
            // Handle different device ID formats
            let actualDeviceId = routing.deviceId;
            if (routing.deviceId.startsWith('device:')) {
                actualDeviceId = parseInt(routing.deviceId.replace('device:', ''));
                console.log('Parsed device ID from device: format:', actualDeviceId);
            }
            
            if (deviceConfig) {
                const configuredDevice = deviceConfig.getDeviceConfig(actualDeviceId);
                console.log('Configured device from config:', configuredDevice);
                if (configuredDevice) {
                    // Handle both new custom devices and old database devices
                    let availableControls = null;
                    
                    if (configuredDevice.controllers && configuredDevice.controllers.length > 0) {
                        // New custom device format - use the controllers directly
                        console.log('Using custom device controllers:', configuredDevice.controllers);
                        // Don't set availableControls here - we'll use controllers property instead
                    } else {
                        // Old database format - try to get controls from database
                        const fullDeviceData = deviceConfig.deviceDatabase ? deviceConfig.deviceDatabase[actualDeviceId] : null;
                        console.log('Full device data from database:', fullDeviceData);
                        
                        if (fullDeviceData && fullDeviceData.controls && configuredDevice.selectedControllers && configuredDevice.selectedControllers.length > 0) {
                            availableControls = fullDeviceData.controls.filter(control => 
                                configuredDevice.selectedControllers.includes(control.cc_number)
                            );
                            console.log('Filtered controls for track:', availableControls);
                        } else if (fullDeviceData && fullDeviceData.controls) {
                            console.log('No selected controllers, using all available controls');
                            availableControls = fullDeviceData.controls;
                        }
                    }
                    
                    deviceInfo = {
                        id: routing.deviceId,
                        name: configuredDevice.name || 'Unknown Device',
                        color: configuredDevice.color, // Include device color
                        interface: configuredDevice.assignedInterface,
                        controls: availableControls,
                        controllers: configuredDevice.controllers || [] // Include custom controllers
                    };
                    console.log('Created device info:', deviceInfo);
                }
            } else {
                console.warn('deviceConfig not available');
            }
        } else {
            console.log('No device assigned or not enabled. DeviceId:', routing?.deviceId, 'Enabled:', routing?.enabled);
        }
        
        // Send updated assignment to track
        const assignmentData = {
            socketID: track.socketId,
            device: deviceInfo,
            channel: routing ? routing.channel : 0,
            trackId: trackId,
            trackNumber: parseInt(trackId) + 1
        };
        
        console.log('Sending routing change assignment update:', assignmentData);
        app.socket.emit('track-assignment', assignmentData);
    }
}

// ===== UI EVENT HANDLERS =====

function setSessionMode(mode) {
    if (!app.socket?.connected) {
        app.sessionMode = 'pause';
        app.isPlaying = false;
        updateSessionStatus();
        showError('Session is not ready. Reconnect to the backend before changing mode.');
        return;
    }

    if (mode !== 'takeover') {
        app.takeover.value = 127;
    }

    app.sessionMode = mode;
    app.isPlaying = mode === 'play';
    updateSessionStatus();
    updateTakeoverControls();

    if (mode === 'play') {
        app.socket.emit('session-play', { socketID: app.socket.id });
        showInfo('Session mode: Play');
        return;
    }

    if (mode === 'pause') {
        app.socket.emit('session-pause', { socketID: app.socket.id });
        showInfo('Session mode: Pause');
        return;
    }

    const value = clampMidiValue(app.elements.takeoverFader?.value ?? app.takeover.value);
    app.takeover.value = value;
    app.socket.emit('set-takeover-state', {
        enabled: true,
        value
    });
    showInfo('Session mode: Takeover');
}
    
function onTakeoverFaderInput(event) {
    const value = clampMidiValue(event?.target?.value);

    if (app.elements.takeoverValue) {
        app.elements.takeoverValue.textContent = String(value);
    }

    app.takeover.value = value;

    if (app.sessionMode !== 'takeover') {
        return;
    }

    applyTakeoverValueToConfiguredOutputs(value);

    if (app.socket?.connected) {
        app.socket.emit('set-takeover-value', { value });
    }
}

function updateTakeoverControls() {
    const fader = app.elements.takeoverFader;
    const valueLabel = app.elements.takeoverValue;
    const hint = app.elements.takeoverHint;
    const isConnected = Boolean(app.socket?.connected);

    if (fader) {
        fader.value = String(clampMidiValue(app.takeover.value));
        fader.disabled = !isConnected || app.sessionMode !== 'takeover';
    }

    if (valueLabel) {
        valueLabel.textContent = String(clampMidiValue(app.takeover.value));
    }

    if (hint) {
        if (!isConnected) {
            hint.textContent = 'Connect sequencer to use Takeover.';
        } else if (app.sessionMode === 'takeover') {
            hint.textContent = 'Takeover active. All users are queued until mode changes.';
        } else {
            hint.textContent = 'Ready. Enable Takeover to control all configured controllers.';
        }
    }
}

function clampMidiValue(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(127, parsed));
}

function applyTakeoverValueToConfiguredOutputs(value) {
    if (!app.midiDeviceManager || !deviceConfig) return;

    const midiValue = clampMidiValue(value);
    const configuredDevices = deviceConfig.getConfiguredDevices() || [];

    configuredDevices.forEach((device) => {
        if (!device || !device.assignedInterface) return;

        const targetChannel = Number.isFinite(parseInt(device.assignedChannel, 10))
            ? Math.max(0, Math.min(15, parseInt(device.assignedChannel, 10) - 1))
            : 0;

        const controllers = Array.isArray(device.controllers) ? device.controllers : [];
        controllers.forEach((controller) => {
            const ccNumber = parseInt(
                controller?.ccNumber !== undefined ? controller.ccNumber : controller?.cc_number,
                10
            );
            if (!Number.isFinite(ccNumber)) return;

            const message = new Uint8Array([0xB0, ccNumber, midiValue]);
            app.midiDeviceManager.sendMidiMessageToChannel(
                device.assignedInterface,
                message,
                targetChannel,
                performance.now()
            );
        });
    });
}

function onPanicAll() {
    if (app.midiRouter) {
        const panicCount = app.midiRouter.sendAllTracksPanic();
        showInfo(`Panic sent to ${panicCount} tracks`);
    }
}

function onCopyUrl() {
    const url = app.elements.trackUrl.textContent;
    navigator.clipboard.writeText(url).then(() => {
        showInfo('URL copied to clipboard!');
        app.elements.copyUrlButton.textContent = '✓';
        setTimeout(() => {
            app.elements.copyUrlButton.textContent = '📋';
        }, 2000);
    }).catch(() => {
        showError('Failed to copy URL to clipboard');
    });
}

// Join QR overlay on the grid display. The server holds the state and
// broadcasts every change, so the button follows toggles made on the grid.
function toggleQrOverlay() {
    if (!app.socket || !app.socket.connected) {
        showError('Connect to the session before showing the QR code.');
        return;
    }
    app.socket.emit('set-qr-overlay', { visible: !app.qrOverlayVisible });
}

function onQrOverlayUpdated(msg) {
    app.qrOverlayVisible = Boolean(msg && msg.visible);
    app.elements.qrOverlayToggle.textContent = app.qrOverlayVisible ? '📱 Hide QR Code' : '📱 Show QR Code';
    app.elements.qrOverlayToggle.classList.toggle('active', app.qrOverlayVisible);
}

// ===== UI UPDATE FUNCTIONS =====

function updateSessionInfo() {
    if (app.elements.sessionName) {
        app.elements.sessionName.textContent = app.sessionName || '-';
    }

    updateSessionStatus();
}

function updateTrackUrl() {
    const trackUrl = buildTrackUrlFromBase(app.qrBaseUrl);
    
    if (app.elements.trackUrl) {
        app.elements.trackUrl.textContent = trackUrl;
    }
}

function updateDeviceList() {
    if (!app.midiDeviceManager || !app.elements.deviceList) return;
    
    const devices = app.midiDeviceManager.getOutputDevicesList();
    const status = app.midiDeviceManager.getStatus();
    
    // Update device status
    if (app.elements.deviceStatus) {
        if (status.supported) {
            app.elements.deviceStatus.innerHTML = `
                <div>✅ Web MIDI supported - ${status.connectedOutputs} of ${status.outputCount} devices connected</div>
            `;
        } else {
            app.elements.deviceStatus.innerHTML = `
                <div>❌ Web MIDI not supported in this browser</div>
            `;
        }
    }
    
    // Update device list
    app.elements.deviceList.innerHTML = '';
    
    if (devices.length === 0) {
        app.elements.deviceList.innerHTML = `
            <div class="device-item">
                <div class="device-status-indicator disconnected"></div>
                <div class="device-info">
                    <div class="device-name">No MIDI interfaces detected</div>
                    <div class="device-manufacturer">Connect a MIDI interface or synthesizer</div>
                </div>
            </div>
        `;
    } else {
        devices.forEach(device => {
            const deviceElement = document.createElement('div');
            deviceElement.className = 'device-item';
            deviceElement.innerHTML = `
                <div class="device-status-indicator ${device.state === 'connected' ? '' : 'disconnected'}"></div>
                <div class="device-info">
                    <div class="device-name">${device.name}</div>
                    <div class="device-manufacturer">${device.manufacturer}</div>
                </div>
            `;
            app.elements.deviceList.appendChild(deviceElement);
        });
    }
    
    // Update device configuration with available interfaces
    if (deviceConfig) {
        const interfaces = devices.map(device => ({
            id: device.id,
            name: device.name,
            manufacturer: device.manufacturer,
            state: device.state
        }));
        deviceConfig.updateAvailableInterfaces(interfaces);
    }
}

function updateRoutingMatrix() {
    if (!app.routingMatrix || !app.elements.routingTableBody) return;
    
    const matrixData = app.routingMatrix.getMatrixData();
    const devices = app.midiDeviceManager ? app.midiDeviceManager.getOutputDevicesList() : [];
    
    // Clear existing rows
    app.elements.routingTableBody.innerHTML = '';
    
    if (matrixData.length === 0) {
        // Show empty state message (URL remains always visible)
        app.elements.noTracksMessage.style.display = 'block';
        return;
    }
    
    // Hide empty state message (URL remains always visible)
    app.elements.noTracksMessage.style.display = 'none';
    
    // Create rows for each track
    matrixData.forEach(track => {
        const row = createTrackRow(track, devices);
        app.elements.routingTableBody.appendChild(row);
    });
}

function createTrackRow(track, devices) {
    const row = document.createElement('tr');
    row.setAttribute('data-track-id', track.trackId);
    
    // Track number
    const trackNumCell = document.createElement('td');
    trackNumCell.innerHTML = `<span class="track-number">${track.trackNumber}</span>`;
    row.appendChild(trackNumCell);
    
    // User initials
    const initialsCell = document.createElement('td');
    initialsCell.innerHTML = `<span class="user-initials">${track.initials}</span>`;
    row.appendChild(initialsCell);
    
    // Status
    const statusCell = document.createElement('td');
    statusCell.innerHTML = `<span class="track-status ${track.status}">${track.status}</span>`;
    row.appendChild(statusCell);
    
    // Device selector
    const deviceCell = document.createElement('td');
    const deviceSelect = createDeviceSelect(track, devices);
    deviceCell.appendChild(deviceSelect);
    row.appendChild(deviceCell);
    
    // Channel selector
    const channelCell = document.createElement('td');
    const channelSelect = createChannelSelect(track);
    channelCell.appendChild(channelSelect);
    row.appendChild(channelCell);
    
    // Actions
    const actionsCell = document.createElement('td');
    const actionButtons = createActionButtons(track);
    actionsCell.appendChild(actionButtons);
    row.appendChild(actionsCell);
    
    return row;
}

function createDeviceSelect(track, devices) {
    const select = document.createElement('select');
    select.className = 'routing-select';
    select.disabled = track.status !== 'connected';
    
    // Add default option
    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Select Output...';
    select.appendChild(defaultOption);
    
    // Add configured devices first (if any)
    if (deviceConfig) {
        const configuredDevices = deviceConfig.getConfiguredDevices();
        if (configuredDevices.length > 0) {
            // Add separator
            const separator = document.createElement('option');
            separator.disabled = true;
            separator.textContent = '── Configured Devices ──';
            select.appendChild(separator);
            
            configuredDevices.forEach(device => {
                const option = document.createElement('option');
                option.value = `device:${device.id}`;
                option.textContent = `${device.name} (Ch ${device.assignedChannel})`;
                
                // Check if assigned interface is valid and connected
                const hasValidInterface = device.assignedInterface && 
                    devices.some(d => d.id === device.assignedInterface && d.state === 'connected');
                
                option.disabled = !hasValidInterface;
                
                if (track.deviceId === `device:${device.id}`) {
                    option.selected = true;
                }
                
                select.appendChild(option);
            });
        }
    }
    
    // Add raw MIDI interfaces
    if (devices.length > 0) {
        // Add separator
        const separator = document.createElement('option');
        separator.disabled = true;
        separator.textContent = '── MIDI Interfaces ──';
        select.appendChild(separator);
        
        devices.forEach(device => {
            const option = document.createElement('option');
            option.value = `interface:${device.id}`;
            option.textContent = device.displayName;
            option.disabled = device.state !== 'connected';
            
            if (track.deviceId === `interface:${device.id}`) {
                option.selected = true;
            }
            
            select.appendChild(option);
        });
    }
    
    // Event handler
    select.addEventListener('change', (e) => {
        const deviceId = e.target.value || null;
        const enabled = deviceId !== null;
        
        let channel = track.channel || 1;
        let channelLocked = false;
        
        // Handle different device types
        if (enabled && deviceId) {
            if (deviceId.startsWith('device:')) {
                // Configured device - use assigned channel
                const configDeviceId = parseInt(deviceId.replace('device:', ''));
                const configuredDevice = deviceConfig?.getDeviceConfig(configDeviceId);
                if (configuredDevice) {
                    // Convert from 1-based (device config) to 0-based (routing matrix)
                    channel = configuredDevice.assignedChannel - 1;
                    channelLocked = true;
                }
            } else if (deviceId.startsWith('interface:')) {
                // Raw interface - auto-assign available channel
                const interfaceId = deviceId.replace('interface:', '');
                const availableChannel = app.routingMatrix.getNextAvailableChannel(interfaceId);
                if (availableChannel >= 0) {
                    channel = availableChannel;
                }
            }
        }
        
        console.log('Device selection changed for track', track.trackId, 'to deviceId:', deviceId, 'enabled:', enabled);
        
        app.routingMatrix.updateRouting(track.trackId, {
            deviceId: deviceId,
            channel: channel,
            channelLocked: channelLocked,
            enabled: enabled
        });
        
        updateRoutingMatrix();
    });
    
    return select;
}

function createChannelSelect(track) {
    const select = document.createElement('select');
    select.className = 'routing-select';
    
    // Check if channel is locked (configured device)
    const isChannelLocked = track.channelLocked || false;
    
    select.disabled = !track.enabled || track.status !== 'connected' || isChannelLocked;
    
    // Add locked indicator if needed
    if (isChannelLocked) {
        select.classList.add('channel-locked');
        select.title = 'Channel locked by device configuration';
    }
    
    // Add channel options (1-16)
    for (let i = 0; i < 16; i++) {
        const option = document.createElement('option');
        option.value = i;
        option.textContent = (i + 1).toString();
        
        if (track.channel === i) {
            option.selected = true;
        }
        
        select.appendChild(option);
    }
    
    // Event handler (only if not locked)
    if (!isChannelLocked) {
        select.addEventListener('change', (e) => {
            const channel = parseInt(e.target.value);
            app.routingMatrix.updateRouting(track.trackId, { channel: channel });
        });
    }
    
    return select;
}

function createActionButtons(track) {
    const container = document.createElement('div');
    container.className = 'action-buttons';
    
    // Test button
    const testBtn = document.createElement('button');
    testBtn.className = 'action-btn test-btn';
    testBtn.innerHTML = 'Test';
    testBtn.title = 'Send test note';
    testBtn.disabled = !track.enabled || track.status !== 'connected';
    
    testBtn.addEventListener('click', () => {
        if (app.midiRouter) {
            app.midiRouter.sendTestMessage(track.trackId);
            flashTrackActivity(track.trackId);
        }
    });
    
    container.appendChild(testBtn);
    
    // Panic button
    const panicBtn = document.createElement('button');
    panicBtn.className = 'action-btn panic-btn';
    panicBtn.innerHTML = 'Panic';
    panicBtn.title = 'Send panic (all notes off)';
    panicBtn.disabled = !track.enabled || track.status !== 'connected';
    
    panicBtn.addEventListener('click', () => {
        if (app.midiRouter) {
            app.midiRouter.sendTrackPanic(track.trackId);
        }
    });
    
    container.appendChild(panicBtn);
    
    return container;
}

function updateStatistics() {
    if (!app.midiRouter || !app.routingMatrix) return;
    
    const stats = app.midiRouter.getStats();
    const matrixStats = app.routingMatrix.getStats();
    
    // Update statistics display
    if (app.elements.statActiveTracks) {
        app.elements.statActiveTracks.textContent = matrixStats.activeTracks;
    }
    if (app.elements.statRoutedTracks) {
        app.elements.statRoutedTracks.textContent = matrixStats.routedTracks;
    }
    if (app.elements.statMessagesRouted) {
        app.elements.statMessagesRouted.textContent = stats.messagesRouted;
    }
    if (app.elements.statRoutingErrors) {
        app.elements.statRoutingErrors.textContent = stats.routingErrors;
    }

    renderRuntimeStateDiagnostics();
}

function renderRuntimeStateDiagnostics() {
    const listElement = app.elements.runtimeStatesList;
    const emptyElement = app.elements.runtimeStatesEmpty;
    if (!listElement || !emptyElement) return;

    const states = app.deviceRuntimeStates || {};
    const entries = Object.entries(states)
        .filter(([, state]) => state && state.controllers && Object.keys(state.controllers).length > 0)
        .sort((a, b) => parseInt(a[0], 10) - parseInt(b[0], 10));

    if (entries.length === 0) {
        listElement.innerHTML = '';
        emptyElement.style.display = 'block';
        return;
    }

    emptyElement.style.display = 'none';

    const configuredById = new Map(
        (deviceConfig?.getConfiguredDevices?.() || []).map(device => [String(device.id), device])
    );

    listElement.innerHTML = entries.map(([deviceId, state]) => {
        const configured = configuredById.get(String(deviceId));
        const name = configured?.name || `Device ${deviceId}`;
        const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString() : '--';
        const controllerItems = Object.entries(state.controllers || {})
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([key, value]) => `<li class="runtime-controller-item">${escapeHtml(key)} = ${escapeHtml(String(value))}</li>`)
            .join('');

        return `
            <div class="runtime-device-card">
              <div class="runtime-device-title">
                <span>${escapeHtml(name)}</span>
                <span class="runtime-device-updated">Updated ${escapeHtml(updated)}</span>
              </div>
              <ul class="runtime-controller-list">
                ${controllerItems}
              </ul>
            </div>
        `;
    }).join('');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function flashTrackActivity(trackId) {
    const row = document.querySelector(`tr[data-track-id="${trackId}"]`);
    if (row) {
        row.classList.add('status-change');
        setTimeout(() => {
            row.classList.remove('status-change');
        }, 600);
    }
}

// ===== UTILITY FUNCTIONS =====

function showError(message) {
    console.error(message);
    if (app.elements.errorMessage) {
        app.elements.errorMessage.textContent = message;
        app.elements.errorMessage.classList.remove('hidden');
        
        setTimeout(() => {
            app.elements.errorMessage.classList.add('hidden');
        }, 5000);
    }
}

function showInfo(message) {
    console.info(message);
    if (app.elements.infoMessage) {
        app.elements.infoMessage.textContent = message;
        app.elements.infoMessage.classList.remove('hidden');
        
        setTimeout(() => {
            app.elements.infoMessage.classList.add('hidden');
        }, 3000);
    }
}

// Expose functions globally for inter-module communication
window.updateRoutingMatrix = updateRoutingMatrix;
window.deviceConfig = () => deviceConfig;
window.app = app;
window.syncConfiguredDevicesToServer = syncConfiguredDevicesToServer;