const publicApp = {
    sessionName: null,
    qrBaseUrl: window.location.origin,
    socket: null,
    currentStream: null,
    devices: [],
    assignments: {},
    queue: [],
    splitState: {
        left: 0.62,
        right: 0.7
    },
    splitDrag: null,
    cameraFlipped: false,
    wifiViewActive: false,
    wifiSsid: 'pedaleracaotica',
    wifiPassword: 'pedaleracaotica',
    elements: {}
};

const SPLIT_STORAGE_KEY = 'midisocket.publicDashboard.splits.v1';
const FLIP_STORAGE_KEY = 'midisocket.publicDashboard.cameraFlipped.v1';
const SPLIT_CONFIG = {
    left: { defaultTop: 0.62, minTop: 0.2, maxTop: 0.8, keyboardStep: 0.02, keyboardStepLarge: 0.05 },
    right: { defaultTop: 0.7, minTop: 0.2, maxTop: 0.85, keyboardStep: 0.02, keyboardStepLarge: 0.05 }
};

document.addEventListener('DOMContentLoaded', () => {
    initializePublicDashboard();
});

function initializePublicDashboard() {
    const params = new URLSearchParams(window.location.search);
    publicApp.sessionName = params.get('session') || '';
    publicApp.wifiSsid = params.get('wifi_ssid') || publicApp.wifiSsid;
    publicApp.wifiPassword = params.get('wifi_password') || publicApp.wifiPassword;

    cacheElements();
    loadSplitState();
    applySplitState();
    loadCameraFlipState();
    renderWifiQrCode();
    setupSplitControls();
    publicApp.elements.sessionLabel.textContent = `Session: ${publicApp.sessionName || '--'}`;
    updateJoinQr();
    initializeSocket();
    setupEventListeners();
    loadAvailableCameras();
}

function cacheElements() {
    publicApp.elements = {
        sessionLabel: document.getElementById('session-label'),
        connectionStatus: document.getElementById('connection-status'),
        queueSummary: document.getElementById('queue-summary'),
        slotSummary: document.getElementById('slot-summary'),
        deviceTableBody: document.getElementById('device-table-body'),
        queueList: document.getElementById('queue-list'),
        qrImage: document.getElementById('qr-image'),
        joinUrl: document.getElementById('join-url'),
        cameraSelect: document.getElementById('camera-select'),
        startCameraButton: document.getElementById('start-camera'),
        stopCameraButton: document.getElementById('stop-camera'),
        flipCameraButton: document.getElementById('flip-camera'),
        cameraFeed: document.getElementById('camera-feed'),
        cameraMessage: document.getElementById('camera-message'),
        wifiView: document.getElementById('wifi-view'),
        wifiQrImage: document.getElementById('wifi-qr-image'),
        wifiSsidText: document.getElementById('wifi-ssid-text'),
        wifiPasswordText: document.getElementById('wifi-password-text')
    };
}

function initializeSocket() {
    publicApp.socket = io('', {
        query: {
            session: publicApp.sessionName,
            role: 'public'
        }
    });

    publicApp.socket.on('connect', onSocketConnect);
    publicApp.socket.on('disconnect', onSocketDisconnect);
    publicApp.socket.on('session-unavailable', onExitSession);
    publicApp.socket.on('session-ended', onExitSession);
    publicApp.socket.on('public-session-snapshot', onPublicSessionSnapshot);
    publicApp.socket.on('public-device-assignments-updated', onDeviceAssignmentsUpdated);
    publicApp.socket.on('queue-updated', onQueueUpdated);
    publicApp.socket.on('qr-base-url-updated', onQrBaseUrlUpdated);
}

function setupEventListeners() {
    publicApp.elements.startCameraButton.addEventListener('click', startCamera);
    publicApp.elements.stopCameraButton.addEventListener('click', stopCamera);
    publicApp.elements.flipCameraButton.addEventListener('click', toggleCameraFlip);

    window.addEventListener('keydown', onWindowKeyDown);
}

function setupSplitControls() {
    const splitters = document.querySelectorAll('.splitter');
    splitters.forEach((splitter) => {
        splitter.addEventListener('pointerdown', onSplitterPointerDown);
        splitter.addEventListener('keydown', onSplitterKeyDown);
        updateSplitterAria(splitter.dataset.column, splitter);
    });

    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
}

function onSocketConnect() {
    if (publicApp.elements.connectionStatus) {
        publicApp.elements.connectionStatus.textContent = 'Connected';
    }
    publicApp.socket.emit('request-public-session-snapshot');
}

function onSocketDisconnect() {
    if (publicApp.elements.connectionStatus) {
        publicApp.elements.connectionStatus.textContent = 'Disconnected';
    }
}

function loadSplitState() {
    publicApp.splitState = {
        left: SPLIT_CONFIG.left.defaultTop,
        right: SPLIT_CONFIG.right.defaultTop
    };

    try {
        const stored = window.localStorage.getItem(SPLIT_STORAGE_KEY);
        if (!stored) {
            return;
        }

        const parsed = JSON.parse(stored);
        ['left', 'right'].forEach((column) => {
            const value = Number(parsed?.[column]);
            if (Number.isFinite(value)) {
                publicApp.splitState[column] = clampSplitValue(column, value);
            }
        });
    } catch (error) {
        // Ignore storage failures and fall back to defaults.
    }
}

function saveSplitState() {
    try {
        window.localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(publicApp.splitState));
    } catch (error) {
        // Ignore storage failures.
    }
}

function loadCameraFlipState() {
    try {
        publicApp.cameraFlipped = window.localStorage.getItem(FLIP_STORAGE_KEY) === 'true';
    } catch (error) {
        publicApp.cameraFlipped = false;
    }
    applyCameraFlipState();
}

function applyCameraFlipState() {
    publicApp.elements.cameraFeed.classList.toggle('flipped', publicApp.cameraFlipped);
    publicApp.elements.flipCameraButton.textContent = publicApp.cameraFlipped ? 'Unflip' : 'Flip';
}

function toggleCameraFlip() {
    publicApp.cameraFlipped = !publicApp.cameraFlipped;
    try {
        window.localStorage.setItem(FLIP_STORAGE_KEY, String(publicApp.cameraFlipped));
    } catch (error) {
        // Ignore storage failures.
    }
    applyCameraFlipState();
}

function renderWifiQrCode() {
    const ssid = publicApp.wifiSsid;
    const password = publicApp.wifiPassword;
    publicApp.elements.wifiSsidText.textContent = ssid;
    publicApp.elements.wifiPasswordText.textContent = password;
    renderQrCodeToImage(publicApp.elements.wifiQrImage, `WIFI:T:WPA;S:${ssid};P:${password};;`, { width: 512 });
}

function toggleWifiView() {
    publicApp.wifiViewActive = !publicApp.wifiViewActive;
    publicApp.elements.wifiView.classList.toggle('hidden', !publicApp.wifiViewActive);
}

function applySplitState() {
    document.documentElement.style.setProperty('--left-top-height', `${Math.round(publicApp.splitState.left * 100)}%`);
    document.documentElement.style.setProperty('--right-top-height', `${Math.round(publicApp.splitState.right * 100)}%`);

    updateSplitterAria('left');
    updateSplitterAria('right');
}

function clampSplitValue(column, value) {
    const config = SPLIT_CONFIG[column];
    return Math.min(config.maxTop, Math.max(config.minTop, value));
}

function updateSplitValue(column, value) {
    publicApp.splitState[column] = clampSplitValue(column, value);
    applySplitState();
    saveSplitState();
}

function resetSplitState() {
    publicApp.splitState.left = SPLIT_CONFIG.left.defaultTop;
    publicApp.splitState.right = SPLIT_CONFIG.right.defaultTop;
    applySplitState();
    saveSplitState();
}

function updateSplitterAria(column, splitterElement = null) {
    const element = splitterElement || document.querySelector(`.splitter[data-column="${column}"]`);
    if (!element) return;

    const ratio = publicApp.splitState[column] * 100;
    const config = SPLIT_CONFIG[column];
    element.setAttribute('aria-valuemin', Math.round(config.minTop * 100));
    element.setAttribute('aria-valuemax', Math.round(config.maxTop * 100));
    element.setAttribute('aria-valuenow', Math.round(ratio));
    element.setAttribute('aria-valuetext', `${Math.round(ratio)} percent top panel height`);
}

function onSplitterPointerDown(event) {
    const column = event.currentTarget.dataset.column;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    publicApp.splitDrag = {
        column,
        pointerId: event.pointerId
    };
    updateSplitFromPointer(event.clientY, column);
}

function onWindowPointerMove(event) {
    if (!publicApp.splitDrag || event.pointerId !== publicApp.splitDrag.pointerId) {
        return;
    }

    updateSplitFromPointer(event.clientY, publicApp.splitDrag.column);
}

function onWindowPointerUp(event) {
    if (!publicApp.splitDrag || event.pointerId !== publicApp.splitDrag.pointerId) {
        return;
    }

    publicApp.splitDrag = null;
}

function updateSplitFromPointer(clientY, column) {
    const columnElement = document.querySelector(`.dashboard-column[data-column="${column}"]`);
    if (!columnElement) return;

    const rect = columnElement.getBoundingClientRect();
    const ratio = (clientY - rect.top) / rect.height;
    updateSplitValue(column, ratio);
}

function onSplitterKeyDown(event) {
    const column = event.currentTarget.dataset.column;
    const config = SPLIT_CONFIG[column];
    const currentValue = publicApp.splitState[column];
    const step = event.shiftKey ? config.keyboardStepLarge : config.keyboardStep;

    if (event.key === 'ArrowUp') {
        event.preventDefault();
        updateSplitValue(column, currentValue + step);
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        updateSplitValue(column, currentValue - step);
    } else if (event.key === 'Home') {
        event.preventDefault();
        updateSplitValue(column, config.defaultTop);
    }
}

function onWindowKeyDown(event) {
    if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
    }

    const activeElement = document.activeElement;
    if (isTextInputContext(activeElement) && !(activeElement && activeElement.classList && activeElement.classList.contains('splitter'))) {
        return;
    }

    const key = event.key.toLowerCase();
    const leftStep = event.shiftKey ? SPLIT_CONFIG.left.keyboardStepLarge : SPLIT_CONFIG.left.keyboardStep;
    const rightStep = event.shiftKey ? SPLIT_CONFIG.right.keyboardStepLarge : SPLIT_CONFIG.right.keyboardStep;

    if (key === 'q') {
        event.preventDefault();
        updateSplitValue('left', publicApp.splitState.left - leftStep);
    } else if (key === 'a') {
        event.preventDefault();
        updateSplitValue('left', publicApp.splitState.left + leftStep);
    } else if (key === 'w') {
        event.preventDefault();
        updateSplitValue('right', publicApp.splitState.right - rightStep);
    } else if (key === 's') {
        event.preventDefault();
        updateSplitValue('right', publicApp.splitState.right + rightStep);
    } else if (key === '1') {
        event.preventDefault();
        if (publicApp.currentStream) {
            stopCamera();
        } else {
            startCamera();
        }
    } else if (key === '2') {
        event.preventDefault();
        toggleCameraFlip();
    } else if (key === 'z') {
        event.preventDefault();
        publicApp.splitState.left = 0.5;
        publicApp.splitState.right = 0.5;
        applySplitState();
        saveSplitState();
    } else if (key === 'x') {
        event.preventDefault();
        toggleWifiView();
    } else if (key === 'r') {
        if (activeElement && activeElement.classList && activeElement.classList.contains('splitter')) {
            event.preventDefault();
            resetSplitState();
        }
    }
}

function isTextInputContext(element) {
    if (!element) {
        return false;
    }

    const tagName = element.tagName ? element.tagName.toLowerCase() : '';
    return Boolean(
        element.isContentEditable ||
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        tagName === 'button'
    );
}

function onExitSession(data) {
    if (publicApp.elements.connectionStatus) {
        publicApp.elements.connectionStatus.textContent = 'Unavailable';
    }
    const reason = data && data.reason ? data.reason : 'Session unavailable.';
    publicApp.elements.joinUrl.textContent = reason;
}

function onPublicSessionSnapshot(data) {
    publicApp.devices = data.configuredDevices || [];
    publicApp.assignments = data.assignments || {};
    publicApp.queue = data.queue || [];
    publicApp.qrBaseUrl = normalizeQrBaseUrl(data?.qrBaseUrl) || window.location.origin;

    renderDevices();
    renderQueue();
    updateSummaries(data.length, data.activeSlots);
    updateJoinQr();
}

function onQrBaseUrlUpdated(data) {
    const normalized = normalizeQrBaseUrl(data?.baseUrl);
    if (!normalized) {
        return;
    }

    publicApp.qrBaseUrl = normalized;
    updateJoinQr();
}

function onDeviceAssignmentsUpdated(data) {
    publicApp.devices = data.configuredDevices || publicApp.devices;
    publicApp.assignments = data.assignments || {};
    renderDevices();
}

function onQueueUpdated(data) {
    publicApp.queue = data.queue || [];
    renderQueue();
    updateSummaries(data.length, data.activeSlots);
}

function updateSummaries(queueLength, activeSlots) {
    const totalQueue = Number.isFinite(parseInt(queueLength, 10))
        ? parseInt(queueLength, 10)
        : publicApp.queue.length;
    const totalSlots = Number.isFinite(parseInt(activeSlots, 10)) ? parseInt(activeSlots, 10) : 0;

    publicApp.elements.queueSummary.textContent = `Queue: ${totalQueue}`;
    publicApp.elements.slotSummary.textContent = `Active Slots: ${totalSlots}`;
}

function renderDevices() {
    const body = publicApp.elements.deviceTableBody;
    if (!body) {
        return;
    }

    if (!publicApp.devices.length) {
        body.innerHTML = '<tr><td colspan="2" class="empty-state-cell">No devices configured yet.</td></tr>';
        return;
    }

    const assignmentsByDeviceId = new Map();
    Object.values(publicApp.assignments || {}).forEach((assignment) => {
        if (assignment && assignment.deviceId !== undefined && assignment.deviceId !== null) {
            assignmentsByDeviceId.set(assignment.deviceId, assignment);
        }
    });

    body.innerHTML = publicApp.devices.map((device) => {
        const assignment = assignmentsByDeviceId.get(device.id) || null;
        const userLabel = assignment && assignment.userInitials ? escapeHtml(assignment.userInitials) : '---';
        const deviceColor = device && device.color ? device.color : '#718096';
        const photoCell = device.image
            ? `<img class="device-photo" src="${escapeAttribute(device.image)}" alt="${escapeAttribute(device.name || 'Device')} photo">`
            : '<div class="photo-placeholder">No image</div>';

        return `
            <tr>
                            <td class="device-cell">
                                ${photoCell}
                                <span class="device-color-indicator" style="background:${escapeAttribute(deviceColor)}" aria-hidden="true"></span>
                                <span class="device-name">${escapeHtml(device.name || 'Unnamed Device')}</span>
                            </td>
              <td>${userLabel}</td>
            </tr>
        `;
    }).join('');
}

function renderQueue() {
    const list = publicApp.elements.queueList;
    if (!list) {
        return;
    }

    if (!publicApp.queue.length) {
        list.innerHTML = '<li class="empty-state-item">Nobody is waiting.</li>';
        return;
    }

    list.innerHTML = publicApp.queue.map((entry, index) => {
        const label = entry && entry.initials ? entry.initials : 'Guest';
        return `<li>${escapeHtml(label)}</li>`;
    }).join('');
}

function updateJoinQr() {
    const joinUrl = buildJoinUrl();
    publicApp.elements.joinUrl.textContent = joinUrl;

    renderQrCodeToImage(publicApp.elements.qrImage, joinUrl, {
        width: 512,
        margin: 1
    });
}

function buildJoinUrl() {
    const baseUrl = `${(publicApp.qrBaseUrl || window.location.origin).replace(/\/+$/, '')}/track`;
    if (!publicApp.sessionName) {
        return baseUrl;
    }

    return `${baseUrl}?session=${encodeURIComponent(publicApp.sessionName)}`;
}

function normalizeQrBaseUrl(rawValue) {
    const value = `${rawValue || ''}`.trim();
    if (!value) {
        return null;
    }

    try {
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return null;
        }

        const sanitizedPath = parsed.pathname && parsed.pathname !== '/'
            ? parsed.pathname.replace(/\/+$/, '')
            : '';
        return `${parsed.origin}${sanitizedPath}`;
    } catch (error) {
        return null;
    }
}

function renderQrCodeToImage(imageElement, value, options = {}) {
    if (!imageElement || !value) {
        return;
    }

    if (typeof window.QRCode !== 'function') {
        imageElement.removeAttribute('src');
        imageElement.alt = 'QR code unavailable (local QR library not loaded)';
        return;
    }

    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'fixed';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '-9999px';
    document.body.appendChild(tempContainer);

    try {
        new window.QRCode(tempContainer, {
            text: value,
            width: options.width || 512,
            height: options.width || 512,
            correctLevel: window.QRCode.CorrectLevel.M
        });
    } catch (error) {
        document.body.removeChild(tempContainer);
        imageElement.removeAttribute('src');
        imageElement.alt = 'QR code unavailable';
        return;
    }

    window.setTimeout(() => {
        const renderedImg = tempContainer.querySelector('img');
        const renderedCanvas = tempContainer.querySelector('canvas');
        const dataUrl = renderedImg?.src || (renderedCanvas && renderedCanvas.toDataURL ? renderedCanvas.toDataURL('image/png') : '');

        document.body.removeChild(tempContainer);

        if (!dataUrl) {
            imageElement.removeAttribute('src');
            imageElement.alt = 'QR code unavailable';
            return;
        }

        imageElement.alt = 'QR code for joining the session';
        imageElement.src = dataUrl;
    }, 0);
}

async function loadAvailableCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        publicApp.elements.cameraMessage.textContent = 'Camera selection is not supported in this browser.';
        publicApp.elements.startCameraButton.disabled = true;
        return;
    }

    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cameras = devices.filter((device) => device.kind === 'videoinput');

        publicApp.elements.cameraSelect.innerHTML = '<option value="">Default camera</option>';
        cameras.forEach((camera, index) => {
            const option = document.createElement('option');
            option.value = camera.deviceId;
            option.textContent = camera.label || `Camera ${index + 1}`;
            publicApp.elements.cameraSelect.appendChild(option);
        });
    } catch (error) {
        publicApp.elements.cameraMessage.textContent = 'Could not list cameras.';
    }
}

async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        publicApp.elements.cameraMessage.textContent = 'Camera is not supported in this browser.';
        return;
    }

    stopCamera();

    try {
        const selectedDeviceId = publicApp.elements.cameraSelect.value;
        const constraints = selectedDeviceId
            ? { video: { deviceId: { exact: selectedDeviceId } }, audio: false }
            : { video: true, audio: false };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        publicApp.currentStream = stream;
        publicApp.elements.cameraFeed.srcObject = stream;
        publicApp.elements.cameraMessage.textContent = 'Camera is live.';
        publicApp.elements.startCameraButton.disabled = true;
        publicApp.elements.stopCameraButton.disabled = false;

        await loadAvailableCameras();
    } catch (error) {
        publicApp.elements.cameraMessage.textContent = `Could not start camera: ${error.message}`;
    }
}

function stopCamera() {
    if (publicApp.currentStream) {
        publicApp.currentStream.getTracks().forEach((track) => track.stop());
        publicApp.currentStream = null;
    }

    publicApp.elements.cameraFeed.srcObject = null;
    publicApp.elements.cameraMessage.textContent = 'Camera is off.';
    publicApp.elements.startCameraButton.disabled = false;
    publicApp.elements.stopCameraButton.disabled = true;
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttribute(value) {
    return escapeHtml(value);
}