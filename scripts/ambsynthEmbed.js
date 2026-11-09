(function (global) {
  const DEFAULT_OPTIONS = {
    className: 'ambsynth-inline-root',
    minHeight: '100%',
    background: '#2f3947',
    borderRadius: '8px',
    showHud: false,
    style: null
  };

  const BASE_CONFIG = {
    envelope: { attack: 500, release: 2000 },
    touch: {
      thresholdMs: 180,
      shortReleaseMs: 2000,
      shortFrequencyMultiplier: 1.5,
      shortQMultiplier: 2
    },
    filter: { minFreq: 30, maxFreq: 300, minQ: 0.7, maxQ: 24 },
    mapping: { xAxisTarget: 'filterQ' },
    lfo: {
      minFreq: 0,
      maxFreq: 4,
      minAmount: 0,
      maxAmount: 50,
      touchControlsEnabled: false,
      staticFreq: 0,
      staticAmount: 0
    },
    noise: { gain: 0.9 },
    output: {
      gain: 2.2,
      limiterThreshold: -10,
      limiterKnee: 20,
      limiterRatio: 8,
      limiterAttack: 0.003,
      limiterRelease: 0.2
    },
    ui: { showHud: false }
  };

  // Reference phone width used to scale the overlay on smaller/larger canvases
  // (e.g. the /ambgrid cells), so circle and lines keep their proportions.
  const OVERLAY_REFERENCE_WIDTH = 390;
  const OVERLAY_CIRCLE_RADIUS = 18;
  const OVERLAY_LINE_WIDTH = 3.5;
  const OVERLAY_LINE_GAP = 6; // space between circle outline and crosshair

  function parseHexColor(hex) {
    const match = /^#?([0-9a-f]{6})$/i.exec(`${hex || ''}`.trim());
    if (!match) return null;
    const value = parseInt(match[1], 16);
    return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  }

  // 50% white or black, whichever contrasts more with the background (WCAG).
  function inkFor(background) {
    const rgb = parseHexColor(background);
    if (!rgb) return 'rgba(255, 255, 255, 0.5)';
    const [r, g, b] = rgb.map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const contrastWithWhite = 1.05 / (luminance + 0.05);
    const contrastWithBlack = (luminance + 0.05) / 0.05;
    return contrastWithBlack > contrastWithWhite ? 'rgba(0, 0, 0, 0.5)' : 'rgba(255, 255, 255, 0.5)';
  }

  // Draws the circle outline + crosshair for a point (canvas px) at the given
  // opacity. The crosshair is 4 segments that stop short of the circle.
  function drawOverlay(ctx, width, height, point, opacity, ink, showLines) {
    if (!point || opacity <= 0) return;
    const scale = Math.min(1, width / OVERLAY_REFERENCE_WIDTH);
    const radius = Math.max(3, OVERLAY_CIRCLE_RADIUS * scale);
    const lineWidth = Math.max(1, OVERLAY_LINE_WIDTH * scale);
    const gap = radius + lineWidth / 2 + Math.max(2, OVERLAY_LINE_GAP * scale);
    ctx.save();
    ctx.globalAlpha = Math.min(1, opacity);
    ctx.strokeStyle = ink;
    ctx.lineWidth = lineWidth;

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    if (showLines) {
      ctx.beginPath();
      if (point.y - gap > 0) { ctx.moveTo(point.x, 0); ctx.lineTo(point.x, point.y - gap); }
      if (point.y + gap < height) { ctx.moveTo(point.x, point.y + gap); ctx.lineTo(point.x, height); }
      if (point.x - gap > 0) { ctx.moveTo(0, point.y); ctx.lineTo(point.x - gap, point.y); }
      if (point.x + gap < width) { ctx.moveTo(point.x + gap, point.y); ctx.lineTo(width, point.y); }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Short-tap ripple: a single ring growing from the circle size to a fraction
  // of the canvas width, fading out. progress runs 0..1 over the fade.
  const RIPPLE_MAX_RADIUS_RATIO = 0.7;
  const MAX_RIPPLES = 8; // per participant; oldest dropped past this

  function drawRipple(ctx, width, height, point, progress, ink) {
    if (!point || progress >= 1) return;
    const t = Math.max(0, progress);
    const scale = Math.min(1, width / OVERLAY_REFERENCE_WIDTH);
    const startRadius = Math.max(3, OVERLAY_CIRCLE_RADIUS * scale);
    const endRadius = Math.max(startRadius, width * RIPPLE_MAX_RADIUS_RATIO);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out: fast start, slows down
    ctx.save();
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(1, OVERLAY_LINE_WIDTH * scale);
    ctx.beginPath();
    ctx.arc(point.x, point.y, startRadius + (endRadius - startRadius) * eased, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Initials label: bottom-left, low opacity, drawn beneath the touch overlay.
  const INITIALS_OPACITY = 0.7;     // on top of the 50% ink -> ~35% visible
  const INITIALS_SIZE_RATIO = 0.08; // font size as a fraction of canvas width

  function drawInitials(ctx, width, height, initials, ink) {
    if (!initials) return;
    const fontSize = Math.max(10, width * INITIALS_SIZE_RATIO);
    const margin = fontSize * 0.6;
    ctx.save();
    ctx.globalAlpha = INITIALS_OPACITY;
    ctx.fillStyle = ink;
    ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(initials, margin, height - margin * 0.6);
    ctx.restore();
  }

  function isElement(value) {
    return value && typeof value === 'object' && value.nodeType === 1;
  }

  function resolveContainer(container) {
    if (typeof container === 'string') {
      const element = document.querySelector(container);
      if (!element) {
        throw new Error('AmbSynthEmbed: container selector not found: ' + container);
      }
      return element;
    }

    if (isElement(container)) {
      return container;
    }

    if (!container) {
      return document.body;
    }

    throw new Error('AmbSynthEmbed: container must be a DOM element or selector');
  }

  function cloneConfig(showHud) {
    return {
      envelope: { ...BASE_CONFIG.envelope },
      touch: { ...BASE_CONFIG.touch },
      filter: { ...BASE_CONFIG.filter },
      mapping: { ...BASE_CONFIG.mapping },
      lfo: { ...BASE_CONFIG.lfo },
      noise: { ...BASE_CONFIG.noise },
      output: { ...BASE_CONFIG.output },
      ui: { showHud: !!showHud }
    };
  }

  function mount(container, options = {}) {
    const target = resolveContainer(container);
    const config = { ...DEFAULT_OPTIONS, ...options };
    const CONFIG = cloneConfig(config.showHud);

    const root = document.createElement('div');
    root.className = config.className;
    root.style.position = 'relative';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.minHeight = config.minHeight;
    root.style.overflow = 'hidden';
    root.style.background = config.background;
    root.style.borderRadius = config.borderRadius;
    root.style.touchAction = 'none';
    if (config.style && typeof config.style === 'object') {
      Object.assign(root.style, config.style);
    }

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.touchAction = 'none';

    const statusEl = document.createElement('div');
    statusEl.style.position = 'absolute';
    statusEl.style.top = '12px';
    statusEl.style.left = '12px';
    statusEl.style.zIndex = '2';
    statusEl.style.minWidth = '240px';
    statusEl.style.maxWidth = 'calc(100% - 24px)';
    statusEl.style.padding = '10px 12px';
    statusEl.style.borderRadius = '10px';
    statusEl.style.background = 'rgba(15, 23, 42, 0.78)';
    statusEl.style.border = '1px solid rgba(103, 232, 249, 0.45)';
    statusEl.style.color = '#e5e7eb';
    statusEl.style.font = "12px/1.35 Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
    statusEl.style.pointerEvents = 'none';
    statusEl.style.whiteSpace = 'pre-line';
    statusEl.textContent = 'initializing...';

    const audioUnlockEl = document.createElement('div');
    audioUnlockEl.style.position = 'absolute';
    audioUnlockEl.style.inset = '0';
    audioUnlockEl.style.zIndex = '3';
    audioUnlockEl.style.display = 'flex';
    audioUnlockEl.style.alignItems = 'center';
    audioUnlockEl.style.justifyContent = 'center';
    audioUnlockEl.style.background = 'rgba(2, 6, 23, 0.72)';
    audioUnlockEl.style.touchAction = 'manipulation';

    const audioUnlockButton = document.createElement('button');
    audioUnlockButton.type = 'button';
    audioUnlockButton.style.border = '1px solid rgba(103, 232, 249, 0.7)';
    audioUnlockButton.style.background = 'rgba(15, 23, 42, 0.95)';
    audioUnlockButton.style.color = '#e5e7eb';
    audioUnlockButton.style.padding = '14px 18px';
    audioUnlockButton.style.borderRadius = '12px';
    audioUnlockButton.style.font = "16px/1.35 Menlo, Monaco, Consolas, 'Liberation Mono', monospace";
    audioUnlockButton.style.touchAction = 'manipulation';
    audioUnlockButton.style.whiteSpace = 'pre-line';
    audioUnlockButton.style.textAlign = 'left';
    audioUnlockButton.textContent = '1. Turn up the volume\n2. Turn off silent mode\n3. Tap here to enable audio';

    audioUnlockEl.appendChild(audioUnlockButton);
    root.appendChild(canvas);
    root.appendChild(audioUnlockEl);
    root.appendChild(statusEl);
    target.appendChild(root);

    const ctx = canvas.getContext('2d');

    let audioContext = null;
    let isPlaying = false;
    let startTime = null;
    let noiseSource = null;
    let noiseGain = null;
    let filter = null;
    let lfoOscillator = null;
    let lfoGain = null;
    let masterGain = null;
    let limiter = null;

    let isMouseDown = false;
    let activeTouchId = null;
    let activePointerId = null;
    let activePoint = null;
    let persistentPoint = null;
    let isTouching = false;

    let lastFilterFreq = 0;
    let lastFilterQ = 0;
    let lastNormalizedX = 0;
    let lastNormalizedY = 0;
    let lastStatusNote = 'ready';
    let resumeAttemptCount = 0;
    let audioUnlocked = false;
    let unlockError = 'none';
    let unlockInProgress = false;
    let lastUnlockTriggerAt = 0;
    let touchStartAt = 0;
    let touchThresholdTimer = null;
    let touchVoiceStarted = false;
    let touchVoiceMode = null;
    const unlockButtonDefaultLabel = '1. Turn up the volume\n2. Turn off silent mode\n3. Tap here to enable audio';
    let frameId = null;
    let resizeObserver = null;

    function updateAudioUnlockUI() {
      audioUnlockEl.style.display = audioUnlocked ? 'none' : 'flex';
    }

    function refreshAudioUnlockState() {
      audioUnlocked = !!(audioContext && audioContext.state === 'running');
      updateAudioUnlockUI();
    }

    function initAudioContext() {
      if (audioContext) return;
      const AudioContextCtor = global.AudioContext || global.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('Web Audio API is not supported in this browser');
      }

      audioContext = new AudioContextCtor();
      masterGain = audioContext.createGain();

      limiter = audioContext.createDynamicsCompressor();
      limiter.threshold.value = CONFIG.output.limiterThreshold;
      limiter.knee.value = CONFIG.output.limiterKnee;
      limiter.ratio.value = CONFIG.output.limiterRatio;
      limiter.attack.value = CONFIG.output.limiterAttack;
      limiter.release.value = CONFIG.output.limiterRelease;

      masterGain.connect(limiter);
      limiter.connect(audioContext.destination);
      masterGain.gain.value = CONFIG.output.gain;

      if (typeof audioContext.addEventListener === 'function') {
        audioContext.addEventListener('statechange', () => {
          refreshAudioUnlockState();
          updateStatus();
        });
      }
    }

    async function ensureAudioRunning(source = 'gesture') {
      if (!audioContext) {
        unlockError = 'AudioContext not initialized; tap unlock button';
        lastStatusNote = 'audio locked';
        updateStatus();
        return false;
      }

      if (audioContext.state === 'running') {
        audioUnlocked = true;
        updateAudioUnlockUI();
        updateStatus();
        return true;
      }

      resumeAttemptCount += 1;
      try {
        await audioContext.resume();

        const unlockOsc = audioContext.createOscillator();
        const unlockGain = audioContext.createGain();
        unlockGain.gain.setValueAtTime(0.00001, audioContext.currentTime);
        unlockOsc.connect(unlockGain);
        unlockGain.connect(audioContext.destination);
        unlockOsc.start();
        unlockOsc.stop(audioContext.currentTime + 0.01);

        unlockError = 'none';
        audioUnlocked = audioContext.state === 'running';
        lastStatusNote = 'audio unlocked by ' + source;
        updateAudioUnlockUI();
        updateStatus();
        return audioUnlocked;
      } catch (error) {
        unlockError = error && error.message ? error.message : 'unknown resume error';
        audioUnlocked = false;
        lastStatusNote = 'resume failed: ' + unlockError;
        updateAudioUnlockUI();
        updateStatus();
        return false;
      }
    }

    async function unlockAudioFromButton(source) {
      refreshAudioUnlockState();
      if (unlockInProgress || (audioContext && audioContext.state === 'running' && audioUnlocked)) {
        return;
      }

      unlockInProgress = true;
      audioUnlockButton.disabled = true;
      audioUnlockButton.textContent = 'Enabling Audio...';

      if (!audioContext) {
        initAudioContext();
      }

      const running = await ensureAudioRunning(source);
      if (!running) {
        lastStatusNote = 'unlock failed; retry button';
        audioUnlockButton.disabled = false;
        audioUnlockButton.textContent = unlockButtonDefaultLabel;
        unlockInProgress = false;
        updateStatus();
        return;
      }

      audioUnlockButton.disabled = false;
      audioUnlockButton.textContent = unlockButtonDefaultLabel;
      unlockInProgress = false;
      lastStatusNote = 'audio ready';
      updateAudioUnlockUI();
      updateStatus();
    }

    function createWhiteNoiseSource() {
      const bufferSize = audioContext.sampleRate * 2;
      const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) {
        data[i] = Math.random() * 2 - 1;
      }

      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      return source;
    }

    function startSynth(attackMs = CONFIG.envelope.attack) {
      if (isPlaying) return;

      isPlaying = true;
      const now = audioContext.currentTime;
      startTime = now;

      noiseSource = createWhiteNoiseSource();
      noiseGain = audioContext.createGain();
      noiseGain.gain.cancelScheduledValues(now);
      noiseGain.gain.setValueAtTime(0, now);
      noiseSource.connect(noiseGain);

      filter = audioContext.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(120, now);
      filter.Q.value = (CONFIG.filter.minQ + CONFIG.filter.maxQ) / 2;
      noiseGain.connect(filter);

      lfoOscillator = audioContext.createOscillator();
      lfoOscillator.type = 'sine';
      lfoOscillator.frequency.setValueAtTime(5, now);

      lfoGain = audioContext.createGain();
      lfoGain.gain.setValueAtTime(0, now);
      lfoOscillator.connect(lfoGain);
      lfoGain.connect(filter.frequency);

      filter.connect(masterGain);

      noiseSource.start();
      lfoOscillator.start();

      const attackTime = attackMs / 1000;
      noiseGain.gain.cancelScheduledValues(now);
      noiseGain.gain.setValueAtTime(0, now);
      noiseGain.gain.linearRampToValueAtTime(CONFIG.noise.gain, now + attackTime);

      lastStatusNote = 'synth started';
      updateStatus();
    }

    function stopSynth(releaseMs = CONFIG.envelope.release) {
      if (!isPlaying) return;

      isPlaying = false;
      if (!noiseGain || !noiseSource || !lfoOscillator) {
        return;
      }

      const localNoiseSource = noiseSource;
      const localLfoOscillator = lfoOscillator;
      const localNoiseGain = noiseGain;
      const now = audioContext.currentTime;
      const releaseTime = releaseMs / 1000;

      localNoiseGain.gain.cancelScheduledValues(now);
      localNoiseGain.gain.setValueAtTime(localNoiseGain.gain.value, now);
      localNoiseGain.gain.linearRampToValueAtTime(0, now + releaseTime);

      global.setTimeout(() => {
        try {
          localNoiseSource.stop();
        } catch (_e) {}
        try {
          localLfoOscillator.stop();
        } catch (_e) {}

        if (noiseSource === localNoiseSource) {
          noiseSource = null;
        }
        if (lfoOscillator === localLfoOscillator) {
          lfoOscillator = null;
        }
        if (noiseGain === localNoiseGain) {
          noiseGain = null;
          filter = null;
          lfoGain = null;
        }

        lastStatusNote = 'synth stopped';
        updateStatus();
      }, releaseMs);
    }

    function clearTouchThresholdTimer() {
      if (touchThresholdTimer) {
        global.clearTimeout(touchThresholdTimer);
        touchThresholdTimer = null;
      }
    }

    function startLongTouchVoiceIfActive() {
      if (!isTouching || touchVoiceStarted || !audioUnlocked || !audioContext || audioContext.state !== 'running') {
        return;
      }

      touchVoiceStarted = true;
      touchVoiceMode = 'long';
      startSynth(CONFIG.envelope.attack);
      updateTouchParameters();
      lastStatusNote = 'long touch voice started';
      updateStatus();
    }

    function updateSynthParameters(normalizedX, normalizedY) {
      if (!isPlaying || !filter || !lfoOscillator || !lfoGain) return;

      const yFilterFreq = CONFIG.filter.maxFreq - (normalizedY * (CONFIG.filter.maxFreq - CONFIG.filter.minFreq));
      const xFilterFreq = CONFIG.filter.minFreq + (normalizedX * (CONFIG.filter.maxFreq - CONFIG.filter.minFreq));
      const xFilterQ = CONFIG.filter.minQ + (normalizedX * (CONFIG.filter.maxQ - CONFIG.filter.minQ));
      const touchQMultiplier = touchVoiceMode === 'short' ? CONFIG.touch.shortQMultiplier : 1;
      const touchFrequencyMultiplier = touchVoiceMode === 'short' ? CONFIG.touch.shortFrequencyMultiplier : 1;

      const appliedFilterFreq = CONFIG.mapping.xAxisTarget === 'filterFrequency' ? xFilterFreq : yFilterFreq;
      filter.frequency.setTargetAtTime(appliedFilterFreq * touchFrequencyMultiplier, audioContext.currentTime, 0.01);

      if (CONFIG.mapping.xAxisTarget === 'filterQ') {
        filter.Q.setTargetAtTime(xFilterQ * touchQMultiplier, audioContext.currentTime, 0.01);
      }

      const lfoFreq = CONFIG.lfo.touchControlsEnabled ? normalizedX * CONFIG.lfo.maxFreq : CONFIG.lfo.staticFreq;
      lfoOscillator.frequency.setTargetAtTime(lfoFreq, audioContext.currentTime, 0.01);

      const lfoAmount = CONFIG.lfo.touchControlsEnabled
        ? (normalizedX * (CONFIG.lfo.maxAmount - CONFIG.lfo.minAmount)) + CONFIG.lfo.minAmount
        : CONFIG.lfo.staticAmount;
      const lfoDepth = (lfoAmount / 100) * (CONFIG.filter.maxFreq - CONFIG.filter.minFreq);
      lfoGain.gain.setTargetAtTime(lfoDepth, audioContext.currentTime, 0.01);
    }

    function updateStatus() {
      statusEl.style.display = CONFIG.ui.showHud ? 'block' : 'none';
      if (!CONFIG.ui.showHud) {
        return;
      }

      const ctxState = audioContext ? audioContext.state : 'not-created';
      const engineReady = (isPlaying && noiseSource && noiseGain && filter && lfoOscillator && lfoGain) ? 'yes' : 'no';
      const lines = [
        'status: ' + lastStatusNote,
        'audioContext: ' + ctxState,
        'resumeAttempts: ' + resumeAttemptCount,
        'audioUnlocked: ' + (audioUnlocked ? 'yes' : 'no'),
        'unlockInProgress: ' + (unlockInProgress ? 'yes' : 'no'),
        'unlockError: ' + unlockError,
        'isPlaying: ' + (isPlaying ? 'yes' : 'no'),
        'engineReady: ' + engineReady,
        'touching: ' + (isTouching ? 'yes' : 'no'),
        'touchMode: ' + (touchVoiceMode || 'pending'),
        'x: ' + Math.round(lastNormalizedX * 100) + '%',
        'y: ' + Math.round(lastNormalizedY * 100) + '%',
        'xTarget: ' + CONFIG.mapping.xAxisTarget,
        'touchMod: ' + (CONFIG.lfo.touchControlsEnabled ? 'on' : 'off'),
        'filterHz(y): ' + Math.round(lastFilterFreq),
        'filterQ(x): ' + lastFilterQ.toFixed(2),
        'shortFreqMul: ' + CONFIG.touch.shortFrequencyMultiplier,
        'shortQMul: ' + CONFIG.touch.shortQMultiplier
      ];
      statusEl.textContent = lines.join('\n');
    }

    const colors = {
      background: config.background,
      ink: inkFor(config.background)
    };
    const initialsLabel = typeof config.initials === 'string' ? config.initials : '';

    // Long touch: circle + crosshair fade after lift (cut off by a new touch).
    // Short tap: ripple ring; ripples overlap and outlive new touches.
    // Both last CONFIG.envelope.release (matches the sound release).
    let fadePoint = null;
    let fadeStartedAt = null;
    let ripples = []; // [{ point, startedAt }]
    let animationFrameId = null;

    // Optional mirror callback: onTouch({ phase: 'down'|'move'|'up', x, y })
    // ('up' also carries short: true|false)
    // with x/y normalized 0..1. Moves are coalesced to one per frame.
    const onTouch = typeof config.onTouch === 'function' ? config.onTouch : null;
    let pendingMove = null;
    let moveFrameId = null;

    function normalizedPoint(point) {
      const bounds = canvas.getBoundingClientRect();
      return {
        x: bounds.width > 0 ? Math.max(0, Math.min(1, point.x / bounds.width)) : 0,
        y: bounds.height > 0 ? Math.max(0, Math.min(1, point.y / bounds.height)) : 0
      };
    }

    function emitTouch(phase, point, extra) {
      if (!onTouch || !point) return;
      if (phase === 'move') {
        pendingMove = normalizedPoint(point);
        if (moveFrameId === null) {
          moveFrameId = global.requestAnimationFrame(() => {
            moveFrameId = null;
            if (pendingMove) {
              onTouch({ phase: 'move', ...pendingMove });
              pendingMove = null;
            }
          });
        }
        return;
      }
      if (moveFrameId !== null) {
        global.cancelAnimationFrame(moveFrameId);
        moveFrameId = null;
      }
      pendingMove = null;
      onTouch({ phase, ...normalizedPoint(point), ...(extra || {}) });
    }

    // Redraws every frame while a fade or ripple is running.
    function ensureAnimating() {
      if (animationFrameId !== null) return;
      const step = () => {
        draw();
        animationFrameId = (fadePoint || ripples.length > 0)
          ? global.requestAnimationFrame(step)
          : null;
      };
      animationFrameId = global.requestAnimationFrame(step);
    }

    function stopAnimating() {
      if (animationFrameId !== null) {
        global.cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
    }

    // Cuts off the long-touch fade only; ripples keep going.
    function stopFade() {
      fadePoint = null;
      fadeStartedAt = null;
    }

    function startFade(point, isShortTap) {
      stopFade();
      if (!point) return;
      if (isShortTap) {
        ripples.push({ point: { ...point }, startedAt: global.performance.now() });
        if (ripples.length > MAX_RIPPLES) ripples = ripples.slice(-MAX_RIPPLES);
      } else {
        fadePoint = { ...point };
        fadeStartedAt = global.performance.now();
      }
      ensureAnimating();
    }

    function resizeCanvas() {
      const dpr = global.devicePixelRatio || 1;
      const bounds = canvas.getBoundingClientRect();
      canvas.width = Math.round(bounds.width * dpr);
      canvas.height = Math.round(bounds.height * dpr);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function getCanvasPoint(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: clientX - rect.left,
        y: clientY - rect.top
      };
    }

    function draw() {
      const bounds = canvas.getBoundingClientRect();
      const width = bounds.width;
      const height = bounds.height;

      ctx.fillStyle = colors.background;
      ctx.fillRect(0, 0, width, height);
      drawInitials(ctx, width, height, initialsLabel, colors.ink);

      const now = global.performance.now();
      const fadeMs = CONFIG.envelope.release;
      ripples = ripples.filter(ripple => now - ripple.startedAt < fadeMs);
      ripples.forEach((ripple) => {
        drawRipple(ctx, width, height, ripple.point, (now - ripple.startedAt) / fadeMs, colors.ink);
      });

      if (isTouching && activePoint) {
        drawOverlay(ctx, width, height, activePoint, 1, colors.ink, true);
      } else if (fadePoint) {
        const opacity = 1 - ((now - fadeStartedAt) / fadeMs);
        if (opacity > 0) {
          drawOverlay(ctx, width, height, fadePoint, opacity, colors.ink, true);
        } else {
          stopFade();
        }
      }
    }

    function setBackground(color) {
      if (!parseHexColor(color)) return;
      colors.background = color;
      colors.ink = inkFor(color);
      root.style.background = color;
      draw();
    }

    function beginInteraction(clientX, clientY, source) {
      stopFade();
      activePoint = getCanvasPoint(clientX, clientY);
      persistentPoint = { ...activePoint };
      isTouching = true;
      emitTouch('down', activePoint);
      touchStartAt = global.performance.now();
      touchVoiceStarted = false;
      touchVoiceMode = null;
      lastStatusNote = source + ' start';
      refreshAudioUnlockState();
      updateStatus();

      if (!audioUnlocked || !audioContext || audioContext.state !== 'running') {
        lastStatusNote = 'audio still locked; use enable button';
        updateStatus();
        updateTouchParameters();
        draw();
        return;
      }

      clearTouchThresholdTimer();
      touchThresholdTimer = global.setTimeout(startLongTouchVoiceIfActive, CONFIG.touch.thresholdMs);

      updateTouchParameters();
      draw();
    }

    function moveInteraction(clientX, clientY, source) {
      if (!isTouching) {
        return;
      }

      activePoint = getCanvasPoint(clientX, clientY);
      persistentPoint = { ...activePoint };
      emitTouch('move', activePoint);
      lastStatusNote = source + ' move';
      updateTouchParameters();
      draw();
    }

    function endInteraction(source) {
      if (!isTouching) {
        return;
      }

      const touchDurationMs = global.performance.now() - touchStartAt;
      const wasShortTouch = touchDurationMs < CONFIG.touch.thresholdMs;

      clearTouchThresholdTimer();
      emitTouch('up', persistentPoint, { short: wasShortTouch });
      startFade(persistentPoint, wasShortTouch);
      activePoint = null;
      isTouching = false;

      if (wasShortTouch) {
        touchVoiceMode = 'short';
        if (!touchVoiceStarted) {
          startSynth(0);
          touchVoiceStarted = true;
        }
        updateTouchParameters();
        stopSynth(CONFIG.touch.shortReleaseMs);
      } else {
        touchVoiceMode = 'long';
        stopSynth(CONFIG.envelope.release);
      }

      lastStatusNote = source + ' end';
      updateStatus();
      draw();
    }

    function onPointerDown(event) {
      event.preventDefault();
      if (activePointerId !== null || isTouching) {
        return;
      }

      activePointerId = event.pointerId;
      if (canvas.setPointerCapture) {
        canvas.setPointerCapture(activePointerId);
      }
      beginInteraction(event.clientX, event.clientY, 'pointer');
    }

    function onPointerMove(event) {
      if (activePointerId === null || event.pointerId !== activePointerId) {
        return;
      }

      event.preventDefault();
      moveInteraction(event.clientX, event.clientY, 'pointer');
    }

    function onPointerUp(event) {
      if (activePointerId === null || event.pointerId !== activePointerId) {
        return;
      }

      event.preventDefault();
      if (canvas.releasePointerCapture) {
        canvas.releasePointerCapture(activePointerId);
      }
      activePointerId = null;
      endInteraction('pointer');
    }

    function onTouchStart(event) {
      event.preventDefault();
      if (activeTouchId !== null || isTouching) {
        return;
      }

      const touch = event.changedTouches[0];
      if (!touch) {
        return;
      }

      activeTouchId = touch.identifier;
      beginInteraction(touch.clientX, touch.clientY, 'touch');
    }

    function onTouchMove(event) {
      event.preventDefault();
      if (activeTouchId === null) {
        return;
      }

      let touch = null;
      for (const t of event.changedTouches) {
        if (t.identifier === activeTouchId) {
          touch = t;
          break;
        }
      }

      if (!touch) {
        return;
      }

      moveInteraction(touch.clientX, touch.clientY, 'touch');
    }

    function onTouchEnd(event) {
      event.preventDefault();
      if (activeTouchId === null) {
        return;
      }

      for (const t of event.changedTouches) {
        if (t.identifier === activeTouchId) {
          activeTouchId = null;
          endInteraction('touch');
          break;
        }
      }
    }

    function onMouseDown(event) {
      event.preventDefault();
      if (isMouseDown) {
        return;
      }

      isMouseDown = true;
      beginInteraction(event.clientX, event.clientY, 'mouse');
    }

    function onMouseMove(event) {
      if (!isMouseDown) {
        return;
      }

      moveInteraction(event.clientX, event.clientY, 'mouse');
    }

    function onMouseUp(event) {
      if (!isMouseDown) {
        return;
      }

      event.preventDefault();
      isMouseDown = false;
      endInteraction('mouse');
    }

    function updateTouchParameters() {
      if (!persistentPoint) return;

      const bounds = canvas.getBoundingClientRect();
      const width = bounds.width;
      const height = bounds.height;

      const normalizedX = Math.max(0, Math.min(1, persistentPoint.x / width));
      const normalizedY = Math.max(0, Math.min(1, persistentPoint.y / height));

      const yFilterFreq = CONFIG.filter.maxFreq - (normalizedY * (CONFIG.filter.maxFreq - CONFIG.filter.minFreq));
      const xFilterFreq = CONFIG.filter.minFreq + (normalizedX * (CONFIG.filter.maxFreq - CONFIG.filter.minFreq));
      const xFilterQ = CONFIG.filter.minQ + (normalizedX * (CONFIG.filter.maxQ - CONFIG.filter.minQ));
      const displayedFilterFreq = CONFIG.mapping.xAxisTarget === 'filterFrequency'
        ? (touchVoiceMode === 'short' ? xFilterFreq * CONFIG.touch.shortFrequencyMultiplier : xFilterFreq)
        : yFilterFreq;

      lastNormalizedX = normalizedX;
      lastNormalizedY = normalizedY;
      lastFilterFreq = displayedFilterFreq;
      lastFilterQ = xFilterQ;
      updateStatus();

      updateSynthParameters(normalizedX, normalizedY);
    }

    async function onUnlockGesture(event, source) {
      event.preventDefault();
      event.stopPropagation();

      const now = global.performance.now();
      if (now - lastUnlockTriggerAt < 300) {
        return;
      }
      lastUnlockTriggerAt = now;

      await unlockAudioFromButton(source);
    }

    canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
    canvas.addEventListener('pointermove', onPointerMove, { passive: false });
    canvas.addEventListener('pointerup', onPointerUp, { passive: false });
    canvas.addEventListener('pointercancel', onPointerUp, { passive: false });

    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });
    canvas.addEventListener('mousedown', onMouseDown);
    global.addEventListener('mousemove', onMouseMove);
    global.addEventListener('mouseup', onMouseUp);
    global.addEventListener('resize', resizeCanvas);

    audioUnlockButton.addEventListener('pointerup', async (event) => {
      await onUnlockGesture(event, 'unlock-button-pointerup');
    }, { passive: false });

    audioUnlockButton.addEventListener('click', async (event) => {
      await onUnlockGesture(event, 'unlock-button-click');
    });

    audioUnlockEl.addEventListener('pointerup', async (event) => {
      await onUnlockGesture(event, 'unlock-overlay-pointerup');
    }, { passive: false });

    audioUnlockEl.addEventListener('click', async (event) => {
      await onUnlockGesture(event, 'unlock-overlay-click');
    });

    if (global.ResizeObserver) {
      resizeObserver = new global.ResizeObserver(resizeCanvas);
      resizeObserver.observe(root);
    }

    resizeCanvas();
    draw();
    updateAudioUnlockUI();
    updateStatus();

    return {
      root,
      show() {
        root.style.display = 'block';
        resizeCanvas();
      },
      hide() {
        root.style.display = 'none';
      },
      setBackground,
      destroy() {
        if (isPlaying) {
          stopSynth(80);
        }
        stopFade();
        ripples = [];
        stopAnimating();
        if (moveFrameId !== null) {
          global.cancelAnimationFrame(moveFrameId);
          moveFrameId = null;
        }

        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointercancel', onPointerUp);
        canvas.removeEventListener('touchstart', onTouchStart);
        canvas.removeEventListener('touchmove', onTouchMove);
        canvas.removeEventListener('touchend', onTouchEnd);
        canvas.removeEventListener('touchcancel', onTouchEnd);
        canvas.removeEventListener('mousedown', onMouseDown);

        global.removeEventListener('mousemove', onMouseMove);
        global.removeEventListener('mouseup', onMouseUp);
        global.removeEventListener('resize', resizeCanvas);

        if (resizeObserver) {
          resizeObserver.disconnect();
        }

        if (root.parentNode) {
          root.parentNode.removeChild(root);
        }
      },
      getConfig() {
        return { ...CONFIG };
      }
    };
  }

  global.AmbSynthEmbed = {
    mount,
    create: mount,
    inkFor,
    drawOverlay,
    drawInitials,
    drawRipple,
    MAX_RIPPLES,
    version: '0.4.0-mirror'
  };
})(typeof window !== 'undefined' ? window : this);
