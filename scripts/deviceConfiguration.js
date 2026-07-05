/**
 * Device Configuration Manager
 * Handles MIDI device configuration, mapping devices to interfaces and channels
 */

class DeviceConfiguration {
    constructor() {
        this.configuredDevices = []; // User-configured custom devices
        this.availableInterfaces = []; // From MIDI system
        this.availablePedalImages = []; // From /images/pedals
        this.nextDeviceId = 1; // Auto-increment ID for new devices
        this.deviceAssignments = {}; // Maps trackNumber -> {deviceId, deviceName, userInitials}
        
        this.elements = {
            configPanel: null,
            configTable: null,
            configTableBody: null,
            noDevicesMessage: null,
            addDeviceBtn: null,
            saveConfigBtn: null,
            loadConfigBtn: null,
            modal: null,
            addDeviceForm: null,
            closeModal: null,
            // Form elements
            deviceName: null,
            deviceColor: null,
            deviceImage: null,
            deviceImagePreview: null,
            deviceImagePreviewImg: null,
            colorPreview: null,
            controllersContainer: null,
            addControllerBtn: null
        };
        
        this.isVisible = false;
        this.currentControllerCount = 0;
    }

    /**
     * Initialize the device configuration system
     */
    async initialize() {
        console.log('Initializing device configuration system...');
        this.initializeElements();
        await this.loadPedalImages();
        this.attachEventListeners();
        this.loadConfiguration();
        this.updateConfigurationTable();
        
        // Debug: Log loaded devices
        console.log('=== Device Configuration Loaded ===');
        console.log('Number of devices:', this.configuredDevices.length);
        this.configuredDevices.forEach(device => {
            console.log(`Device "${device.name}" (ID: ${device.id}):`, {
                controllers: device.controllers,
                controllerCount: device.controllers?.length
            });
        });
        
        console.log('Device configuration system initialized');
    }

    /**
     * Initialize DOM element references
     */
    initializeElements() {
        this.elements.configPanel = document.getElementById('device-config-panel');
        this.elements.configTable = document.getElementById('device-config-table');
        this.elements.configTableBody = document.getElementById('device-config-table-body');
        this.elements.noDevicesMessage = document.getElementById('no-configured-devices');
        this.elements.addDeviceBtn = document.getElementById('add-device-btn');
        this.elements.saveConfigBtn = document.getElementById('save-config-btn');
        this.elements.loadConfigBtn = document.getElementById('load-config-btn');
        this.elements.modal = document.getElementById('device-selection-modal');
        this.elements.closeModal = document.getElementById('close-modal');
        
        // New form elements
        this.elements.addDeviceForm = document.getElementById('add-device-form');
        this.elements.deviceName = document.getElementById('device-name');
        this.elements.deviceColor = document.getElementById('device-color');
        this.elements.deviceImage = document.getElementById('device-image');
        this.elements.deviceImagePreview = document.getElementById('device-image-preview');
        this.elements.deviceImagePreviewImg = document.getElementById('device-image-preview-img');
        this.elements.controllersContainer = document.getElementById('controllers-container');
        this.elements.addControllerBtn = document.getElementById('add-controller-btn');
        
        // Update dynamic HTML text based on config
        this.updateDynamicText();
    }
    
    /**
     * Update HTML text that depends on configuration values
     */
    updateDynamicText() {
        const maxControllersText = document.getElementById('max-controllers-text');
        if (maxControllersText) {
            maxControllersText.textContent = `MIDI Controllers (up to ${config.MAX_CONTROLLERS_PER_DEVICE})`;
        }
        
        const controllerSelectionText = document.getElementById('controller-selection-text');
        if (controllerSelectionText) {
            controllerSelectionText.textContent = `Select up to ${config.MAX_CONTROLLERS_PER_DEVICE} MIDI controllers`;
        }
        
        const maxCountSpan = document.getElementById('max-count');
        if (maxCountSpan) {
            maxCountSpan.textContent = config.MAX_CONTROLLERS_PER_DEVICE;
        }
    }

    /**
     * Attach event listeners
     */
    attachEventListeners() {
        // Configuration controls
        this.elements.addDeviceBtn?.addEventListener('click', () => this.showAddDeviceModal());
        this.elements.saveConfigBtn?.addEventListener('click', () => this.saveConfiguration());
        this.elements.loadConfigBtn?.addEventListener('click', () => this.loadConfigurationFile());
        
        // Modal controls
        this.elements.closeModal?.addEventListener('click', (e) => {
            e.preventDefault();
            this.hideAddDeviceModal();
        });
        
        this.elements.modal?.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-overlay') || e.target === this.elements.modal) {
                this.hideAddDeviceModal();
            }
        });
        
        // Form controls
        this.elements.addDeviceForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleCreateDevice();
        });

        this.elements.deviceImage?.addEventListener('change', () => {
            this.updateDeviceImagePreview(this.elements.deviceImage.value || '');
        });
        
        this.elements.addControllerBtn?.addEventListener('click', () => this.addControllerForm());
        
        // Keyboard support
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.elements.modal?.classList.contains('hidden')) {
                this.hideAddDeviceModal();
            }
        });
    }

    /**
     * Show add device modal
     */
    showAddDeviceModal() {
        console.log('Showing add device modal');
        this.resetAddDeviceForm();
        this.elements.modal?.classList.remove('hidden');
    }

    /**
     * Hide add device modal
     */
    hideAddDeviceModal() {
        console.log('Hiding add device modal');
        this.elements.modal?.classList.add('hidden');
        this.resetAddDeviceForm();
    }

    /**
     * Reset the add device form
     */
    resetAddDeviceForm() {
        if (this.elements.addDeviceForm) {
            this.elements.addDeviceForm.reset();
        }

        if (this.elements.deviceImage) {
            this.populateDeviceImageOptions('');
        }
        this.updateDeviceImagePreview('');
        
        // Clear controllers
        if (this.elements.controllersContainer) {
            this.elements.controllersContainer.innerHTML = '';
        }
        
        this.currentControllerCount = 0;
        this.updateAddControllerButton();
        
        // Reset modal state for creating new devices
        const modal = document.getElementById('device-selection-modal');
        if (modal) {
            const modalTitle = modal.querySelector('.modal-header h3');
            const submitButton = modal.querySelector('button[type="submit"]');
            
            if (modalTitle) modalTitle.textContent = 'Add New Device';
            if (submitButton) submitButton.textContent = 'Create Device';
        }
        
        // Clear editing state
        this.editingDevice = null;
    }

    /**
     * Fetch and populate pedal image options from server
     */
    async loadPedalImages() {
        try {
            const response = await fetch('/api/pedal-images', { cache: 'no-cache' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const payload = await response.json();
            this.availablePedalImages = Array.isArray(payload.images) ? payload.images : [];
        } catch (error) {
            console.warn('Unable to load pedal images:', error);
            this.availablePedalImages = [];
        }

        this.populateDeviceImageOptions();
    }

    /**
     * Populate the pedal image select options
     */
    populateDeviceImageOptions(selectedImage = '') {
        if (!this.elements.deviceImage) return;

        const options = ['<option value="">No image</option>'];
        this.availablePedalImages.forEach(imagePath => {
            const selected = imagePath === selectedImage ? ' selected' : '';
            options.push(`<option value="${imagePath}"${selected}>${this.getImageDisplayName(imagePath)}</option>`);
        });

        this.elements.deviceImage.innerHTML = options.join('');

        if (selectedImage && !this.availablePedalImages.includes(selectedImage)) {
            const fallbackOption = document.createElement('option');
            fallbackOption.value = selectedImage;
            fallbackOption.textContent = this.getImageDisplayName(selectedImage);
            fallbackOption.selected = true;
            this.elements.deviceImage.appendChild(fallbackOption);
        }

        this.elements.deviceImage.value = selectedImage || '';
        this.updateDeviceImagePreview(selectedImage || '');
    }

    /**
     * Update the image preview widget
     */
    updateDeviceImagePreview(imagePath) {
        if (!this.elements.deviceImagePreview || !this.elements.deviceImagePreviewImg) return;

        if (!imagePath) {
            this.elements.deviceImagePreview.style.display = 'none';
            this.elements.deviceImagePreviewImg.removeAttribute('src');
            return;
        }

        this.elements.deviceImagePreview.style.display = 'flex';
        this.elements.deviceImagePreviewImg.src = imagePath;
    }

    /**
     * Human-readable file label for selects
     */
    getImageDisplayName(imagePath) {
        const filename = (imagePath || '').split('/').pop() || imagePath;
        return filename;
    }

    /**
     * Normalize image path to web path
     */
    normalizeDeviceImagePath(imagePath) {
        if (!imagePath || typeof imagePath !== 'string') return '';
        const trimmed = imagePath.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('/images/pedals/')) return trimmed;
        if (trimmed.startsWith('images/pedals/')) return `/${trimmed}`;
        if (!trimmed.includes('/')) return `/images/pedals/${trimmed}`;
        return trimmed;
    }

    /**
     * Initialize or get the controllers table
     */
    getOrCreateControllersTable() {
        let table = this.elements.controllersContainer.querySelector('table.controllers-table');
        if (!table) {
            const wrapper = document.createElement('div');
            wrapper.className = 'controllers-table-wrapper';
            wrapper.innerHTML = `
                <table class="controllers-table">
                    <thead>
                        <tr>
                            <th class="remove-col"></th>
                            <th>Name</th>
                            <th>CC #</th>
                            <th>Type</th>
                            <th>Range(s)</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            `;
            this.elements.controllersContainer.innerHTML = '';
            this.elements.controllersContainer.appendChild(wrapper);
            table = wrapper.querySelector('table.controllers-table');
        }
        return table;
    }

    /**
     * Add a controller form row to the table
     */
    addControllerForm(controllerData = null) {
        if (this.currentControllerCount >= config.MAX_CONTROLLERS_PER_DEVICE) return;
        
        const controllerIndex = this.currentControllerCount;
        const table = this.getOrCreateControllersTable();
        const tbody = table.querySelector('tbody');
        
        const controllerType = controllerData?.type || 'continuous';
        const defaultContinuousRange = '0-127';
        const defaultDiscreteRange = 'Off: 0-63, On: 64-127';
        const range = controllerType === 'continuous' 
            ? (controllerData?.minValue !== undefined && controllerData?.maxValue !== undefined 
                ? `${controllerData.minValue}-${controllerData.maxValue}`
                : defaultContinuousRange)
            : (controllerData?.range || defaultDiscreteRange);
        
        const row = document.createElement('tr');
        row.className = 'controller-row';
        row.dataset.index = controllerIndex;
        
        row.innerHTML = `
            <td class="remove-col">
                <button type="button" class="remove-controller-btn" onclick="deviceConfig.removeControllerForm(${controllerIndex})">✕</button>
            </td>
            <td>
                <input type="text" name="controllerName_${controllerIndex}" class="inline-input" required placeholder="e.g., Volume" value="${controllerData?.name || ''}">
            </td>
            <td>
                <input type="number" name="ccNumber_${controllerIndex}" class="inline-input cc-number" min="0" max="127" required placeholder="0-127" value="${controllerData?.ccNumber || ''}">
            </td>
            <td>
                <select name="ccType_${controllerIndex}" class="inline-select" required onchange="deviceConfig.handleControllerTypeChange(${controllerIndex}, this.value)">
                    <option value="continuous" ${controllerType !== 'discrete' ? 'selected' : ''}>Continuous</option>
                    <option value="discrete" ${controllerType === 'discrete' ? 'selected' : ''}>Discrete</option>
                </select>
            </td>
            <td>
                <textarea name="ccContinuousRange_${controllerIndex}" class="inline-textarea range-textarea" placeholder="Format: min-max" style="display: ${controllerType !== 'discrete' ? 'block' : 'none'};">${controllerType !== 'discrete' ? range : ''}</textarea>
                <textarea name="ccRange_${controllerIndex}" class="inline-textarea range-textarea" placeholder="Format: Label: min-max" style="display: ${controllerType === 'discrete' ? 'block' : 'none'};">${controllerType === 'discrete' ? range : ''}</textarea>
            </td>
        `;
        
        tbody.appendChild(row);
        this.currentControllerCount++;
        this.updateAddControllerButton();
    }

    /**
     * Remove a controller row
     */
    removeControllerForm(index) {
        const row = this.elements.controllersContainer.querySelector(`.controller-row[data-index="${index}"]`);
        if (row) {
            row.remove();
            this.currentControllerCount--;
            this.updateAddControllerButton();
        }
    }

    /**
     * Handle controller type change
     */
    handleControllerTypeChange(index, type) {
        const row = this.elements.controllersContainer.querySelector(`.controller-row[data-index="${index}"]`);
        if (row) {
            const continuousRange = row.querySelector(`textarea[name="ccContinuousRange_${index}"]`);
            const discreteRange = row.querySelector(`textarea[name="ccRange_${index}"]`);
            
            if (type === 'discrete') {
                if (continuousRange) continuousRange.style.display = 'none';
                if (discreteRange) {
                    discreteRange.style.display = 'block';
                    if (!discreteRange.value) discreteRange.value = 'Off: 0-63, On: 64-127';
                }
            } else {
                if (continuousRange) {
                    continuousRange.style.display = 'block';
                    if (!continuousRange.value) continuousRange.value = '0-127';
                }
                if (discreteRange) discreteRange.style.display = 'none';
            }
        }
    }

    /**
     * Update add controller button state
     */
    updateAddControllerButton() {
        if (this.elements.addControllerBtn) {
            this.elements.addControllerBtn.disabled = this.currentControllerCount >= config.MAX_CONTROLLERS_PER_DEVICE;
            this.elements.addControllerBtn.textContent = 
                this.currentControllerCount >= config.MAX_CONTROLLERS_PER_DEVICE ? '✓ Maximum Controllers Added' : '➕ Add Controller';
        }
    }

    /**
     * Handle form submission to create new device
     */
    handleCreateDevice() {
        try {
            // Collect form data
            const formData = new FormData(this.elements.addDeviceForm);
            const deviceName = formData.get('deviceName')?.trim();
            const deviceColor = formData.get('deviceColor');
            const deviceImage = this.normalizeDeviceImagePath(formData.get('deviceImage') || '');
            
            console.log('Form data collected:', {
                deviceName,
                deviceColor,
                deviceImage,
                formElementValue: this.elements.deviceColor?.value
            });
            
            // Validate basic fields
            if (!deviceName) {
                this.showFormError('Device name is required');
                return;
            }
            
            // Check for duplicate device name (skip if editing the same device)
            const existingDevice = this.configuredDevices.find(d => d.name.toLowerCase() === deviceName.toLowerCase());
            if (existingDevice && (!this.editingDevice || existingDevice.id !== this.editingDevice.id)) {
                this.showFormError('A device with this name already exists');
                return;
            }
            
            // Collect controllers from table rows
            const controllers = [];
            const usedCCNumbers = new Set();
            const table = this.elements.controllersContainer.querySelector('table.controllers-table');
            const rows = table ? table.querySelectorAll('tbody tr.controller-row') : [];
            
            try {
                rows.forEach((row, rowIndex) => {
                    const i = row.dataset.index;
                    const controllerName = row.querySelector(`input[name="controllerName_${i}"]`)?.value?.trim();
                    const ccNumber = parseInt(row.querySelector(`input[name="ccNumber_${i}"]`)?.value);
                    const ccType = row.querySelector(`select[name="ccType_${i}"]`)?.value;
                    const ccRange = row.querySelector(`textarea[name="ccRange_${i}"]`)?.value?.trim();
                    const ccContinuousRange = row.querySelector(`textarea[name="ccContinuousRange_${i}"]`)?.value?.trim();
                    
                    // Skip empty controller forms
                    if (!controllerName && !ccNumber && !ccType) return;
                    
                    // Validate controller data
                    if (!controllerName) {
                        this.showFormError(`Controller ${rowIndex + 1}: Name is required`);
                        throw new Error('Validation failed');
                    }
                    
                    if (isNaN(ccNumber) || ccNumber < 0 || ccNumber > 127) {
                        this.showFormError(`Controller ${rowIndex + 1}: CC number must be between 0-127`);
                        throw new Error('Validation failed');
                    }
                    
                    if (usedCCNumbers.has(ccNumber)) {
                        this.showFormError(`Controller ${rowIndex + 1}: CC number ${ccNumber} is already used`);
                        throw new Error('Validation failed');
                    }
                    
                    if (!ccType) {
                        this.showFormError(`Controller ${rowIndex + 1}: Type is required`);
                        throw new Error('Validation failed');
                    }
                    
                    usedCCNumbers.add(ccNumber);
                    
                    if (ccType === 'continuous') {
                        const rangeMatch = (ccContinuousRange || '').match(/^(\d+)-(\d+)$/);
                        if (!rangeMatch) {
                            this.showFormError(`Controller ${rowIndex + 1}: Range must be in "min-max" format (e.g., "0-127")`);
                            throw new Error('Validation failed');
                        }
                        const minValue = Math.max(0, Math.min(127, parseInt(rangeMatch[1])));
                        const maxValue = Math.max(0, Math.min(127, parseInt(rangeMatch[2])));
                        if (minValue >= maxValue) {
                            this.showFormError(`Controller ${rowIndex + 1}: Min value must be less than Max value`);
                            throw new Error('Validation failed');
                        }
                        controllers.push({
                            name: controllerName,
                            ccNumber: ccNumber,
                            type: ccType,
                            minValue: minValue,
                            maxValue: maxValue
                        });
                    } else {
                        if (!ccRange) {
                            this.showFormError(`Controller ${rowIndex + 1}: Range definition is required for discrete controllers`);
                            throw new Error('Validation failed');
                        }
                        controllers.push({
                            name: controllerName,
                            ccNumber: ccNumber,
                            type: ccType,
                            range: ccRange
                        });
                    }
                });
            } catch (e) {
                return;
            }
            
            if (this.editingDevice) {
                // Update existing device
                this.editingDevice.name = deviceName;
                this.editingDevice.color = deviceColor;
                this.editingDevice.image = deviceImage;
                this.editingDevice.controllers = controllers;
                this.editingDevice.updatedAt = new Date().toISOString();
                
                console.log('Device updated successfully with color:', this.editingDevice.color);
                this.editingDevice = null; // Clear editing state
            } else {
                // Create new device
                const newDevice = {
                    id: this.nextDeviceId++,
                    name: deviceName,
                    color: deviceColor,
                    image: deviceImage,
                    controllers: controllers,
                    assignedInterface: '',
                    assignedChannel: 1,
                    status: 'not_configured',
                    createdAt: new Date().toISOString()
                };
                
                // Add to configured devices
                this.configuredDevices.push(newDevice);
                console.log('New device created with color:', newDevice.color);
                console.log('Device created successfully:', newDevice);
                console.log('Device controllers array:', newDevice.controllers);
            }
            
            this.autoSaveConfiguration();
            this.updateConfigurationTable();
            
            // Hide modal
            this.hideAddDeviceModal();
            
            // Refresh routing matrix
            if (window.updateRoutingMatrix) {
                window.updateRoutingMatrix();
            }

            if (window.syncConfiguredDevicesToServer) {
                window.syncConfiguredDevicesToServer();
            }
            
        } catch (error) {
            console.error('Error creating device:', error);
            this.showFormError('Failed to create device. Please try again.');
        }
    }

    /**
     * Show form error message
     */
    showFormError(message) {
        // Remove any existing error
        const existingError = this.elements.modal.querySelector('.error-message');
        if (existingError) {
            existingError.remove();
        }
        
        // Create and show new error
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        
        const modalBody = this.elements.modal.querySelector('.modal-body');
        modalBody.insertBefore(errorDiv, modalBody.firstChild);
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            if (errorDiv.parentNode) {
                errorDiv.remove();
            }
        }, 5000);
    }



    /**
     * Show confirmation dialog before removing device
     */
    confirmRemoveDevice(deviceId) {
        // Convert to number to ensure proper comparison
        const numericDeviceId = parseInt(deviceId);
        const device = this.configuredDevices.find(d => d.id === numericDeviceId);
        
        if (!device) {
            console.error('Device not found for removal:', numericDeviceId);
            return;
        }

        const message = `Are you sure you want to remove "${device.name}" from the configuration?\n\nThis will disconnect any tracks currently using this device.`;
        
        if (confirm(message)) {
            this.removeDevice(numericDeviceId);
        }
    }

    /**
     * Remove device from configuration
     */
    removeDevice(deviceId) {
        this.configuredDevices = this.configuredDevices.filter(d => d.id !== deviceId);
        this.autoSaveConfiguration(); // Auto-save after removing device
        this.updateConfigurationTable();
        
        // Refresh routing matrix to update device options
        if (window.updateRoutingMatrix) {
            window.updateRoutingMatrix();
        }

        if (window.syncConfiguredDevicesToServer) {
            window.syncConfiguredDevicesToServer();
        }
    }

    /**
     * Update the configuration table
     */
    updateConfigurationTable() {
        if (!this.elements.configTableBody || !this.elements.noDevicesMessage) return;

        if (this.configuredDevices.length === 0) {
            this.elements.configTable?.classList.add('hidden');
            this.elements.noDevicesMessage?.classList.remove('hidden');
            return;
        }

        this.elements.configTable?.classList.remove('hidden');
        this.elements.noDevicesMessage?.classList.add('hidden');

        this.elements.configTableBody.innerHTML = this.configuredDevices.map(device => {
            // Find which user(s) are assigned to this device
            const assignedUser = this.getAssignedUserForDevice(device.id);
            const userDisplay = assignedUser ? `<strong>${assignedUser}</strong>` : '<em>---</em>';
            
            return `
            <tr data-device-id="${device.id}" style="background-color: ${device.color}15;">
                <td class="device-name-cell">
                    ${device.image ? `<img class="device-pedal-thumbnail" src="${device.image}" alt="${device.name} pedal image">` : ''}
                    <div class="device-color-indicator" style="background-color: ${device.color};"></div>
                    <div class="device-info">
                        <strong>${device.name}</strong>
                        <div class="device-details">${(device.controllers || []).length} controller${(device.controllers || []).length !== 1 ? 's' : ''}</div>
                    </div>
                </td>
                <td class="user-cell">
                    ${userDisplay}
                </td>
                <td>
                    <select class="interface-select" onchange="deviceConfig.updateDeviceInterface(${device.id}, this.value)">
                        <option value="">Select Interface...</option>
                        ${this.availableInterfaces.map(iface => `
                            <option value="${iface.id}" ${device.assignedInterface === iface.id ? 'selected' : ''}>
                                ${iface.name}
                            </option>
                        `).join('')}
                    </select>
                </td>
                <td>
                    <select class="channel-select" onchange="deviceConfig.updateDeviceChannel(${device.id}, this.value)">
                        ${Array.from({length: 16}, (_, i) => `
                            <option value="${i + 1}" ${device.assignedChannel === i + 1 ? 'selected' : ''}>
                                ${i + 1}
                            </option>
                        `).join('')}
                    </select>
                </td>
                <td>
                    <span class="status-badge status-${device.status}">${this.getStatusLabel(device.status)}</span>
                </td>
                <td>
                    <button class="control-btn small" onclick="deviceConfig.showControllerSetup(${device.id})" title="Edit MIDI controllers">
                        ⚙️ Edit
                    </button>
                    <button class="control-btn small danger" onclick="deviceConfig.confirmRemoveDevice(${device.id})" title="Remove device">
                        🗑️ Remove
                    </button>
                </td>
            </tr>
        `;
        }).join('');
    }

    /**
     * Update device interface assignment
     */
    updateDeviceInterface(deviceId, interfaceId) {
        const device = this.configuredDevices.find(d => d.id === deviceId);
        if (device) {
            device.assignedInterface = interfaceId;
            device.status = interfaceId ? 'configured' : 'not_configured';
            this.autoSaveConfiguration(); // Auto-save after updating interface
            this.updateConfigurationTable();
            
            // Refresh routing matrix to update device availability
            if (window.updateRoutingMatrix) {
                window.updateRoutingMatrix();
            }
            
            // Notify tracks using this device about the interface change
            this.notifyTracksOfDeviceChange(deviceId);

            if (window.syncConfiguredDevicesToServer) {
                window.syncConfiguredDevicesToServer();
            }
        }
    }

    /**
     * Update device MIDI channel
     */
    updateDeviceChannel(deviceId, channel) {
        const device = this.configuredDevices.find(d => d.id === deviceId);
        if (device) {
            device.assignedChannel = parseInt(channel);
            this.autoSaveConfiguration(); // Auto-save after updating channel
            this.updateConfigurationTable();
            
            // Notify tracks using this device about the channel change
            this.notifyTracksOfDeviceChange(deviceId);

            if (window.syncConfiguredDevicesToServer) {
                window.syncConfiguredDevicesToServer();
            }
        }
    }

    /**
     * Notify tracks that are using a specific device about configuration changes
     */
    notifyTracksOfDeviceChange(deviceId) {
        // Check if sequencer routing system is available
        if (!window.app || !window.app.routingMatrix) {
            console.log('Routing matrix not available for device change notification, will retry...');
            // Retry after a short delay in case the sequencer is still initializing
            setTimeout(() => {
                this.notifyTracksOfDeviceChange(deviceId);
            }, 100);
            return;
        }

        const deviceIdString = `device:${deviceId}`;
        const updatedDevice = this.getDeviceConfig(deviceId);
        
        if (!updatedDevice) {
            console.log(`Device ${deviceId} not found in configuration`);
            return;
        }

        console.log(`Notifying tracks of device ${deviceId} configuration change, new channel: ${updatedDevice.assignedChannel}`);

        // Find all tracks using this device and update their routing
        const allRoutings = window.app.routingMatrix.getAllRoutings();
        let tracksUpdated = 0;
        
        for (const [trackId, routing] of allRoutings) {
            if (routing.deviceId === deviceIdString && routing.enabled) {
                console.log(`Updating routing for track ${trackId} with new device ${deviceId} configuration`);
                
                // Update the routing matrix with the new channel from device config
                // Convert from 1-based (device config) to 0-based (routing matrix)
                const newChannel = updatedDevice.assignedChannel - 1;
                
                window.app.routingMatrix.updateRouting(trackId, {
                    channel: newChannel,
                    channelLocked: true  // Configured devices have locked channels
                });
                
                tracksUpdated++;
                // Note: The updateRouting call will automatically trigger the routing change callback
            }
        }
        
        console.log(`Updated ${tracksUpdated} tracks with new device ${deviceId} configuration`);
        
        // Refresh the routing matrix UI to show the updated channels
        if (window.updateRoutingMatrix) {
            window.updateRoutingMatrix();
        }
    }

    /**
     * Get status label for display
     */
    getStatusLabel(status) {
        const labels = {
            'not_configured': 'Not Configured',
            'configured': 'Ready',
            'active': 'Active'
        };
        return labels[status] || status;
    }

    /**
     * Update available interfaces
     */
    updateAvailableInterfaces(interfaces) {
        this.availableInterfaces = interfaces;
        this.updateConfigurationTable();
    }

    /**
     * Update assigned users display in device configuration table
     */
    updateAssignedUsers(assignments) {
        this.deviceAssignments = assignments || {};
        console.log('Updating device table with assignments:', this.deviceAssignments);
        
        // Update the configuration table to reflect new assignments
        if (this.elements.configTableBody) {
            this.updateConfigurationTable();
        }
    }

    /**
     * Get the user initials assigned to a specific device
     */
    getAssignedUserForDevice(deviceId) {
        // Search through assignments to find which track(s) have this device
        for (const trackNum in this.deviceAssignments) {
            const assignment = this.deviceAssignments[trackNum];
            if (assignment && assignment.deviceId === deviceId) {
                return assignment.userInitials || 'Unknown';
            }
        }
        return null; // No user assigned to this device
    }

    /**
     * Get configured devices for routing
     */
    getConfiguredDevices() {
        return this.configuredDevices;
    }

    /**
     * Get device configuration by ID
     */
    getDeviceConfig(deviceId) {
        console.log('getDeviceConfig looking for deviceId:', deviceId, 'type:', typeof deviceId);
        console.log('Available devices:', this.configuredDevices.map(d => ({id: d.id, name: d.name, color: d.color})));
        const device = this.configuredDevices.find(d => d.id === deviceId);
        console.log('Found device:', device ? {id: device.id, name: device.name, color: device.color} : null);
        return device;
    }

    /**
     * Get device information (handles both numeric IDs and "device:X" format)
     */
    getDeviceInfo(deviceId) {
        let actualDeviceId = deviceId;
        
        // Handle "device:X" format
        if (typeof deviceId === 'string' && deviceId.startsWith('device:')) {
            actualDeviceId = parseInt(deviceId.replace('device:', ''));
        }
        
        const device = this.getDeviceConfig(actualDeviceId);
        console.log('getDeviceInfo returning device:', device?.name, 'color:', device?.color, 'controllers:', device?.controllers?.length);
        
        const result = {
            ...device,
            controllers: Array.isArray(device.controllers) ? device.controllers : []
        };
        console.log('getDeviceInfo final result:', result);
        return result;
    }

    /**
     * Auto-save configuration to localStorage (silent)
     */
    autoSaveConfiguration() {
        try {
            const config = {
                version: 1,
                devices: this.configuredDevices,
                timestamp: new Date().toISOString()
            };
            localStorage.setItem('midiDeviceConfiguration', JSON.stringify(config));
            console.log('Device configuration auto-saved');
        } catch (error) {
            console.error('Failed to auto-save configuration:', error);
        }
    }

    /**
     * Download configuration as JSON file
     */
    saveConfiguration() {
        try {
            const config = {
                version: 2, // Updated version for new custom device format
                devices: this.configuredDevices,
                timestamp: new Date().toISOString(),
                exportedBy: 'MidiSocket Device Configuration',
                deviceCount: this.configuredDevices.length
            };
            
            // Create JSON blob
            const jsonString = JSON.stringify(config, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            
            // Create download link
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            
            // Generate filename with timestamp
            const now = new Date();
            const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
            a.download = `chaotic-pedalboard-config-${timestamp}.json`;
            
            // Trigger download
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            // Clean up
            URL.revokeObjectURL(url);
            
            console.log('Configuration exported successfully:', a.download);
        } catch (error) {
            console.error('Failed to export configuration:', error);
            alert('Failed to download configuration file.');
        }
    }

    /**
     * Load configuration from localStorage
     */
    loadConfiguration() {
        try {
            const configStr = localStorage.getItem('midiDeviceConfiguration');
            if (configStr) {
                const config = JSON.parse(configStr);
                this.configuredDevices = (config.devices || []).map((device, index) => {
                    // Migration: ensure all devices have required properties
                    const deviceId = device.id || device.deviceId || (this.nextDeviceId + index);
                    const controllers = (device.controllers || []).map(ctrl => {
                        if (ctrl.type === 'continuous') {
                            // Migrate: parse range string or default to 0-127
                            let minValue = ctrl.minValue;
                            let maxValue = ctrl.maxValue;
                            if (minValue === undefined || maxValue === undefined) {
                                const rangeMatch = (ctrl.range || '').match(/(\d+).*?(\d+)/);
                                minValue = rangeMatch ? parseInt(rangeMatch[1]) : 0;
                                maxValue = rangeMatch ? parseInt(rangeMatch[2]) : 127;
                            }
                            return { name: ctrl.name, ccNumber: ctrl.ccNumber, type: ctrl.type, minValue, maxValue };
                        }
                        return ctrl;
                    });
                    return {
                        id: parseInt(deviceId), // Ensure it's a number
                        name: device.name || 'Unknown Device',
                        color: device.color || '#4a90e2',
                        image: this.normalizeDeviceImagePath(device.image || ''),
                        controllers: controllers,
                        assignedInterface: device.assignedInterface || '',
                        assignedChannel: device.assignedChannel || 1,
                        status: device.status || 'not_configured'
                    };
                });
                
                // Update nextDeviceId to avoid conflicts with existing devices
                if (this.configuredDevices.length > 0) {
                    const maxId = Math.max(...this.configuredDevices.map(d => d.id));
                    this.nextDeviceId = maxId + 1;
                }
                
                console.log('Loaded device configuration:', this.configuredDevices);
                console.log('Next device ID set to:', this.nextDeviceId);
            }
        } catch (error) {
            console.error('Failed to load configuration:', error);
            this.configuredDevices = [];
        }
    }

    /**
     * Load configuration from file
     */
    loadConfigurationFile() {
        // Create hidden file input
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.style.display = 'none';
        
        fileInput.addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;
            
            try {
                // Read file content
                const text = await this.readFileAsText(file);
                const config = JSON.parse(text);
                
                // Validate configuration format
                if (!this.validateConfigurationFormat(config)) {
                    alert('Invalid configuration file format. Please check the file and try again.');
                    return;
                }
                
                // Confirm before replacing current configuration
                const deviceCount = config.devices ? config.devices.length : 0;
                const currentCount = this.configuredDevices.length;
                
                const confirmMessage = `Load configuration from "${file.name}"?\n\n` +
                    `This will replace your current ${currentCount} device(s) with ${deviceCount} device(s) from the file.\n\n` +
                    `This action cannot be undone.`;
                
                if (!confirm(confirmMessage)) {
                    return;
                }
                
                // Load the configuration
                this.loadConfigurationFromData(config);
                
                alert(`Configuration loaded successfully!\n${deviceCount} device(s) imported from "${file.name}"`);
                
            } catch (error) {
                console.error('Failed to load configuration file:', error);
                alert(`Failed to load configuration file:\n${error.message}`);
            } finally {
                // Clean up
                document.body.removeChild(fileInput);
            }
        });
        
        // Trigger file selection
        document.body.appendChild(fileInput);
        fileInput.click();
    }

    /**
     * Read file as text (Promise-based)
     */
    readFileAsText(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = () => reject(new Error('Failed to read file'));
            reader.readAsText(file);
        });
    }

    /**
     * Validate configuration file format
     */
    validateConfigurationFormat(config) {
        // Check basic structure
        if (!config || typeof config !== 'object') {
            return false;
        }
        
        // Check required properties
        if (!config.devices || !Array.isArray(config.devices)) {
            return false;
        }
        
        // Validate version (support v1 and v2)
        const version = config.version || 1;
        if (version !== 1 && version !== 2) {
            console.warn('Unsupported configuration version:', version);
            return false;
        }
        
        // Validate each device
        for (const device of config.devices) {
            if (!device || typeof device !== 'object') {
                return false;
            }
            
            // Check required device properties
            if (!device.name || typeof device.name !== 'string') {
                return false;
            }
            
            if (device.id === undefined || device.id === null) {
                return false;
            }
            
            // Validate controllers if present
            if (device.controllers && !Array.isArray(device.controllers)) {
                return false;
            }
            
            // Validate each controller
            if (device.controllers) {
                for (const controller of device.controllers) {
                    if (!controller || typeof controller !== 'object') {
                        return false;
                    }
                    
                    if (!controller.name || typeof controller.name !== 'string') {
                        return false;
                    }
                    
                    if (controller.ccNumber === undefined || controller.ccNumber === null) {
                        return false;
                    }
                    
                    if (!controller.type || (controller.type !== 'continuous' && controller.type !== 'discrete')) {
                        return false;
                    }
                }
            }
        }
        
        return true;
    }

    /**
     * Load configuration from parsed data
     */
    loadConfigurationFromData(config) {
        try {
            // Clear existing devices
            this.configuredDevices = [];
            
            // Find the highest existing ID to continue auto-incrementing
            let maxId = 0;
            
            // Load devices from config
            config.devices.forEach(device => {
                // Ensure device has all required properties with defaults
                const controllers = (device.controllers || []).map(ctrl => {
                    if (ctrl.type === 'continuous') {
                        let minValue = ctrl.minValue;
                        let maxValue = ctrl.maxValue;
                        if (minValue === undefined || maxValue === undefined) {
                            const rangeMatch = (ctrl.range || '').match(/(\d+).*?(\d+)/);
                            minValue = rangeMatch ? parseInt(rangeMatch[1]) : 0;
                            maxValue = rangeMatch ? parseInt(rangeMatch[2]) : 127;
                        }
                        return { name: ctrl.name, ccNumber: ctrl.ccNumber, type: ctrl.type, minValue, maxValue };
                    }
                    return ctrl;
                });
                const loadedDevice = {
                    id: device.id,
                    name: device.name,
                    color: device.color || '#4a90e2', // Default color if missing
                    image: this.normalizeDeviceImagePath(device.image || ''),
                    controllers: controllers,
                    assignedInterface: device.assignedInterface || '',
                    assignedChannel: device.assignedChannel || 1,
                    status: device.status || 'not_configured',
                    createdAt: device.createdAt || new Date().toISOString(),
                    updatedAt: device.updatedAt || device.createdAt || new Date().toISOString()
                };
                
                this.configuredDevices.push(loadedDevice);
                
                // Track highest ID
                if (typeof device.id === 'number' && device.id > maxId) {
                    maxId = device.id;
                }
            });
            
            // Update next device ID to continue from highest + 1
            this.nextDeviceId = maxId + 1;
            
            // Save to localStorage
            this.autoSaveConfiguration();
            
            // Update UI
            this.updateConfigurationTable();

            if (window.syncConfiguredDevicesToServer) {
                window.syncConfiguredDevicesToServer();
            }
            
            console.log(`Configuration loaded: ${this.configuredDevices.length} devices, next ID: ${this.nextDeviceId}`);
            
        } catch (error) {
            console.error('Failed to load configuration data:', error);
            throw new Error('Failed to process configuration data');
        }
    }

    /**
     * Show/hide configuration panel
     */
    toggleVisibility() {
        // Check current actual visibility state
        const isCurrentlyVisible = !this.elements.configPanel?.classList.contains('hidden');
        this.isVisible = !isCurrentlyVisible;
        
        if (this.isVisible) {
            this.elements.configPanel?.classList.remove('hidden');
        } else {
            this.elements.configPanel?.classList.add('hidden');
        }
        return this.isVisible;
    }

    /**
     * Check if panel is visible
     */
    getVisibility() {
        return this.isVisible;
    }

    /**
     * Show device edit modal (for custom devices, this shows the device creation form pre-filled)
     */
    showControllerSetup(deviceId) {
        const device = this.configuredDevices.find(d => d.id === deviceId);
        
        if (!device) {
            alert('Device not found.');
            return;
        }

        // For custom devices, show the device creation form with pre-filled data
        this.showEditDeviceModal(device);
    }

    /**
     * Show edit device modal with pre-filled data
     */
    showEditDeviceModal(device) {
        // Pre-fill the form with existing device data
        document.getElementById('device-name').value = device.name;
        document.getElementById('device-color').value = device.color;
        this.populateDeviceImageOptions(this.normalizeDeviceImagePath(device.image || ''));
        
        // Clear existing controllers and reset counter
        const container = document.getElementById('controllers-container');
        container.innerHTML = '';
        this.currentControllerCount = 0;
        
        // Add existing controllers
        (device.controllers || []).forEach(controller => {
            this.addControllerForm(controller);
        });
        
        // Update modal for editing mode
        const modal = document.getElementById('device-selection-modal');
        const modalTitle = modal.querySelector('.modal-header h3');
        const submitButton = modal.querySelector('button[type="submit"]');
        
        modalTitle.textContent = 'Edit Device';
        submitButton.textContent = 'Update Device';
        
        // Store device being edited
        this.editingDevice = device;
        
        // Show modal
        modal.classList.remove('hidden');
    }

    /**
     * Populate the controller list with checkboxes
     */
    populateControllerList(controls, selectedControllers) {
        if (!controls || controls.length === 0) {
            this.elements.controllerList.innerHTML = `
                <div class="empty-state">
                    <h4>No controllers available</h4>
                    <p>This device doesn't have any MIDI continuous controllers defined.</p>
                </div>
            `;
            return;
        }

        // Always show all controllers in the device configuration modal
        const selectedCount = selectedControllers.length;
        this.updateSelectedCount(selectedCount);

        this.elements.controllerList.innerHTML = controls.map((controller, index) => {
            const isSelected = selectedControllers.includes(controller.cc_number);
            const isDisabled = !isSelected && selectedCount >= config.MAX_CONTROLLERS_PER_DEVICE;
            
            return `
                <div class="controller-item ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}" 
                     data-cc="${controller.cc_number}">
                    <input type="checkbox" 
                           class="controller-checkbox" 
                           id="controller-${controller.cc_number}"
                           value="${controller.cc_number}"
                           ${isSelected ? 'checked' : ''}
                           ${isDisabled ? 'disabled' : ''}
                           onchange="deviceConfig.handleControllerSelection(this)">
                    <div class="controller-info">
                        <div class="controller-name">${controller.control_name}</div>
                        <div class="controller-details">
                            <span class="controller-cc">CC ${controller.cc_number}</span>
                            <span class="controller-range">${controller.value_range}</span>
                        </div>
                        ${controller.description ? `<div class="controller-description">${controller.description}</div>` : ''}
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Handle controller checkbox selection
     */
    handleControllerSelection(checkbox) {
        const ccNumber = parseInt(checkbox.value);
        const isChecked = checkbox.checked;
        const device = this.currentControllerSetupDevice;
        
        if (!device) return;

        // Initialize selectedControllers if it doesn't exist
        if (!device.selectedControllers) {
            device.selectedControllers = [];
        }

        if (isChecked) {
            // Add controller if not already selected and under limit
            if (!device.selectedControllers.includes(ccNumber) && device.selectedControllers.length < config.MAX_CONTROLLERS_PER_DEVICE) {
                device.selectedControllers.push(ccNumber);
            }
        } else {
            // Remove controller
            device.selectedControllers = device.selectedControllers.filter(cc => cc !== ccNumber);
        }

        // Update UI
        this.updateSelectedCount(device.selectedControllers.length);
        this.updateControllerItemStates();
        
        // Auto-save configuration
        this.autoSaveConfiguration();
        
        // Notify tracks using this device about the controller change
        this.notifyTracksOfDeviceChange(device.id);
    }

    /**
     * Update selected count display
     */
    updateSelectedCount(count) {
        if (this.elements.selectedCount) {
            this.elements.selectedCount.textContent = count;
        }
    }

    /**
     * Update controller item states (enable/disable based on selection limit)
     */
    updateControllerItemStates() {
        const device = this.currentControllerSetupDevice;
        if (!device) return;

        const selectedCount = device.selectedControllers.length;
        const controllerItems = this.elements.controllerList.querySelectorAll('.controller-item');
        
        controllerItems.forEach(item => {
            const checkbox = item.querySelector('.controller-checkbox');
            const ccNumber = parseInt(checkbox.value);
            const isSelected = device.selectedControllers.includes(ccNumber);
            
            // Update item classes
            item.classList.toggle('selected', isSelected);
            item.classList.toggle('disabled', !isSelected && selectedCount >= 8);
            
            // Update checkbox state
            checkbox.checked = isSelected;
            checkbox.disabled = !isSelected && selectedCount >= config.MAX_CONTROLLERS_PER_DEVICE;
        });
    }
}