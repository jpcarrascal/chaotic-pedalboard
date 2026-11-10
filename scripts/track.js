// Track Controller - Dynamic MIDI Interface
var initials = findGetParameter("initials");
var session = findGetParameter("session");
var midiChannel = -1;
var assignedDevice = null;
var currentControllers = {};
var socket;
var mySocketID;
var countdownInterval = null;
var currentSlotExpiresAt = null;
var pendingDeviceStateControllers = null;

if(session === "undefined") session = null;
if(initials === null || initials === "undefined" || initials === "") {
    if(getCookie("countmein-initials")) {
        initials = getCookie("countmein-initials");
        console.log("Initials from cookie: " + getCookie("countmein-initials"));
    } else {
        console.log("No cookie for you");
        initials = null;
    }
}

// Initials: uppercase, no spaces, max 3 chars (also cleans old/long cookies & URLs).
function normalizeInitials(value) {
    if (typeof value !== 'string') return null;
    const cleaned = value.replace(/\s+/g, '').toUpperCase().slice(0, 3);
    return cleaned.length > 0 ? cleaned : null;
}
initials = normalizeInitials(initials);

setCookie("retries", 0, 1000);
var retries = 0;
var maxRetries = 3;

// DOM Elements
const deviceNameElement = document.getElementById("device-name");
const deviceInfoElement = document.getElementById("device-info");
const deviceImageElement = document.getElementById("device-image");
const controllerContainer = document.getElementById("controller-container");
const connectionStatus = document.getElementById("connection-status");
const midiActivity = document.getElementById("midi-activity");
const queueMessageElement = document.getElementById("queue-message");
const slotCountdownElement = document.getElementById("slot-countdown");
const pedalInitialsElement = document.getElementById("pedal-initials");
if (pedalInitialsElement) pedalInitialsElement.textContent = initials || '';
let waitingSynthInstance = null;
let participantColor = null; // server-assigned ambsynth background
let waitingSynthActive = false;

function emitWaitingSynthActive(active) {
    if (waitingSynthActive === active) return;
    waitingSynthActive = active;
    if (socket && socket.connected) {
        socket.emit('ambsynth-active', { active });
    }
}

function emitWaitingSynthTouch(touch) {
    if (socket && socket.connected) {
        socket.emit('ambsynth-touch', touch);
    }
}

function ensureWaitingSynthRoot() {
    let root = document.getElementById('waiting-synth-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'waiting-synth-root';
        root.className = 'waiting-synth-root';
        controllerContainer.appendChild(root);
    }
    return root;
}

function clearDynamicControllerContent() {
    if (!controllerContainer) return;
    Array.from(controllerContainer.children).forEach((child) => {
        if (child.id !== 'waiting-synth-root') {
            child.remove();
        }
    });
}

function showWaitingSynth() {
    if (!controllerContainer) return;

    clearDynamicControllerContent();
    const waitingSynthRoot = ensureWaitingSynthRoot();
    waitingSynthRoot.style.display = 'block';

    if (!waitingSynthInstance && window.AmbSynthEmbed) {
        const synthOptions = {
            showHud: false,
            minHeight: '100%',
            borderRadius: '8px',
            initials: initials || '',
            onTouch: emitWaitingSynthTouch
        };
        if (participantColor) synthOptions.background = participantColor;
        waitingSynthInstance = window.AmbSynthEmbed.mount(waitingSynthRoot, synthOptions);
    }

    if (waitingSynthInstance && typeof waitingSynthInstance.show === 'function') {
        waitingSynthInstance.show();
    } else {
        waitingSynthRoot.style.display = 'block';
    }
    emitWaitingSynthActive(true);
}

function hideWaitingSynth() {
    const waitingSynthRoot = document.getElementById('waiting-synth-root');

    if (waitingSynthInstance && typeof waitingSynthInstance.hide === 'function') {
        waitingSynthInstance.hide();
    }

    if (waitingSynthRoot) {
        waitingSynthRoot.style.display = 'none';
    }
    emitWaitingSynthActive(false);
}

// Pedal view background: participant color (consistent across pedal/ambsynth),
// falling back to the pedal's color until the participant color arrives.
function applyPedalViewBackground() {
    const color = participantColor || (assignedDevice && assignedDevice.color) || null;
    if (!color) return;
    document.body.style.backgroundColor = color;
    document.body.style.color = getContrastColor(color);
    if (pedalInitialsElement && window.AmbSynthEmbed) {
        pedalInitialsElement.style.color = window.AmbSynthEmbed.inkFor(color); // same ink as ambsynth
    }
}

function setDeviceInfoVisible(visible) {
    if (!deviceInfoElement) return;
    // '' (not 'block') so the stylesheet's display applies (flex in portrait).
    deviceInfoElement.style.display = visible ? '' : 'none';
    // Initials watermark only while a pedal is assigned (ambsynth draws its own).
    if (pedalInitialsElement) {
        pedalInitialsElement.style.display = (visible && assignedDevice) ? 'block' : 'none';
    }
}

function setCountdownVisible(visible) {
    if (!slotCountdownElement) return;
    slotCountdownElement.style.display = visible ? 'block' : 'none';
}

setDeviceInfoVisible(true);
setCountdownVisible(false);

if(!initials && session) { // No initials == no socket connection
    document.getElementById("initials-form").style.display = "block";
    document.getElementById("veil").style.display = "none";
    document.getElementById("initials").addEventListener("input", function(e) {
        this.value = normalizeInitials(this.value) || '';
    });
    document.getElementById("initials-form").addEventListener("submit", function(e) {
        e.preventDefault();
        initials = normalizeInitials(document.getElementById("initials").value);
        if (!initials) return;
        document.getElementById("initials-form").style.display = "none";
        document.location.href = "/track?session=" + session + "&initials=" + initials;
    });
} else if(initials && session) {
    setCookie("countmein-initials",initials,1000);
    /* ----------- Socket set up: ------------ */
    document.getElementById("controller").style.display = "flex";
    controllerContainer.style.display = "flex"; // Show controller container
    socket = io("", {query:{initials: initials, session: session, role: "participant"}});
    
    socket.on("connect", () => {
        waitingSynthActive = false; // new socket: server has no ambsynth state for us yet
        setCookie("retries", 0, 1000); 
        retries = 0;
        console.log("Connected, my socketID:" + socket.id);
        mySocketID = socket.id;
        connectionStatus.textContent = "Connected";
        connectionStatus.style.color = "#4ade80";
        
        // Request device assignment information
        console.log("Requesting track assignment for socketID:", mySocketID);
        socket.emit("request-track-assignment", {socketID: mySocketID});
    });

    socket.on("disconnect", () => {
        connectionStatus.textContent = "Disconnected";
        connectionStatus.style.color = "#ef4444";
        stopSlotCountdown();
        setCountdownVisible(false);
        setDeviceInfoVisible(false);
        hideWaitingSynth();
        disableNoSleep();
    });

    var body = document.querySelector("body");
    var noSleep = (typeof NoSleep !== 'undefined') ? new NoSleep() : null;
    var noSleepEnabled = false;
    var noSleepGestureArmed = false;

    function enableNoSleep() {
        if (!noSleep || noSleepEnabled) {
            return;
        }

        Promise.resolve(noSleep.enable())
            .then(function() {
                noSleepEnabled = true;
                console.log('NoSleep enabled');
            })
            .catch(function(error) {
                console.warn('NoSleep enable failed:', error);
            });
    }

    function disableNoSleep() {
        if (!noSleep || !noSleepEnabled) {
            return;
        }

        try {
            noSleep.disable();
            noSleepEnabled = false;
            console.log('NoSleep disabled');
        } catch (error) {
            console.warn('NoSleep disable failed:', error);
        }
    }

    function disarmNoSleepGestureListeners() {
        if (!noSleepGestureArmed) {
            return;
        }

        document.removeEventListener('touchstart', handleNoSleepGesture);
        document.removeEventListener('pointerdown', handleNoSleepGesture);
        document.removeEventListener('click', handleNoSleepGesture);
        noSleepGestureArmed = false;
    }

    function armNoSleepGestureListeners() {
        if (!noSleep || noSleepGestureArmed) {
            return;
        }

        document.addEventListener('touchstart', handleNoSleepGesture, { once: true, passive: true });
        document.addEventListener('pointerdown', handleNoSleepGesture, { once: true, passive: true });
        document.addEventListener('click', handleNoSleepGesture, { once: true, passive: true });
        noSleepGestureArmed = true;
    }

    function handleNoSleepGesture() {
        enableNoSleep();
        disarmNoSleepGestureListeners();
    }

    armNoSleepGestureListeners();

    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'hidden') {
            disableNoSleep();
            disarmNoSleepGestureListeners();
        } else {
            armNoSleepGestureListeners();
        }
    });

    window.addEventListener('beforeunload', function() {
        disableNoSleep();
        disarmNoSleepGestureListeners();
    });

    /* ----------- Socket messages ------------ */

    // Per-participant ambsynth background (mirrored on /ambgrid).
    socket.on('participant-color', function(msg) {
        if (!msg || !msg.color) return;
        participantColor = msg.color;
        if (waitingSynthInstance && typeof waitingSynthInstance.setBackground === 'function') {
            waitingSynthInstance.setBackground(participantColor);
        }
        if (assignedDevice) applyPedalViewBackground();
    });

    // Device assignment message - handles all track data including device color
    socket.on('track-assignment', function(msg) {
        console.log("Received track-assignment message:", msg);
        if(msg.socketID == mySocketID) {
            console.log("Device assignment matches my socketID:", msg);
            assignedDevice = msg.device;
            midiChannel = msg.channel;
            pendingDeviceStateControllers = msg.deviceState && msg.deviceState.controllers ? msg.deviceState.controllers : null;
            clearQueueMessage();
            if (msg.device) {
                hideWaitingSynth();
            } else {
                showWaitingSynth();
            }
            setDeviceInfoVisible(Boolean(msg.device));
            console.log("Updating device interface with:", msg.device);
            updateDeviceInterface(msg.device);

            if (msg.slotExpiresAt) {
                setCountdownVisible(true);
                startSlotCountdown(msg.slotExpiresAt);
            } else {
                stopSlotCountdown();
                setCountdownVisible(false);
            }
        } else {
            console.log("Assignment not for me. My socketID:", mySocketID, "Message socketID:", msg.socketID);
        }
    });

    socket.on('queue-status', function(msg) {
        stopSlotCountdown();
        setCountdownVisible(false);
        setDeviceInfoVisible(false);
        assignedDevice = null;
        midiChannel = -1;
        updateDeviceInterface(null);
        const fallbackMessage = `No pedals available right now. You are #${msg.position} in line.`;
        const message = (msg && typeof msg.message === 'string' && msg.message.trim().length > 0)
            ? msg.message
            : fallbackMessage;
        setQueueMessage(`${message} Play with this synth in the meantime:`);
        showWaitingSynth();
        if (msg && msg.takeover) {
            document.getElementById("veil").style.display = "none";
        }
    });

    socket.on('slot-expired', function(msg) {
        stopSlotCountdown();
        setCountdownVisible(false);
        setDeviceInfoVisible(false);
        assignedDevice = null;
        midiChannel = -1;
        updateDeviceInterface(null);
        setQueueMessage(msg.reason || 'Your time is up. You were moved to line.');
        showWaitingSynth();
    });

    socket.on('stop', function(msg) {
        console.log("Remote stop! " + msg.socketID);
        // Could add visual feedback here
    });

    socket.on('play', function(msg) {
        console.log("Remote play! " + msg.socketID);
        // Could add visual feedback here
    });

    function onSessionGone(msg) {
        if(retries < maxRetries) {
            console.log("Retrying...");
            retries = parseInt(getCookie("retries")) + 1;
            console.log("Retries: " + retries);
            console.log(document.cookie);
            setCookie("retries", retries, 1000);
            setTimeout(() => {
                window.location.reload(true);
            }, 1000);
        } else {
            console.log("Max retries reached. Exiting.");
            document.location.href = "/track?exitreason=" + msg.reason;
        }
    }
    socket.on('session-unavailable', onSessionGone);
    socket.on('session-ended', onSessionGone);

    // Host takeover: veil is lifted so the takeover message stays readable.
    socket.on('takeover-state-updated', function(msg) {
        if (msg && msg.takeover && msg.takeover.enabled) {
            document.getElementById("veil").style.display = "none";
        }
    });

    // Veil for preventing people from joining earlier than intended.
    socket.on('veil-on', function(msg) {
        console.log("Veil ON " + msg.socketID);
        document.getElementById("veil").style.display = "flex";
    });

    socket.on('veil-off', function(msg) {
        console.log("Veil OFF " + msg.socketID);
        document.getElementById("veil").style.display = "none";
    });

}

/* ----------- Controller Interface Functions ------------ */

function formatRemainingTime(msRemaining) {
    const totalSeconds = Math.max(0, Math.ceil(msRemaining / 1000));
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function startSlotCountdown(expiresAt) {
    currentSlotExpiresAt = parseInt(expiresAt, 10);
    if (!Number.isFinite(currentSlotExpiresAt)) {
        stopSlotCountdown();
        return;
    }

    if (countdownInterval) {
        clearInterval(countdownInterval);
    }

    const update = () => {
        const remaining = currentSlotExpiresAt - Date.now();
        slotCountdownElement.textContent = `Remaining: ${formatRemainingTime(remaining)}`;
        if (remaining <= 0) {
            stopSlotCountdown();
            slotCountdownElement.textContent = 'Remaining: 00:00';
        }
    };

    update();
    countdownInterval = setInterval(update, 250);
}

function stopSlotCountdown() {
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    currentSlotExpiresAt = null;
    slotCountdownElement.textContent = 'Remaining: --:--';
}

function setQueueMessage(message) {
    if (!queueMessageElement) return;
    queueMessageElement.textContent = message;
    queueMessageElement.style.display = 'block';
}

function clearQueueMessage() {
    if (!queueMessageElement) return;
    queueMessageElement.textContent = '';
    queueMessageElement.style.display = 'none';
}

function updateDeviceInterface(device) {
    if (!device) {
        deviceNameElement.textContent = "No Pedal Assigned";
        if (deviceImageElement) {
            deviceImageElement.style.display = 'none';
            deviceImageElement.removeAttribute('src');
        }
        clearDynamicControllerContent();
        pendingDeviceStateControllers = null;
        // Reset to default background
        document.body.style.backgroundColor = '#1a1a1a';
        document.body.style.color = '#ffffff';
        return;
    }

    console.log("Track received device:", device.name, "with controllers:", device.controllers);
    console.log("Track received device color:", device.color);
    const prefixElement = document.createElement('span');
    prefixElement.className = 'device-name-prefix';
    prefixElement.textContent = "You're controlling: ";
    deviceNameElement.replaceChildren(prefixElement, device.name || "Unknown Device");

    if (deviceImageElement) {
        if (device.image) {
            deviceImageElement.src = device.image;
            deviceImageElement.style.display = 'block';
        } else {
            deviceImageElement.style.display = 'none';
            deviceImageElement.removeAttribute('src');
        }
    }
    
    applyPedalViewBackground();
    
    // Clear existing controllers
    clearDynamicControllerContent();
    currentControllers = {};


    
    if (device.controllers && Array.isArray(device.controllers) && device.controllers.length > 0) {
        // Device has specific controller mappings (custom format only)
        console.log("Device has controllers, generating device-specific interface");
        console.log("Will call generateDeviceControllers with:", device);
        generateDeviceControllers(device);
    } else {
        // Generic MIDI interface - use standard controllers
        console.log("No device controllers found, using generic interface");
        console.log("device.controllers:", device.controllers);
        generateGenericControllers();
    }

    applyPendingDeviceStateToControllers();
}

function applyPendingDeviceStateToControllers() {
    if (!pendingDeviceStateControllers || typeof pendingDeviceStateControllers !== 'object') {
        return;
    }

    Object.entries(pendingDeviceStateControllers).forEach(([key, rawValue]) => {
        if (!key || !key.startsWith('cc:')) return;
        const ccNumber = parseInt(key.split(':')[1], 10);
        const controller = currentControllers[ccNumber];
        if (!controller || !controller.setValue) return;

        const value = parseInt(rawValue, 10);
        if (!Number.isFinite(value)) return;
        controller.setValue(value);
    });

    pendingDeviceStateControllers = null;
}

/**
 * Calculate contrast color (white or black) based on background color
 */
function getContrastColor(hexColor) {
    // Remove # if present
    const color = hexColor.replace('#', '');
    
    // Convert to RGB
    const r = parseInt(color.substr(0, 2), 16);
    const g = parseInt(color.substr(2, 2), 16);
    const b = parseInt(color.substr(4, 2), 16);
    
    // Calculate luminance
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    
    // Return white for dark backgrounds, black for light backgrounds
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

/**
 * Normalize controller data to handle both old database format and new custom format
 */
function normalizeControllerData(control) {
    // Handle new custom device format
    if (control.name && control.ccNumber !== undefined) {
        return {
            control_name: control.name,
            cc_number: control.ccNumber,
            type: control.type,
            value_range: control.type === 'continuous' ? `${control.minValue ?? 0}-${control.maxValue ?? 127}` : control.range,
            description: `${control.name} (${control.type})`
        };
    }
    
    // Handle old database format (already normalized)
    if (control.control_name && control.cc_number !== undefined) {
        return control;
    }
    
    // Fallback for unknown format
    console.warn('Unknown controller format:', control);
    return {
        control_name: control.name || 'Unknown',
        cc_number: control.ccNumber || control.cc_number || 1,
        type: 'continuous',
        value_range: '0-127',
        description: 'Unknown controller'
    };
}

function generateDeviceControllers(device) {
    console.log("Generating device-specific controllers for:", device.name);
    
    // Only use custom device controllers
    const deviceControllers = device.controllers || [];
    if (deviceControllers.length > 0) {
        // Show all configured controllers (up to max limit)
        let controlsToShow = deviceControllers.slice(0, config.MAX_CONTROLLERS_PER_DEVICE); // Limit for UI
        console.log(`Showing ${controlsToShow.length} custom controllers for device: ${device.name}`);
        // Group controllers logically if we have many
        if (controlsToShow.length > config.MAX_CONTROLLERS_PER_DEVICE) {
            const midPoint = Math.ceil(controlsToShow.length / 2);
            const firstGroup = controlsToShow.slice(0, midPoint);
            const secondGroup = controlsToShow.slice(midPoint);
            const firstGroupEl = createControllerGroup("Primary Controls");
            firstGroup.forEach(control => {
                const normalizedControl = normalizeControllerData(control);
                createController(normalizedControl, firstGroupEl);
            });
            if (secondGroup.length > 0) {
                const secondGroupEl = createControllerGroup("Secondary Controls");
                secondGroup.forEach(control => {
                    const normalizedControl = normalizeControllerData(control);
                    createController(normalizedControl, secondGroupEl);
                });
            }
        } else {
            // Show all in one group
            const groupEl = createControllerGroup("Device Controls");
            controlsToShow.forEach(control => {
                // Normalize controller data for custom format
                const normalizedControl = normalizeControllerData(control);
                createController(normalizedControl, groupEl);
            });
        }
        // No informational messages shown in track interface
    } else {
        // Fallback to generic if no specific controls defined
        generateGenericControllers();
    }
}

function generateGenericControllers() {
    console.log("Generating generic MIDI controllers");
    
    // Create controller groups
    const expressionGroup = createControllerGroup("Expression Controls");
    const filterGroup = createControllerGroup("Filter Controls");
    const envelopeGroup = createControllerGroup("Envelope Controls");
    
    // Expression Controls
    createSlider(expressionGroup, "Volume", 7, 100);
    createSlider(expressionGroup, "Pan", 10, 64);
    createSlider(expressionGroup, "Modulation", 1, 0);
    createSlider(expressionGroup, "Expression", 11, 127);
    
    // Filter Controls  
    createSlider(filterGroup, "Filter Cutoff", 74, 64);
    createSlider(filterGroup, "Filter Resonance", 71, 64);
    
    // Envelope Controls
    createSlider(envelopeGroup, "Attack", 73, 64);
    createSlider(envelopeGroup, "Release", 72, 64);
    
    // Add some buttons for common functions
    const buttonGroup = createControllerGroup("Quick Controls");
    createButtonGrid(buttonGroup, [
        {name: "All Notes Off", cc: 123, value: 0},
        {name: "Reset Controllers", cc: 121, value: 0},
        {name: "Sustain On/Off", cc: 64, toggle: true},
        {name: "Portamento", cc: 65, toggle: true}
    ]);
}

function createController(control, parentGroup = null) {
    console.log("Creating controller for:", control.control_name, "CC:", control.cc_number, "Type:", control.type);
    
    // Use provided parent group or create a new one
    const group = parentGroup || createControllerGroup(control.control_name);
    
    // Create different control types based on the controller type
    if (control.type === 'discrete') {
        console.log("Creating discrete controller with range:", control.value_range);
        createDiscreteController(group, control.control_name, control.cc_number, control.value_range);
    } else {
        // Continuous controller - create slider
        console.log("Creating continuous controller");
        // Parse the value range to determine min/max values
        let minValue = 0;
        let maxValue = 127;
        if (control.value_range) {
            const rangeMatch = control.value_range.match(/(\d+).*?(\d+)/);
            if (rangeMatch) {
                minValue = parseInt(rangeMatch[1]);
                maxValue = parseInt(rangeMatch[2]);
            }
        }
        const defaultValue = Math.round((minValue + maxValue) / 2);
        createSlider(group, control.control_name, control.cc_number, defaultValue, maxValue, minValue);
    }
    
    // Add description as tooltip or subtitle if available
    if (control.description) {
        const description = document.createElement('div');
        description.className = 'control-description';
        description.textContent = control.description;
        description.style.fontSize = '12px';
        description.style.color = '#888';
        description.style.marginTop = '4px';
        group.appendChild(description);
    }
}

function createDiscreteController(group, name, ccNumber, valueRange) {
    console.log("Creating discrete controller:", name, "with range:", valueRange);
    
    // Parse the discrete range format: "Off: 0-31, On: 32-63, Auto: 64-127"
    const options = parseDiscreteRange(valueRange);
    console.log("Parsed discrete options:", options);
    
    if (options.length === 0) {
        console.warn("No valid options parsed from range:", valueRange);
        return;
    }
    
    // Create main container (similar to slider-container)
    const container = document.createElement('div');
    container.className = 'discrete-container';
    
    // Create label (similar to slider-label)
    const label = document.createElement('div');
    label.className = 'discrete-label';
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    
    const valueSpan = document.createElement('span');
    valueSpan.className = 'discrete-value';
    valueSpan.textContent = options[0].label; // Show first option as default
    
    label.appendChild(nameSpan);
    label.appendChild(valueSpan);
    
    // Create container for discrete buttons
    const buttonContainer = document.createElement('div');
    buttonContainer.className = 'discrete-buttons';
    
    let activeButton = null;
    let suppressEmit = false;
    
    // Create a button for each discrete option
    options.forEach((option, index) => {
        const button = document.createElement('button');
        button.className = 'discrete-option-btn';
        button.textContent = option.label;
        
        // Handle button click
        button.addEventListener('click', () => {
            // Update visual state
            if (activeButton) {
                activeButton.classList.remove('active');
            }
            
            button.classList.add('active');
            activeButton = button;
            
            // Update the value display
            valueSpan.textContent = option.label;
            
            // Send MIDI CC message with the option's value
            const midiValue = option.midValue;
            console.log(`Discrete controller ${name} (CC${ccNumber}): ${option.label} = ${midiValue}`);

            if (!suppressEmit) {
                // Send MIDI CC message using the same function as sliders
                sendControlChange(ccNumber, midiValue);
                showMidiActivity(`CC${ccNumber}: ${option.label} (${midiValue})`);
            }
        });
        
        buttonContainer.appendChild(button);
        
        // Set first option as default
        if (index === 0) {
            suppressEmit = true;
            button.click();
            suppressEmit = false;
        }
    });
    
    // Assemble the complete discrete controller
    container.appendChild(label);
    container.appendChild(buttonContainer);
    group.appendChild(container);

    currentControllers[ccNumber] = {
        type: 'discrete',
        setValue: function(nextValue) {
            let closest = options[0];
            const parsed = parseInt(nextValue, 10);
            if (Number.isFinite(parsed)) {
                options.forEach((opt) => {
                    if (Math.abs(opt.midValue - parsed) < Math.abs(closest.midValue - parsed)) {
                        closest = opt;
                    }
                });
            }

            const targetButton = Array.from(buttonContainer.children).find((btn) => btn.textContent === closest.label);
            if (targetButton) {
                suppressEmit = true;
                targetButton.click();
                suppressEmit = false;
            }
        }
    };
}

function parseDiscreteRange(rangeString) {
    // Parse format: "Off: 0-31, On: 32-63, Auto: 64-127"
    const options = [];
    
    if (!rangeString) return options;
    
    // Split by comma and parse each option
    const parts = rangeString.split(',');
    
    parts.forEach(part => {
        const trimmedPart = part.trim();
        // Match pattern: "Label: min-max" or "Label: value"
        const match = trimmedPart.match(/^([^:]+):\s*(\d+)(?:-(\d+))?/);
        
        if (match) {
            const label = match[1].trim();
            const minValue = parseInt(match[2]);
            const maxValue = match[3] ? parseInt(match[3]) : minValue;
            
            // Use the middle value of the range as the MIDI value to send
            const midValue = Math.floor((minValue + maxValue) / 2);
            
            options.push({
                label: label,
                minValue: minValue,
                maxValue: maxValue,
                midValue: midValue
            });
        }
    });
    
    return options;
}

function createControllerGroup(title) {
    const group = document.createElement('div');
    group.className = 'controller-group';
    
    const header = document.createElement('h3');
    header.textContent = title;
    group.appendChild(header);
    
    controllerContainer.appendChild(group);
    return group;
}

function createSlider(parent, name, ccNumber, defaultValue, maxValue = 127, minValue = 0) {
    const container = document.createElement('div');
    container.className = 'slider-container';
    
    const label = document.createElement('div');
    label.className = 'slider-label';
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;
    
    const valueSpan = document.createElement('span');
    valueSpan.className = 'slider-value';
    valueSpan.textContent = defaultValue;
    
    label.appendChild(nameSpan);
    label.appendChild(valueSpan);
    
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'slider';
    slider.min = minValue.toString();
    slider.max = maxValue.toString();
    slider.value = defaultValue;
    slider.dataset.cc = ccNumber;
    
    slider.addEventListener('input', function() {
        const value = parseInt(this.value);
        valueSpan.textContent = value;
        sendControlChange(ccNumber, value);
        showMidiActivity(`CC${ccNumber}: ${value}`);
    });
    
    container.appendChild(label);
    container.appendChild(slider);
    parent.appendChild(container);
    
    currentControllers[ccNumber] = {
        type: 'continuous',
        element: slider,
        setValue: function(nextValue) {
            const parsed = parseInt(nextValue, 10);
            if (!Number.isFinite(parsed)) return;
            const clamped = Math.min(maxValue, Math.max(minValue, parsed));
            slider.value = clamped;
            valueSpan.textContent = clamped;
        }
    };
}

function createButtonGrid(parent, buttons) {
    const container = document.createElement('div');
    container.className = 'button-container';
    
    buttons.forEach(buttonConfig => {
        const button = document.createElement('button');
        button.className = 'midi-button';
        button.textContent = buttonConfig.name;
        button.dataset.cc = buttonConfig.cc;
        
        if (buttonConfig.toggle) {
            let isActive = false;
            button.addEventListener('click', function() {
                isActive = !isActive;
                this.classList.toggle('active', isActive);
                const value = isActive ? 127 : 0;
                sendControlChange(buttonConfig.cc, value);
                showMidiActivity(`CC${buttonConfig.cc}: ${value}`);
            });
        } else {
            button.addEventListener('mousedown', function() {
                this.classList.add('active');
                sendControlChange(buttonConfig.cc, buttonConfig.value || 127);
                showMidiActivity(`CC${buttonConfig.cc}: ${buttonConfig.value || 127}`);
            });
            
            button.addEventListener('mouseup', function() {
                this.classList.remove('active');
            });
            
            button.addEventListener('mouseleave', function() {
                this.classList.remove('active');
            });
        }
        
        container.appendChild(button);
    });
    
    parent.appendChild(container);
}

function sendControlChange(ccNumber, value) {
    if (socket && mySocketID && midiChannel !== -1) {
        const message = [0xB0 + midiChannel, ccNumber, value];
        socket.emit("routed-message", {
            type: "MIDI",
            source: "ui",
            message: message,
            timestamp: performance.now()
        });
    }
}

function showMidiActivity(text) {
    midiActivity.textContent = text;
    midiActivity.style.opacity = '1';
    setTimeout(() => {
        midiActivity.style.opacity = '0.5';
    }, 500);
}

function addListenerMulti(el, s, fn) {
    s.split(' ').forEach(e => el.addEventListener(e, fn, false));
}

/* ----------- MIDI Input Handler ------------ */

function midiInToSocket(msg) {
    var message = [msg.data[0], msg.data[1], msg.data[2]];
    var incomingChannel = parseInt(msg.data[0] & 0x0F);
    console.log("Incoming MIDI channel: " + incomingChannel);
    
    // Route to assigned channel
    if (midiChannel !== -1) {
        message = replaceMidiChannel(message, midiChannel);
    }
    
    socket.emit("routed-message", {
        type: "MIDI",
        source: "midi-input",
        message: message,
        timestamp: performance.now()
    });
    
    // Show activity
    const messageType = (msg.data[0] & 0xF0) >> 4;
    let activityText = `MIDI: Ch${incomingChannel + 1}`;
    if (messageType === 9) activityText += " Note On";
    else if (messageType === 8) activityText += " Note Off";
    else if (messageType === 11) activityText += " CC";
    
    showMidiActivity(activityText);
}