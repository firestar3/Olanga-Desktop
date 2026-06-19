/* ============================================
   OLANGA VOICE ASSISTANT - RENDERER
   Uses Vosk (WASM) for local Wake Word detection,
   then raw PCM capture → WAV encoding → NVIDIA Magpie TTS
   ============================================ */

// ---- State Machine ----
const State = {
  IDLE: 'idle',           // Monitoring mic with Vosk for "Hey Olanga"
  LISTENING: 'listening', // Recording user query (post-wake-word)
  THINKING: 'thinking',   // Waiting for AI response
  SPEAKING: 'speaking'    // Speaking the response
};

let currentState = State.IDLE;
let apiKeys = [];
let apiKeyRotation = false;
let currentKeyIndex = 0;
let apiKey = ''; // current active key
let nvidiaApiKey = ''; // NVIDIA API key for TTS
const defaultNvidiaFunctionId = 'ddacc747-1269-4fab-bfd9-8f593dead106';
const defaultNvidiaVoiceName = 'Magpie-Multilingual.EN-US.Aria';
let nvidiaVoiceName = localStorage.getItem('olanga_nvidia_voice') || defaultNvidiaVoiceName;
let nvidiaFunctionId = localStorage.getItem('olanga_nvidia_function_id') || defaultNvidiaFunctionId;
let ttsRate = Number.parseFloat(localStorage.getItem('olanga_tts_rate') || '1.05');
let nvidiaVoiceCatalog = [];
let userCity = '';
let userState = '';
let userCountry = '';
let synthesis = window.speechSynthesis;
let conversationHistory = []; // {role: 'user'|'model', text: '...'}
let orbCanvasCtx = null;
let animationFrameId = null;

// Audio capture
let audioContext = null;
let analyser = null;
let micStream = null;
let scriptNode = null;
let pcmChunks = [];
let isRecording = false;
let speechStartTime = null;
let silenceStartTime = null;
let followUpTimer = null;
let currentRMS = 0;
let hasSpokenDuringRecording = false;
let currentTTSAudio = null; // Reference to current TTS audio element
let isMuted = false;
let currentVolume = 0.8; // 0-1 range
let isMicMuted = false;
let isTtsMuted = false;
let activeTimers = [];
let alarmIntervalId = null;
let activeTasks = [];

// Vosk Wake Word
let voskModel = null;
let voskRecognizer = null;
let isVoskReady = false;

// Tuning
const SPEECH_THRESHOLD = 6;      // RMS above this = speech detected (during listening mode)
const SILENCE_THRESHOLD = 4;     // RMS below this = silence
const SILENCE_DURATION = 1500;   // ms of silence to finalize recording
const MIN_SPEECH_DURATION = 500; // minimum ms of speech to bother processing
const FOLLOW_UP_WINDOW = 4000;   // ms to wait for follow-up after speaking
const WAKE_WORDS = [
    "hey", "hail", "hey olanga", "hey alanga", "hay olanga", "a olanga", "hey longo", "he olanga",
    "hey along the", "hail longer", "hey or longer", "hey longer", "hail along the", "hey alonso"
];

// ---- DOM Elements ----
const setupScreen = document.getElementById('setupScreen');
const mainScreen = document.getElementById('mainScreen');
const apiKeyInput = document.getElementById('apiKeyInput');
const nvidiaKeyInput = document.getElementById('nvidiaKeyInput');
const saveKeyBtn = document.getElementById('saveKeyBtn');
const getKeyLink = document.getElementById('getKeyLink');
const clockDisplay = document.getElementById('clockDisplay');
const orbContainer = document.getElementById('orbContainer');
const orbGlow = document.getElementById('orbGlow');
const orb = document.getElementById('orb');
const orbCanvas = document.getElementById('orbCanvas');
const waveBars = document.getElementById('waveBars');
const waveBarEls = document.querySelectorAll('.wave-bar');
const transcriptUser = document.getElementById('transcriptUser');
const transcriptAi = document.getElementById('transcriptAi');
const userText = document.getElementById('userText');
const aiText = document.getElementById('aiText');
const hint = document.getElementById('hint');
const minimizeBtn = document.getElementById('minimizeBtn');
const closeBtn = document.getElementById('closeBtn');
const keyListContainer = document.getElementById('keyListContainer');
const newKeyInput = document.getElementById('newKeyInput');
const addKeyBtn = document.getElementById('addKeyBtn');
const nvidiaSettingsKeyInput = document.getElementById('nvidiaSettingsKeyInput');
const addNvidiaKeyBtn = document.getElementById('addNvidiaKeyBtn');
const rotationToggle = document.getElementById('rotationToggle');
const nvidiaVoiceSelect = document.getElementById('nvidiaVoiceSelect');
const customVoiceNameInput = document.getElementById('customVoiceNameInput');
const refreshVoiceListBtn = document.getElementById('refreshVoiceListBtn');
const ttsRateInput = document.getElementById('ttsRateInput');
const ttsRateValue = document.getElementById('ttsRateValue');
const cityInput = document.getElementById('cityInput');
const stateInput = document.getElementById('stateInput');
const countryInput = document.getElementById('countryInput');
const dateDisplay = document.getElementById('dateDisplay');
const micToggleBtn = document.getElementById('micToggleBtn');
const micIconOn = document.getElementById('micIconOn');
const micIconOff = document.getElementById('micIconOff');
const ttsToggleBtn = document.getElementById('ttsToggleBtn');
const ttsIconOn = document.getElementById('ttsIconOn');
const ttsIconOff = document.getElementById('ttsIconOff');
const timersContainer = document.getElementById('timersList');

// ---- Initialize ----
function init() {
  // Audio controls first (independent of API keys)
  initAudioControls();
  initVoiceSettings();

  minimizeBtn.addEventListener('click', () => window.electronAPI.minimize());
  closeBtn.addEventListener('click', () => window.electronAPI.close());

  getKeyLink.addEventListener('click', () => {
    window.electronAPI.openExternal('https://aistudio.google.com/apikey');
  });

  // Start clock + date
  setInterval(updateClock, 1000);
  updateClock();

  // Pre-fill API keys from localStorage if they exist
  const savedGeminiKeys = localStorage.getItem('olanga_api_keys');
  const savedNvidiaKey = localStorage.getItem('olanga_nvidia_key');
  if (savedGeminiKeys) {
    const keys = JSON.parse(savedGeminiKeys);
    if (keys.length > 0) {
      apiKeyInput.value = keys[0];
    }
  }
  if (savedNvidiaKey) {
    nvidiaKeyInput.value = savedNvidiaKey;
  }

  saveKeyBtn.addEventListener('click', handleSaveKey);
  document.getElementById('setupForm').addEventListener('submit', (e) => {
    e.preventDefault();
    handleSaveKey();
  });
  apiKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSaveKey();
  });

  // Settings initialization helper
  window.loadSettingsValues = function() {
    renderKeyList();
    if (rotationToggle) {
      rotationToggle.checked = apiKeyRotation;
    }
    // Load NVIDIA key
    const savedNvidiaKey = localStorage.getItem('olanga_nvidia_key');
    if (savedNvidiaKey && nvidiaSettingsKeyInput) {
      nvidiaSettingsKeyInput.value = savedNvidiaKey;
    }
    // Load active Gemini key into newKeyInput for viewing/editing
    if (newKeyInput && apiKey) {
      newKeyInput.value = apiKey;
    }
    if (ttsRateInput) {
      ttsRateInput.value = String(ttsRate);
      updateTtsRateLabel(ttsRate);
    }
    if (nvidiaVoiceSelect && nvidiaVoiceName) {
      nvidiaVoiceSelect.value = nvidiaVoiceName;
    }
    if (customVoiceNameInput) {
      customVoiceNameInput.value = nvidiaVoiceName || defaultNvidiaVoiceName;
    }
    // Load location context
    if (cityInput) cityInput.value = localStorage.getItem('olanga_city') || '';
    if (stateInput) stateInput.value = localStorage.getItem('olanga_state') || '';
    if (countryInput) countryInput.value = localStorage.getItem('olanga_country') || '';
    refreshVoiceCatalog().catch((error) => {
      console.warn('[Olanga] Voice list refresh failed:', error.message);
    });
  };
  addKeyBtn.addEventListener('click', handleAddKeyFromSettings);
  newKeyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddKeyFromSettings();
  });
  rotationToggle.addEventListener('change', (e) => {
    apiKeyRotation = e.target.checked;
    localStorage.setItem('olanga_key_rotation', apiKeyRotation);
  });

  // Location bindings
  const saveLocation = () => {
    userCity = cityInput.value.trim();
    userState = stateInput.value.trim();
    userCountry = countryInput.value.trim();
    localStorage.setItem('olanga_city', userCity);
    localStorage.setItem('olanga_state', userState);
    localStorage.setItem('olanga_country', userCountry);
  };
  cityInput.addEventListener('input', saveLocation);
  stateInput.addEventListener('input', saveLocation);
  countryInput.addEventListener('input', saveLocation);
  if (ttsRateInput) {
    ttsRateInput.addEventListener('input', (e) => {
      ttsRate = Number.parseFloat(e.target.value);
      localStorage.setItem('olanga_tts_rate', String(ttsRate));
      updateTtsRateLabel(ttsRate);
    });
  }

  // Load keys and location
  let storedKeys = [];
  try {
    const rawKeys = localStorage.getItem('olanga_api_keys');
    if (rawKeys) {
      storedKeys = JSON.parse(rawKeys);
    }
    if (!Array.isArray(storedKeys)) storedKeys = [];
  } catch (e) {
    console.error("Failed to parse stored API keys", e);
    storedKeys = [];
  }

  nvidiaApiKey = localStorage.getItem('olanga_nvidia_key') || '';
  nvidiaSettingsKeyInput.value = nvidiaApiKey;
  nvidiaVoiceName = localStorage.getItem('olanga_nvidia_voice') || nvidiaVoiceName;
  if (customVoiceNameInput) {
    customVoiceNameInput.value = nvidiaVoiceName || defaultNvidiaVoiceName;
  }
  if (ttsRateInput) {
    ttsRateInput.value = String(ttsRate);
    updateTtsRateLabel(ttsRate);
  }

  const storedRotation = localStorage.getItem('olanga_key_rotation') === 'true';
  
  if (storedKeys.length > 0) {
    apiKeys = storedKeys;
    apiKeyRotation = storedRotation;
    apiKey = apiKeys[0];
    showMainScreen();
  } else {
    // Legacy fallback
    const legacyKey = localStorage.getItem('olanga_api_key');
    if (legacyKey) {
      apiKeys = [legacyKey];
      apiKey = legacyKey;
      localStorage.setItem('olanga_api_keys', JSON.stringify(apiKeys));
      showMainScreen();
    }
  }

  userCity = localStorage.getItem('olanga_city') || '';
  userState = localStorage.getItem('olanga_state') || '';
  userCountry = localStorage.getItem('olanga_country') || '';
  cityInput.value = userCity;
  stateInput.value = userState;
  countryInput.value = userCountry;

  // Tasks bindings
  const tasksClearBtn = document.getElementById('tasksClearBtn');
  const taskInput = document.getElementById('taskInput');
  const addTaskBtn = document.getElementById('addTaskBtn');

  if (tasksClearBtn) {
    tasksClearBtn.addEventListener('click', clearAllTasks);
  }

  const handleManualAddTask = () => {
    const text = taskInput.value.trim();
    if (text) {
      addTask(text);
      taskInput.value = '';
    }
  };

  if (addTaskBtn) {
    addTaskBtn.addEventListener('click', handleManualAddTask);
  }

  if (taskInput) {
    taskInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleManualAddTask();
    });
  }

  // Load and render initial tasks
  loadTasks();
  renderTasks();

  // Timer widget bindings
  const timersClearBtn = document.getElementById('timersClearBtn');
  const timerInput = document.getElementById('timerInput');
  const addTimerBtn = document.getElementById('addTimerBtn');

  if (timersClearBtn) {
    timersClearBtn.addEventListener('click', clearAllTimers);
  }

  const handleManualAddTimer = () => {
    const raw = timerInput.value.trim();
    if (!raw) return;
    const seconds = parseTimerInput(raw);
    if (seconds > 0) {
      createTimer(seconds);
      timerInput.value = '';
    }
  };

  if (addTimerBtn) {
    addTimerBtn.addEventListener('click', handleManualAddTimer);
  }

  if (timerInput) {
    timerInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleManualAddTimer();
    });
  }

  // Text Command bindings
  const textCommandInput = document.getElementById('textCommandInput');
  const textCommandBtn = document.getElementById('textCommandBtn');

  const handleTextCommand = () => {
    const text = textCommandInput.value.trim();
    if (text) {
      processTextCommandWithGemini(text);
      textCommandInput.value = '';
    }
  };

  if (textCommandBtn) {
    textCommandBtn.addEventListener('click', handleTextCommand);
  }

  if (textCommandInput) {
    textCommandInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleTextCommand();
    });
  }

  // Render initial timers (shows empty state)
  renderTimers();

  orbCanvasCtx = orbCanvas.getContext('2d');
  startOrbAnimation();
  refreshVoiceCatalog();
}

function initVoiceSettings() {
  if (nvidiaVoiceSelect) {
    nvidiaVoiceSelect.addEventListener('change', (e) => {
      const nextVoice = e.target.value.trim() || defaultNvidiaVoiceName;
      nvidiaVoiceName = nextVoice;
      localStorage.setItem('olanga_nvidia_voice', nvidiaVoiceName);
      if (customVoiceNameInput) {
        customVoiceNameInput.value = nvidiaVoiceName;
      }
    });
  }

  if (customVoiceNameInput) {
    customVoiceNameInput.addEventListener('input', (e) => {
      const nextVoice = e.target.value.trim() || defaultNvidiaVoiceName;
      nvidiaVoiceName = nextVoice;
      localStorage.setItem('olanga_nvidia_voice', nvidiaVoiceName);
      if (nvidiaVoiceSelect) {
        const hasMatch = Array.from(nvidiaVoiceSelect.options).some(option => option.value === nvidiaVoiceName);
        if (hasMatch) {
          nvidiaVoiceSelect.value = nvidiaVoiceName;
        } else {
          const customOption = document.createElement('option');
          customOption.value = nvidiaVoiceName;
          customOption.textContent = `${nvidiaVoiceName} (custom)`;
          nvidiaVoiceSelect.insertBefore(customOption, nvidiaVoiceSelect.firstChild);
          nvidiaVoiceSelect.value = nvidiaVoiceName;
        }
      }
    });
  }

  if (refreshVoiceListBtn) {
    refreshVoiceListBtn.addEventListener('click', refreshVoiceCatalog);
  }
}

function updateTtsRateLabel(value) {
  if (ttsRateValue) {
    ttsRateValue.textContent = `${Number.parseFloat(value).toFixed(2)}x`;
  }
}

function parseVoiceCatalog(responseJson) {
  const modelConfig = Array.isArray(responseJson?.modelConfig)
    ? responseJson.modelConfig[0]
    : Array.isArray(responseJson?.model_config)
      ? responseJson.model_config[0]
      : null;

  const parameters = modelConfig?.parameters || {};
  const baseVoiceName = parameters.voiceName || defaultNvidiaVoiceName;
  const rawSubvoices = parameters.subvoices || parameters.subVoices || '';
  const subvoices = Array.isArray(rawSubvoices)
    ? rawSubvoices
    : String(rawSubvoices)
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

  const voices = subvoices.map((subvoice) => {
    const [voiceSuffix] = subvoice.split(':');
    const voiceName = voiceSuffix.startsWith(baseVoiceName)
      ? voiceSuffix
      : `${baseVoiceName}.${voiceSuffix}`;
    const languageCodeMatch = voiceName.match(/(?:magpie-multilingual\.)?([A-Za-z]{2}-[A-Za-z]{2})\./i);
    return {
      languageCode: languageCodeMatch ? normalizeLanguageCode(languageCodeMatch[1]) : inferVoiceLanguageCode(voiceName),
      voiceName,
      label: voiceName
    };
  });

  if (voices.length === 0) {
    voices.push({
      languageCode: inferVoiceLanguageCode(baseVoiceName),
      voiceName: baseVoiceName,
      label: baseVoiceName
    });
  }

  return voices;
}

function populateVoiceSelect(selectElement, options, selectedValue, emptyLabel) {
  if (!selectElement) return '';

  selectElement.innerHTML = '';
  if (options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = emptyLabel;
    selectElement.appendChild(option);
    selectElement.disabled = true;
    return '';
  }

  selectElement.disabled = false;
  for (const optionData of options) {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.textContent = optionData.label;
    selectElement.appendChild(option);
  }

  if (selectedValue && options.some(option => option.value === selectedValue)) {
    selectElement.value = selectedValue;
  } else {
    selectElement.value = options[0].value;
  }

  return selectElement.value;
}

async function refreshVoiceCatalog() {
  const savedKey = nvidiaApiKey || localStorage.getItem('olanga_nvidia_key') || '';
  if (!savedKey) {
    const defaultOptions = [
      { value: 'Magpie-Multilingual.EN-US.Aria', label: 'Magpie-Multilingual.EN-US.Aria' },
      { value: 'Magpie-Multilingual.EN-US.Mia', label: 'Magpie-Multilingual.EN-US.Mia' },
      { value: 'Magpie-Multilingual.EN-US.Kendra', label: 'Magpie-Multilingual.EN-US.Kendra' }
    ];
    const selectedVoice = nvidiaVoiceName || defaultNvidiaVoiceName;
    const voiceOptions = defaultOptions.some(option => option.value === selectedVoice)
      ? defaultOptions
      : [{ value: selectedVoice, label: `${selectedVoice} (custom)` }, ...defaultOptions];
    populateVoiceSelect(nvidiaVoiceSelect, voiceOptions, selectedVoice, 'No NVIDIA voices found');
    if (customVoiceNameInput) {
      customVoiceNameInput.value = selectedVoice;
    }
    return;
  }

  try {
    const response = await fetch('https://integrate.api.nvidia.com/v2/riva/tts/config', {
      headers: {
        Authorization: `Bearer ${savedKey}`,
        'function-id': nvidiaFunctionId,
        'NVCF-Function-Id': nvidiaFunctionId
      }
    });

    if (!response.ok) {
      throw new Error(`Voice list error: ${response.status}`);
    }

    const data = await response.json();
    nvidiaVoiceCatalog = parseVoiceCatalog(data);
    let voiceOptions = nvidiaVoiceCatalog.map(voice => ({
      value: voice.voiceName,
      label: voice.label
    }));
    const selectedVoice = nvidiaVoiceName || defaultNvidiaVoiceName || voiceOptions[0]?.value || '';
    if (selectedVoice && !voiceOptions.some(option => option.value === selectedVoice)) {
      voiceOptions = [
        { value: selectedVoice, label: `${selectedVoice} (custom)` },
        ...voiceOptions
      ];
    }
    const resolvedVoice = populateVoiceSelect(nvidiaVoiceSelect, voiceOptions, selectedVoice, 'No NVIDIA voices found');
    if (resolvedVoice) {
      nvidiaVoiceName = resolvedVoice;
      localStorage.setItem('olanga_nvidia_voice', nvidiaVoiceName);
      if (customVoiceNameInput) {
        customVoiceNameInput.value = nvidiaVoiceName;
      }
    }
  } catch (error) {
    console.warn('[Olanga] Failed to load NVIDIA voices:', error.message);
    const fallbackOptions = [
      { value: 'Magpie-Multilingual.EN-US.Aria', label: 'Magpie-Multilingual.EN-US.Aria (en-US)' },
      { value: 'Magpie-Multilingual.EN-US.Mia', label: 'Magpie-Multilingual.EN-US.Mia (en-US)' },
      { value: 'Magpie-Multilingual.EN-US.Kendra', label: 'Magpie-Multilingual.EN-US.Kendra (en-US)' }
    ];
    const selectedVoice = nvidiaVoiceName || defaultNvidiaVoiceName || fallbackOptions[0].value;
    const voiceOptions = fallbackOptions.some(option => option.value === selectedVoice)
      ? fallbackOptions
      : [{ value: selectedVoice, label: `${selectedVoice} (custom)` }, ...fallbackOptions];
    const resolvedVoice = populateVoiceSelect(nvidiaVoiceSelect, voiceOptions, selectedVoice, 'No NVIDIA voices found');
    if (resolvedVoice) {
      nvidiaVoiceName = resolvedVoice;
      localStorage.setItem('olanga_nvidia_voice', nvidiaVoiceName);
      if (customVoiceNameInput) {
        customVoiceNameInput.value = nvidiaVoiceName;
      }
    }
  }
}

function normalizeLanguageCode(languageCode) {
  if (!languageCode) return 'en-US';
  const parts = String(languageCode).split('-');
  if (parts.length !== 2) return String(languageCode);
  return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
}

function encodeVarint(value) {
  let current = value >>> 0;
  const bytes = [];
  while (current > 127) {
    bytes.push((current & 0x7f) | 0x80);
    current >>>= 7;
  }
  bytes.push(current);
  return Uint8Array.from(bytes);
}

function concatUint8Arrays(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function encodeLengthDelimitedField(fieldNumber, bytes) {
  return concatUint8Arrays([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(bytes.length),
    bytes
  ]);
}

function encodeStringField(fieldNumber, text) {
  return encodeLengthDelimitedField(fieldNumber, new TextEncoder().encode(text));
}

function encodeVarintField(fieldNumber, value) {
  return concatUint8Arrays([
    encodeVarint((fieldNumber << 3) | 0),
    encodeVarint(value)
  ]);
}

function buildTtsRequestBody(text, voiceConfig) {
  const fields = [
    encodeStringField(1, text),
    encodeStringField(2, voiceConfig.languageCode || 'en-US'),
    encodeVarintField(3, 1),
    encodeVarintField(4, 44100),
    encodeStringField(5, voiceConfig.voiceName),
    encodeStringField(100, `olanga-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
  ];
  return concatUint8Arrays(fields);
}

function readVarint(bytes, startOffset) {
  let result = 0;
  let shift = 0;
  let offset = startOffset;
  while (offset < bytes.length) {
    const byte = bytes[offset++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value: result >>> 0, offset };
    }
    shift += 7;
  }
  throw new Error('Unexpected end of protobuf varint');
}

function readDelimited(bytes, startOffset) {
  const lengthInfo = readVarint(bytes, startOffset);
  const endOffset = lengthInfo.offset + lengthInfo.value;
  return {
    value: bytes.slice(lengthInfo.offset, endOffset),
    offset: endOffset
  };
}

function parseTtsResponse(buffer) {
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  while (offset < bytes.length) {
    const tagInfo = readVarint(bytes, offset);
    offset = tagInfo.offset;
    const fieldNumber = tagInfo.value >>> 3;
    const wireType = tagInfo.value & 7;

    if (fieldNumber === 1 && wireType === 2) {
      const audioInfo = readDelimited(bytes, offset);
      return audioInfo.value;
    }

    if (wireType === 0) {
      offset = readVarint(bytes, offset).offset;
    } else if (wireType === 2) {
      offset = readDelimited(bytes, offset).offset;
    } else {
      throw new Error(`Unsupported protobuf wire type: ${wireType}`);
    }
  }

  throw new Error('No audio returned from Magpie TTS');
}

// ---- API Key Setup ----
function handleSaveKey() {
  const key = apiKeyInput.value.trim();
  const nKey = nvidiaKeyInput.value.trim();
  if (!key) {
    showError('Please enter your Gemini API key');
    return;
  }
  if (!apiKeys.includes(key)) {
    apiKeys.push(key);
  }
  apiKey = key;
  localStorage.setItem('olanga_api_keys', JSON.stringify(apiKeys));
  
  if (nKey) {
    nvidiaApiKey = nKey;
    localStorage.setItem('olanga_nvidia_key', nKey);
    nvidiaSettingsKeyInput.value = nKey;
    refreshVoiceCatalog();
  }
  showMainScreen();
}

function handleAddKeyFromSettings() {
  const key = newKeyInput.value.trim();
  if (!key) return;
  if (!apiKeys.includes(key)) {
    apiKeys.push(key);
    localStorage.setItem('olanga_api_keys', JSON.stringify(apiKeys));
  }
  newKeyInput.value = '';
  renderKeyList();
}

addNvidiaKeyBtn.addEventListener('click', () => {
  const nKey = nvidiaSettingsKeyInput.value.trim();
  nvidiaApiKey = nKey;
  localStorage.setItem('olanga_nvidia_key', nKey);
  refreshVoiceCatalog();
});

function renderKeyList() {
  keyListContainer.innerHTML = '';
  if (apiKeys.length === 0) {
    keyListContainer.innerHTML = '<span style="color:var(--text-dim);font-size:12px;">No keys saved.</span>';
    return;
  }
  apiKeys.forEach((k, i) => {
    const div = document.createElement('div');
    div.className = 'key-item' + (k === apiKey ? ' active' : '');
    div.innerHTML = `
      <span class="key-item-text">Key ${i + 1}: ...${k.slice(-6)}</span>
      <div class="key-item-actions">
        <button class="key-btn select" data-key="${k}">Select</button>
        <button class="key-btn delete" data-key="${k}">Del</button>
      </div>
    `;
    keyListContainer.appendChild(div);
  });

  // Bind actions
  keyListContainer.querySelectorAll('.select').forEach(b => {
    b.addEventListener('click', (e) => {
      apiKey = e.target.dataset.key;
      currentKeyIndex = apiKeys.indexOf(apiKey);
      renderKeyList();
    });
  });
  keyListContainer.querySelectorAll('.delete').forEach(b => {
    b.addEventListener('click', (e) => {
      const k = e.target.dataset.key;
      apiKeys = apiKeys.filter(x => x !== k);
      if (apiKey === k) {
        apiKey = apiKeys.length > 0 ? apiKeys[0] : '';
        currentKeyIndex = 0;
      }
      localStorage.setItem('olanga_api_keys', JSON.stringify(apiKeys));
      renderKeyList();
    });
  });
}

async function showMainScreen() {
  setupScreen.classList.add('hidden');
  mainScreen.classList.remove('hidden');
  // Show floating icons after setup is complete
  const floatingIcons = document.querySelector('.floating-icons');
  if (floatingIcons) {
    floatingIcons.classList.add('visible');
  }
  hint.textContent = "Loading offline wake word model...";
  try {
    await initVosk();
    await initMicrophone();
  } catch(e) {
    console.error("Init error", e);
    showError("Failed to initialize system: " + e.message);
  }
}

let lastIdleTime = 0;

// ---- State Management ----
function setState(newState, preserveHistory = false) {
  const prev = currentState;
  currentState = newState;

  document.body.classList.remove('state-idle', 'state-listening', 'state-thinking', 'state-speaking');
  document.body.classList.add(`state-${newState}`);

  switch (newState) {
    case State.IDLE:
      lastIdleTime = Date.now();
      if (!preserveHistory) {
        conversationHistory = []; // Only contain memory for the current strand of conversation
      }
      hint.textContent = 'Listening for "Hey Olanga"...';
      hint.classList.remove('hidden');
      hint.innerHTML = 'Say <strong>"Hey Olanga"</strong> to start';
      // Reset Vosk recognizer to clear old state
      if (!preserveHistory) {
        conversationHistory = [];
      }
      if (voskRecognizer) {
          try {
              voskRecognizer.reset();
          } catch(e) {}
      }
      break;
    case State.LISTENING:
      break;
    case State.THINKING:
      break;
    case State.SPEAKING:
      break;
  }

  console.log(`[Olanga] State: ${prev} → ${newState}`);
}

// ============================================
// VOSK WAKE WORD DETECTION (OFFLINE)
// ============================================
async function initVosk() {
    if (!window.Vosk) {
        throw new Error("Vosk library not loaded");
    }
    console.log("[Olanga] Loading Vosk model from local tar.gz...");
    
    // We serve model.tar.gz via the relative path now that webSecurity is false
    // Using v2 to bypass Electron's aggressive file caching
    voskModel = await window.Vosk.createModel('./vosk-model-v2.tar.gz');
    console.log("[Olanga] Vosk model loaded successfully.");
    isVoskReady = true;
}

// ============================================
// MICROPHONE + RAW PCM CAPTURE
// ============================================

async function initMicrophone() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000 // Vosk works best at 16k
      }
    });

    audioContext = new AudioContext({ sampleRate: 16000 });
    const sampleRate = audioContext.sampleRate;
    console.log(`[Olanga] AudioContext sample rate: ${sampleRate}`);

    // Create Vosk recognizer
    if (voskModel) {
        voskRecognizer = new voskModel.KaldiRecognizer(sampleRate);
        voskRecognizer.setWords(true);
        voskRecognizer.on("result", (message) => {
            handleVoskResult(message.result.text);
        });
        voskRecognizer.on("partialresult", (message) => {
            handleVoskResult(message.result.partial);
        });
    }

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.85;

      // ScriptProcessorNode to capture raw PCM samples
      scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
      scriptNode.onaudioprocess = (e) => {
        if (isMicMuted) return;
        const inputData = e.inputBuffer.getChannelData(0);
        
        // If idle, feed to Vosk for Wake Word detection
        if (currentState === State.IDLE && voskRecognizer && isVoskReady) {
            voskRecognizer.acceptWaveformFloat(inputData, sampleRate);
        }
        
        // If recording, collect chunks for Gemini
        if (isRecording) {
          pcmChunks.push(new Float32Array(inputData));
        }
      };

    const source = audioContext.createMediaStreamSource(micStream);

    // Connect: source → analyser (for VAD visualization)
    source.connect(analyser);

    // Connect: source → scriptProcessor → silent output (for PCM capture)
    // Must connect to destination for onaudioprocess to fire, but mute it
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(scriptNode);
    scriptNode.connect(silentGain);
    silentGain.connect(audioContext.destination);

    console.log('[Olanga] ✅ Microphone initialized');
    setState(State.IDLE);
    monitorAudio();

  } catch (err) {
    console.error('[Olanga] Mic init error:', err);
    showError('Microphone access denied or unavailable.');
  }
}

// ============================================
// VOSK RESULT HANDLER
// ============================================
function handleVoskResult(text) {
    if (!text || currentState !== State.IDLE) return;
    if (Date.now() - lastIdleTime < 1000) return; // 1-second cooldown to prevent immediate re-triggering
    
    text = text.toLowerCase();
    console.log(`[Olanga Vosk] Hears: "${text}"`);
    
    // Check if any of the wake words are in the transcript using word boundaries
    // This prevents "they" from triggering "hey"
    if (WAKE_WORDS.some(ww => new RegExp(`\\b${ww}\\b`, 'i').test(text))) {
        console.log(`[Olanga] Wake word detected locally! Transcript: "${text}"`);
        
        // Wake word detected! Clear the prompt and start listening for the actual query
        setState(State.LISTENING);
        startRecording();
        
        userText.textContent = "Listening...";
        transcriptUser.classList.remove('hidden');
        transcriptAi.classList.add('hidden');
    }
}

// ============================================
// VOICE ACTIVITY DETECTION (For Ending Recording)
// ============================================

function monitorAudio() {
  if (currentState === State.THINKING || currentState === State.SPEAKING) {
    requestAnimationFrame(monitorAudio);
    return;
  }

  if (isMicMuted) {
    currentRMS = 0;
    updateWaveBars(0);
    requestAnimationFrame(monitorAudio);
    return;
  }

  const dataArray = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(dataArray);

  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const val = (dataArray[i] - 128) / 128;
    sum += val * val;
  }
  currentRMS = Math.sqrt(sum / dataArray.length) * 100;

  updateWaveBars(currentRMS);

  // VAD logic ONLY for stopping the recording once it has started
  if (currentState === State.LISTENING) {
      if (currentRMS > SPEECH_THRESHOLD) {
        silenceStartTime = null;
        if (!hasSpokenDuringRecording) {
            hasSpokenDuringRecording = true;
            speechStartTime = Date.now();
            if (followUpTimer) {
              clearTimeout(followUpTimer);
              followUpTimer = null;
            }
        }
      } else if (isRecording) {
        if (!silenceStartTime) {
          silenceStartTime = Date.now();
        }
        
        // Wait 4 seconds for them to START speaking. If they're already speaking, wait 1.5s to STOP.
        const timeout = hasSpokenDuringRecording ? SILENCE_DURATION : 4000;
        
        if (Date.now() - silenceStartTime > timeout) {
          if (hasSpokenDuringRecording && (Date.now() - speechStartTime) > MIN_SPEECH_DURATION) {
            stopRecording();
          } else {
            console.log('[Olanga] Recording timed out or too short (no speech), returning to IDLE');
            cancelRecording();
            setState(State.IDLE);
          }
        }
      }
  }

  requestAnimationFrame(monitorAudio);
}

function updateWaveBars(rms) {
  if (currentState !== State.LISTENING && currentState !== State.IDLE) return;
  // If idle, don't show huge waves, just very tiny ones to indicate it's alive
  let scale = (currentState === State.LISTENING) ? 2 : 0.5;

  waveBarEls.forEach((bar, i) => {
    const offset = Math.sin(Date.now() * 0.005 + i * 0.7) * 0.5 + 0.5;
    const height = Math.max(4, Math.min(28, rms * scale * offset));
    bar.style.height = `${height}px`;
  });
}

// ============================================
// RECORDING CONTROLS
// ============================================

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = Date.now(); // Start silence timer immediately for the 5s timeout
  hasSpokenDuringRecording = false;
  console.log('[Olanga] 🎙️ Recording user query started');
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  const isFollowUp = (currentState === State.LISTENING);

  console.log(`[Olanga] 🎙️ Recording stopped — processing with Gemini`);
  setState(State.THINKING);

  // Combine all PCM chunks into one Float32Array
  const totalLength = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (totalLength === 0) {
    console.log('[Olanga] No audio data captured');
    setState(State.IDLE);
    pcmChunks = [];
    speechStartTime = null;
    silenceStartTime = null;
    return;
  }

  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of pcmChunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = null;

  // Encode as WAV
  const sampleRate = audioContext.sampleRate;
  const wavBlob = encodeWAV(combined, sampleRate);
  
  processAudioBlobWithGemini(wavBlob);
}

function cancelRecording() {
  if (!isRecording) return;
  isRecording = false;
  pcmChunks = [];
  speechStartTime = null;
  silenceStartTime = null;
  hasSpokenDuringRecording = false;
}

// ============================================
// WAV ENCODER
// ============================================

function encodeWAV(samples, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const bufferSize = 44 + dataSize;

  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);            
  view.setUint16(20, 1, true);             
  view.setUint16(22, numChannels, true);   
  view.setUint32(24, sampleRate, true);    
  view.setUint32(28, byteRate, true);      
  view.setUint16(32, blockAlign, true);    
  view.setUint16(34, bitsPerSample, true); 

  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let writeOffset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(writeOffset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    writeOffset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// ============================================
// AUDIO → GEMINI API
// ============================================

async function processAudioBlobWithGemini(blob) {
  try {
    const base64Audio = await blobToBase64(blob);
    console.log(`[Olanga] 🚀 Dispatching exactly ONE request to Gemini API (Payload size: ${Math.round(base64Audio.length / 1024)} KB)...`);

    const response = await sendAudioToGemini(base64Audio);
    
    // DEBUG: Log raw response from Gemini
    console.log('[Olanga DEBUG] Raw Gemini response:', JSON.stringify(response));
    
    // Parse the structured response
    let parsed = parseResponse(response);
    
    // DEBUG: Log parsed response
    console.log('[Olanga DEBUG] Parsed response:', JSON.stringify(parsed.response));
    console.log('[Olanga DEBUG] Contains [FOLLOW_UP]?', /\[FOLLOW[_ ]?UP\]/i.test(parsed.response));
    
    // If the model heard nothing, just go to sleep
    if (parsed.response.trim() === '[SILENCE]') {
      console.log('[Olanga] 🤐 Model heard nothing but silence/noise. Returning to IDLE.');
      setState(State.IDLE);
      return;
    }

    if (parsed.userSaid) {
      userText.textContent = parsed.userSaid;
      transcriptUser.classList.remove('hidden');
    } else {
        userText.textContent = "Audio received";
    }

    if (parsed.userSaid) {
      conversationHistory.push({ role: 'user', text: parsed.userSaid });
    }

    let spokenResponse = parsed.response;
    
    // Intercept Open App command
    const openAppMatch = spokenResponse.match(/\[OPEN_APP:\s*([^\]]+)\]/i);
    if (openAppMatch) {
      const appName = openAppMatch[1].trim();
      console.log(`[Olanga] 🖥️ Opening App: ${appName}`);
      window.electronAPI.openApp(appName);
      spokenResponse = spokenResponse.replace(openAppMatch[0], '').trim();
      if (!spokenResponse) spokenResponse = `Opening ${appName} for you now.`;
    }

    const spotifyMatch = spokenResponse.match(/\[SPOTIFY_(SONG|ALBUM|PLAYLIST|ARTIST):\s*([^\]]+)\]/i);
    if (spotifyMatch) {
      const type = spotifyMatch[1].toUpperCase();
      const searchTerm = spotifyMatch[2].trim().replace(/^"|"$/g, ''); // Remove quotes if the AI adds them
      console.log(`[Olanga] 🎵 Requesting Spotify play for ${type}: ${searchTerm}`);
      window.electronAPI.playSpotify(type, searchTerm);
      // Remove the command from the spoken response
      spokenResponse = spokenResponse.replace(spotifyMatch[0], '').trim();
      if (!spokenResponse) spokenResponse = `Playing your request on Spotify.`;
    }

    // Intercept Media/Volume commands
    const mediaRegex = /\[(MEDIA_PLAY_PAUSE|MEDIA_NEXT|MEDIA_PREV|VOLUME_UP|VOLUME_DOWN|VOLUME_MUTE)\]/ig;
    let mediaMatch;
    while ((mediaMatch = mediaRegex.exec(spokenResponse)) !== null) {
      const command = mediaMatch[1].toUpperCase();
      console.log(`[Olanga] 🎛️ Media control requested: ${command}`);
      window.electronAPI.mediaControl(command);
    }
    spokenResponse = spokenResponse.replace(mediaRegex, '').trim();

    // Intercept Mic Mute/Unmute command
    const micMuteRegex = /\[(MUTE_MIC|UNMUTE_MIC|MUTE_TTS|UNMUTE_TTS)\]/ig;
    let micMuteMatch;
    while ((micMuteMatch = micMuteRegex.exec(spokenResponse)) !== null) {
      const command = micMuteMatch[1].toUpperCase();
      console.log(`[Olanga] 🎙️ Audio control requested: ${command}`);
      if (command === 'MUTE_MIC') muteMic();
      else if (command === 'UNMUTE_MIC') unmuteMic();
      else if (command === 'MUTE_TTS') muteTts();
      else if (command === 'UNMUTE_TTS') unmuteTts();
    }
    spokenResponse = spokenResponse.replace(micMuteRegex, '').trim();

    // Intercept Timer commands
    const setTimerMatch = spokenResponse.match(/\[SET_TIMER:\s*(\d+),\s*([^\]]+)\]/i);
    if (setTimerMatch) {
      const duration = parseInt(setTimerMatch[1]);
      const label = setTimerMatch[2].trim();
      console.log(`[Olanga] ⏱️ Timer requested: ${duration}s, labeled: ${label}`);
      createTimer(duration, label);
      spokenResponse = spokenResponse.replace(setTimerMatch[0], '').trim();
    }

    const cancelTimerMatch = spokenResponse.match(/\[CANCEL_TIMER:\s*([^\]]+)\]/i);
    if (cancelTimerMatch) {
      const label = cancelTimerMatch[1].trim();
      console.log(`[Olanga] ⏱️ Cancel timer requested: ${label}`);
      cancelTimerByLabel(label);
      spokenResponse = spokenResponse.replace(cancelTimerMatch[0], '').trim();
    }

    // Intercept Task commands
    const addTaskMatch = spokenResponse.match(/\[ADD_TASK:\s*([^,\]]+)(?:,\s*([^\]]+))?\]/i);
    if (addTaskMatch) {
      const text = addTaskMatch[1].trim();
      const dueDate = addTaskMatch[2] ? addTaskMatch[2].trim() : null;
      console.log(`[Olanga] 📋 Task add requested: "${text}", due: ${dueDate}`);
      addTask(text, dueDate);
      spokenResponse = spokenResponse.replace(addTaskMatch[0], '').trim();
    }

    const removeTaskMatch = spokenResponse.match(/\[REMOVE_TASK:\s*([^\]]+)\]/i);
    if (removeTaskMatch) {
      const target = removeTaskMatch[1].trim();
      console.log(`[Olanga] 📋 Task remove requested for: "${target}"`);
      removeTask(target);
      spokenResponse = spokenResponse.replace(removeTaskMatch[0], '').trim();
    }

    const clearTasksMatch = spokenResponse.match(/\[CLEAR_ALL_TASKS\]/i);
    if (clearTasksMatch) {
      console.log(`[Olanga] 📋 Task clear all requested`);
      clearAllTasks();
      spokenResponse = spokenResponse.replace(clearTasksMatch[0], '').trim();
    }

    const setTaskDueMatch = spokenResponse.match(/\[SET_TASK_DUE:\s*([^,\]]+),\s*([^\]]+)\]/i);
    if (setTaskDueMatch) {
      const target = setTaskDueMatch[1].trim();
      const dueDate = setTaskDueMatch[2].trim();
      console.log(`[Olanga] 📋 Task due date update requested for: "${target}" to "${dueDate}"`);
      setTaskDue(target, dueDate);
      spokenResponse = spokenResponse.replace(setTaskDueMatch[0], '').trim();
    }

    const completeTaskMatch = spokenResponse.match(/\[COMPLETE_TASK:\s*([^\]]+)\]/i);
    if (completeTaskMatch) {
      const target = completeTaskMatch[1].trim();
      console.log(`[Olanga] 📋 Task complete requested for: "${target}"`);
      completeTask(target, true);
      spokenResponse = spokenResponse.replace(completeTaskMatch[0], '').trim();
    }

    const uncompleteTaskMatch = spokenResponse.match(/\[UNCOMPLETE_TASK:\s*([^\]]+)\]/i);
    if (uncompleteTaskMatch) {
      const target = uncompleteTaskMatch[1].trim();
      console.log(`[Olanga] 📋 Task uncomplete requested for: "${target}"`);
      completeTask(target, false);
      spokenResponse = spokenResponse.replace(uncompleteTaskMatch[0], '').trim();
    }

    // Intercept Follow-Up request (catch variants: [FOLLOW_UP], [follow_up], [Follow Up], [followup])
    const followUpRegex = /\[FOLLOW[_ ]?UP\]/gi;
    const wantsFollowUp = followUpRegex.test(spokenResponse) || spokenResponse.trim().endsWith('?');
    console.log('[Olanga DEBUG] wantsFollowUp =', wantsFollowUp, '| spokenResponse before strip:', JSON.stringify(spokenResponse));
    spokenResponse = spokenResponse.replace(/\[FOLLOW[_ ]?UP\]/gi, '').trim();

    // Intercept Screenshot request
    if (spokenResponse.includes('[REQUEST_SCREENSHOT]')) {
      console.log(`[Olanga] 📸 Screenshot requested by AI`);
      aiText.textContent = "Please select an area on your screen...";
      const base64Image = await window.electronAPI.requestScreenshot();
      if (!base64Image) {
        console.log(`[Olanga] 📸 Screenshot cancelled by user or timed out`);
        aiText.textContent = "Screenshot cancelled.";
        setState(State.IDLE);
        return;
      }
      aiText.textContent = "Processing image...";
      const secondResponseRaw = await sendAudioToGemini(base64Audio, base64Image, parsed.userSaid);
      parsed = parseResponse(secondResponseRaw);
      spokenResponse = parsed.response;
    }

    conversationHistory.push({ role: 'model', text: spokenResponse });

    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-16);
    }

    aiText.textContent = spokenResponse;
    transcriptAi.classList.remove('hidden');

    if (wantsFollowUp) {
      console.log('[Olanga] 🔁 AI requested a follow-up from the user');
      await speakResponseAndThen(spokenResponse, () => enterAiFollowUpMode());
    } else {
      speakResponse(spokenResponse);
    }

  } catch (error) {
    console.error('[Olanga] ❌ Processing error:', error);
    showError(error.message || 'Failed to process audio');
    setState(State.IDLE);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function sendAudioToGemini(base64Audio, base64Image = null, userSaidContext = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  let locationContext = '';
  if (userCity || userState || userCountry) {
    locationContext = `\nThe user is currently located in: ${[userCity, userState, userCountry].filter(Boolean).join(', ')}.`;
  }

  const currentTime = new Date().toLocaleString('en-US', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' 
  });
  
  const timeContext = `\nThe current local time for the user is: ${currentTime}. Use this exact time and location for all temporal or local queries.`;

  const systemInstruction = `You are Olanga, a simple, chill, and obedient AI voice assistant.
The user is your boss. Refer to them as "Boss". Keep your answers concise, direct, and conversational.
Use a relaxed, natural speaking style. Don't sound like a robot. Use conversational fillers naturally, BUT do NOT say "Let me check" or "I'll look that up". Just give the grounded answer immediately.
You have FULL ACCESS to Google Search via the google_search tool. You MUST use your search tool to provide accurate, real-time answers for weather, news, sports, and current events. IMPORTANT: When reporting weather or temperature, ALWAYS use Fahrenheit unless the user specifically asks for Celsius.${locationContext}${timeContext}
The user will provide an audio clip of them speaking. Transcribe what they said, and respond to their request.
If the audio is completely silent, or contains no decipherable speech, you MUST respond exactly with "RESPONSE: [SILENCE]" and do nothing else.

IMPORTANT VISION INSTRUCTIONS:
If the user asks you to look at something on their screen, or mentions an error, image, or anything visual that you would need to see to answer, AND there is no image attached to the prompt, output EXACTLY the command [REQUEST_SCREENSHOT] and nothing else.
HOWEVER, if there is ALREADY an image attached to the prompt, you MUST NOT output [REQUEST_SCREENSHOT]. Instead, you must look at the attached image and answer the user's question directly!

IMPORTANT SPOTIFY INSTRUCTIONS:
You HAVE FULL CAPABILITY to play music, songs, artists, playlists, and albums on Spotify. Whenever the user asks you to play any of these, you MUST comply and output the command [SPOTIFY_TYPE: Search Term] in your RESPONSE. NEVER say you cannot play music or control Spotify, because you can. Do not use quotes inside the command.
For "TYPE", use SONG, ALBUM, PLAYLIST, or ARTIST.
Example for a song: "I'll play that for you right now. [SPOTIFY_SONG: Shape of You by Ed Sheeran]"
Example for an album: "Playing the album right now. [SPOTIFY_ALBUM: The Dark Side of the Moon by Pink Floyd]"
Example for an artist: "Here is some music by Drake. [SPOTIFY_ARTIST: Drake]"
Example for a playlist: "Playing your playlist now. [SPOTIFY_PLAYLIST: Liked Songs]"

IMPORTANT MEDIA AND SYSTEM CONTROLS:
You can control the system's volume and media playback. Whenever the user asks you to pause, play, skip, or change the volume, output the exact corresponding command in your RESPONSE:
- Pause or Resume playback: [MEDIA_PLAY_PAUSE]
- Next Track or Skip: [MEDIA_NEXT]
- Previous Track: [MEDIA_PREV]
- Volume Up: [VOLUME_UP]
- Volume Down: [VOLUME_DOWN]
- Mute or Unmute Volume: [VOLUME_MUTE]
Example: "I'll turn that down for you. [VOLUME_DOWN]"
Example: "Skipping to the next song. [MEDIA_NEXT]"

IMPORTANT MIC & TTS CONTROLS:
You can control both your microphone and your text-to-speech voice. Use these commands exactly:
- Mute microphone: [MUTE_MIC]
- Unmute microphone: [UNMUTE_MIC]
- Silence yourself (disable TTS / speak no more): [MUTE_TTS]
- Unsilence yourself (re-enable TTS): [UNMUTE_TTS]
Example: "I'll mute myself now. [MUTE_MIC]"
Example: "Going silent. [MUTE_TTS]"
Example: "I'm back. [UNMUTE_TTS]"

IMPORTANT TIMER CONTROLS:
You can set, cancel, or stop timers. When the user asks you to set a timer, determine the duration in seconds and the name/label they specified (default to "Timer" if none specified), and output the exact command [SET_TIMER: duration, label] in your RESPONSE. If the user asks to cancel or delete a timer, output [CANCEL_TIMER: label] in your RESPONSE.
Example: "Setting a timer for 3 minutes named brush. [SET_TIMER: 180, brush]"
Example: "Timer set for 10 seconds. [SET_TIMER: 10, Timer]"
Example: "Cancelling your brush timer. [CANCEL_TIMER: brush]"

IMPORTANT TASK / CHECKLIST CONTROLS:
You can manage the user's checklist/tasks. When the user asks you to add, remove, complete, or update a task, output the exact corresponding command in your RESPONSE.
CRITICAL RULES:
1. If the user says "mark as complete", "check off", "done", "finish" or similar WITHOUT specifying which task by name, you MUST ask which task via [FOLLOW_UP]. NEVER guess.
2. If the user says "remove" or "cancel" a task WITHOUT specifying which task, you MUST ask which one via [FOLLOW_UP].
3. NEVER say you completed or removed a task unless you are outputting the actual command to do so.

- Add a task: [ADD_TASK: text, optional_due_date]
- Remove/delete a task: [REMOVE_TASK: text_or_id]
- Mark a task as complete/done: [COMPLETE_TASK: text_or_id]
- Unmark / mark incomplete: [UNCOMPLETE_TASK: text_or_id]
- Clear all tasks: [CLEAR_ALL_TASKS]
- Set task due date: [SET_TASK_DUE: text_or_id, due_date]
Example: "Adding buy milk to your checklist. [ADD_TASK: buy milk]"
Example: "Removing the buy milk task. [REMOVE_TASK: buy milk]"
Example: "Marked buy milk as done. [COMPLETE_TASK: buy milk]"
Example: "Clearing all tasks for you. [CLEAR_ALL_TASKS]"
Example: "Which task would you like me to mark as complete? [FOLLOW_UP]"

IMPORTANT SYSTEM LAUNCH CONTROLS:
You HAVE FULL CAPABILITY to open or launch applications on the user's computer. Whenever the user asks you to open an app (e.g. Discord, Chrome, Word, etc.), you MUST output the command [OPEN_APP: AppName] in your RESPONSE. NEVER say you cannot open apps.
Example: "Opening Discord for you now. [OPEN_APP: Discord]"
Example: "I'll launch Chrome right away. [OPEN_APP: Google Chrome]"

IMPORTANT FOLLOW-UP:
If you need more information from the user to complete their request (e.g. you need to know which timer, which task, a clarification, a name, etc.), you MUST output the command [FOLLOW_UP] at the END of your RESPONSE. This will open a 5-second microphone window for them to answer. Only use this when genuinely needed.
Example: "Which timer would you like me to cancel? [FOLLOW_UP]"
Example: "Got it, what should I name the task? [FOLLOW_UP]"

Your response will be spoken aloud, so do NOT use markdown, bullet points, code blocks, or any visual formatting.

Format your response EXACTLY like this:
USER_SAID: [transcribe exactly what the user said in the audio]
RESPONSE: [your conversational response]`;

  const requestParts = [];
  
  if (base64Audio) {
    requestParts.push({ inline_data: { mime_type: 'audio/wav', data: base64Audio } });
  }

  if (base64Image) {
    const justData = base64Image.split(',')[1];
    requestParts.push({ inline_data: { mime_type: 'image/png', data: justData } });
  }

  let textPrompt = `Context: ${buildHistoryContext()}\nPlease process the attached audio.`;
  if (base64Image && userSaidContext) {
    textPrompt = `Context: ${buildHistoryContext()}\nThe user previously asked: "${userSaidContext}". Here is the screenshot they just provided for you to look at. Answer their original question.`;
  }
  
  requestParts.push({ text: textPrompt });

  const body = {
    system_instruction: {
      parts: [{ text: systemInstruction }]
    },
    tools: [
      { google_search: {} }
    ],
    contents: [{
      parts: requestParts
    }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 400
    }
  };

  let keysTriedThisCall = 0;
  const maxKeyAttempts = apiKeyRotation ? apiKeys.length : 1;

  for (let attempt = 0; attempt < 3; attempt++) {
    // dynamically get the URL with current apiKey in case it rotated
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (response.status === 429) {
      if (apiKeyRotation && keysTriedThisCall < maxKeyAttempts - 1) {
        // Rotate key and try immediately
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        apiKey = apiKeys[currentKeyIndex];
        keysTriedThisCall++;
        console.log(`[Olanga] Rate limited! Rotating to Key ${currentKeyIndex + 1}...`);
        continue;
      }
      const waitTime = (attempt + 1) * 15;
      console.log(`[Olanga] Rate limited. Waiting ${waitTime}s...`);
      await new Promise(r => setTimeout(r, waitTime * 1000));
      keysTriedThisCall = 0; // reset for next attempt round
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      let errMsg;
      try {
        const errData = JSON.parse(errText);
        errMsg = `Google API Error ${errData?.error?.code}: ${errData?.error?.message}`;
      } catch {
        errMsg = `HTTP ${response.status}: ${errText.substring(0, 200)}`;
      }
      throw new Error(errMsg);
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }
    throw new Error('No response from Gemini');
  }
  
  throw new Error('Rate limited across all keys. Please try again later.');
}

async function sendTextToGemini(textInput, base64Image = null) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  let locationContext = '';
  if (userCity || userState || userCountry) {
    locationContext = `\nThe user is currently located in: ${[userCity, userState, userCountry].filter(Boolean).join(', ')}.`;
  }

  const currentTime = new Date().toLocaleString('en-US', { 
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', 
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' 
  });
  
  const timeContext = `\nThe current local time for the user is: ${currentTime}. Use this exact time and location for all temporal or local queries.`;

  const systemInstruction = `You are Olanga, a simple, chill, and obedient AI voice assistant.
The user is your boss. Refer to them as "Boss". Keep your answers concise, direct, and conversational.
Use a relaxed, natural speaking style. Don't sound like a robot. Use conversational fillers naturally, BUT do NOT say "Let me check" or "I'll look that up". Just give the grounded answer immediately.
You have FULL ACCESS to Google Search via the google_search tool. You MUST use your search tool to provide accurate, real-time answers for weather, news, sports, and current events. IMPORTANT: When reporting weather or temperature, ALWAYS use Fahrenheit unless the user specifically asks for Celsius.${locationContext}${timeContext}
The user will provide a text message. Respond to their request.

IMPORTANT VISION INSTRUCTIONS:
If the user asks you to look at something on their screen, or mentions an error, image, or anything visual that you would need to see to answer, AND there is no image attached to the prompt, output EXACTLY the command [REQUEST_SCREENSHOT] and nothing else.
HOWEVER, if there is ALREADY an image attached to the prompt, you MUST NOT output [REQUEST_SCREENSHOT]. Instead, you must look at the attached image and answer the user's question directly!

IMPORTANT SPOTIFY INSTRUCTIONS:
You HAVE FULL CAPABILITY to play music, songs, artists, playlists, and albums on Spotify. Whenever the user asks you to play any of these, you MUST comply and output the command [SPOTIFY_TYPE: Search Term] in your RESPONSE. NEVER say you cannot play music or control Spotify, because you can. Do not use quotes inside the command.
For "TYPE", use SONG, ALBUM, PLAYLIST, or ARTIST.
Example for a song: "I'll play that for you right now. [SPOTIFY_SONG: Shape of You by Ed Sheeran]"
Example for an album: "Playing the album right now. [SPOTIFY_ALBUM: The Dark Side of the Moon by Pink Floyd]"
Example for an artist: "Here is some music by Drake. [SPOTIFY_ARTIST: Drake]"
Example for a playlist: "Playing your playlist now. [SPOTIFY_PLAYLIST: Liked Songs]"

IMPORTANT MEDIA AND SYSTEM CONTROLS:
You can control the system's volume and media playback. Whenever the user asks you to pause, play, skip, or change the volume, output the exact corresponding command in your RESPONSE:
- Pause or Resume playback: [MEDIA_PLAY_PAUSE]
- Next Track or Skip: [MEDIA_NEXT]
- Previous Track: [MEDIA_PREV]
- Volume Up: [VOLUME_UP]
- Volume Down: [VOLUME_DOWN]
- Mute or Unmute Volume: [VOLUME_MUTE]
Example: "I'll turn that down for you. [VOLUME_DOWN]"
Example: "Skipping to the next song. [MEDIA_NEXT]"

IMPORTANT MIC & TTS CONTROLS:
You can control both your microphone and your text-to-speech voice. Use these commands exactly:
- Mute microphone: [MUTE_MIC]
- Unmute microphone: [UNMUTE_MIC]
- Silence yourself (disable TTS / speak no more): [MUTE_TTS]
- Unsilence yourself (re-enable TTS): [UNMUTE_TTS]
Example: "I'll mute myself now. [MUTE_MIC]"
Example: "Going silent. [MUTE_TTS]"
Example: "I'm back. [UNMUTE_TTS]"

IMPORTANT TIMER CONTROLS:
You can set, cancel, or stop timers. When the user asks you to set a timer, determine the duration in seconds and the name/label they specified (default to "Timer" if none specified), and output the exact command [SET_TIMER: duration, label] in your RESPONSE. If the user asks to cancel or delete a timer, output [CANCEL_TIMER: label] in your RESPONSE.
Example: "Setting a timer for 3 minutes named brush. [SET_TIMER: 180, brush]"
Example: "Timer set for 10 seconds. [SET_TIMER: 10, Timer]"
Example: "Cancelling your brush timer. [CANCEL_TIMER: brush]"

IMPORTANT TASK / CHECKLIST CONTROLS:
You can manage the user's checklist/tasks. When the user asks you to add, remove, complete, or update a task, output the exact corresponding command in your RESPONSE.
CRITICAL RULES:
1. If the user says "mark as complete", "check off", "done", "finish" or similar WITHOUT specifying which task by name, you MUST ask which task via [FOLLOW_UP]. NEVER guess.
2. If the user says "remove" or "cancel" a task WITHOUT specifying which task, you MUST ask which one via [FOLLOW_UP].
3. NEVER say you completed or removed a task unless you are outputting the actual command to do so.

- Add a task: [ADD_TASK: text, optional_due_date]
- Remove/delete a task: [REMOVE_TASK: text_or_id]
- Mark a task as complete/done: [COMPLETE_TASK: text_or_id]
- Unmark / mark incomplete: [UNCOMPLETE_TASK: text_or_id]
- Clear all tasks: [CLEAR_ALL_TASKS]
- Set task due date: [SET_TASK_DUE: text_or_id, due_date]
Example: "Adding buy milk to your checklist. [ADD_TASK: buy milk]"
Example: "Removing the buy milk task. [REMOVE_TASK: buy milk]"
Example: "Marked buy milk as done. [COMPLETE_TASK: buy milk]"
Example: "Clearing all tasks for you. [CLEAR_ALL_TASKS]"
Example: "Which task would you like me to mark as complete? [FOLLOW_UP]"

IMPORTANT SYSTEM LAUNCH CONTROLS:
You HAVE FULL CAPABILITY to open or launch applications on the user's computer. Whenever the user asks you to open an app (e.g. Discord, Chrome, Word, etc.), you MUST output the command [OPEN_APP: AppName] in your RESPONSE. NEVER say you cannot open apps.
Example: "Opening Discord for you now. [OPEN_APP: Discord]"
Example: "I'll launch Chrome right away. [OPEN_APP: Google Chrome]"

IMPORTANT FOLLOW-UP:
If you need more information from the user to complete their request (e.g. you need to know which timer, which task, a clarification, a name, etc.), you MUST output the command [FOLLOW_UP] at the END of your RESPONSE. This will open a 5-second microphone window for them to answer. Only use this when genuinely needed.
Example: "Which timer would you like me to cancel? [FOLLOW_UP]"
Example: "Got it, what should I name the task? [FOLLOW_UP]"

Your response will be spoken aloud, so do NOT use markdown, bullet points, code blocks, or any visual formatting.

Format your response EXACTLY like this:
USER_SAID: [the user's text message here]
RESPONSE: [your conversational response]`;

  const requestParts = [];
  
  if (base64Image) {
    const justData = base64Image.split(',')[1];
    requestParts.push({ inline_data: { mime_type: 'image/png', data: justData } });
  }

  let textPrompt = `Context: ${buildHistoryContext()}\nThe user typed: "${textInput}". Please respond.`;
  if (base64Image) {
    textPrompt = `Context: ${buildHistoryContext()}\nThe user typed: "${textInput}". Here is the screenshot they just provided for you to look at. Answer their request.`;
  }
  
  requestParts.push({ text: textPrompt });

  const body = {
    system_instruction: {
      parts: [{ text: systemInstruction }]
    },
    tools: [
      { google_search: {} }
    ],
    contents: [{
      parts: requestParts
    }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxOutputTokens: 400
    }
  };

  let keysTriedThisCall = 0;
  const maxKeyAttempts = apiKeyRotation ? apiKeys.length : 1;

  for (let attempt = 0; attempt < 3; attempt++) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (response.status === 429) {
      if (apiKeyRotation && keysTriedThisCall < maxKeyAttempts - 1) {
        currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
        apiKey = apiKeys[currentKeyIndex];
        keysTriedThisCall++;
        console.log(`[Olanga] Rate limited! Rotating to Key ${currentKeyIndex + 1}...`);
        continue;
      }
      const waitTime = (attempt + 1) * 15;
      console.log(`[Olanga] Rate limited. Waiting ${waitTime}s...`);
      await new Promise(r => setTimeout(r, waitTime * 1000));
      keysTriedThisCall = 0;
      continue;
    }

    if (!response.ok) {
      const errText = await response.text();
      let errMsg;
      try {
        const errData = JSON.parse(errText);
        errMsg = `Google API Error ${errData?.error?.code}: ${errData?.error?.message}`;
      } catch {
        errMsg = `HTTP ${response.status}: ${errText.substring(0, 200)}`;
      }
      throw new Error(errMsg);
    }

    const data = await response.json();
    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      return data.candidates[0].content.parts[0].text.trim();
    }
    throw new Error('No response from Gemini');
  }
  
  throw new Error('Rate limited across all keys. Please try again later.');
}

async function processTextCommandWithGemini(userTextInput) {
  if (!apiKey) {
    showError('Please configure your Gemini API key in settings');
    return;
  }
  if (!userTextInput.trim()) return;

  if (isRecording) {
    cancelRecording();
  }

  if (followUpTimer) {
    clearTimeout(followUpTimer);
    followUpTimer = null;
  }

  setState(State.THINKING);
  hint.classList.add('hidden');
  
  try {
    console.log(`[Olanga] 🚀 Dispatching TEXT request to Gemini API...`);

    const response = await sendTextToGemini(userTextInput);
    
    // DEBUG: Log raw response from Gemini (text mode)
    console.log('[Olanga DEBUG] Raw Gemini response (text):', JSON.stringify(response));
    
    let parsed = parseResponse(response);
    
    // DEBUG: Log parsed response
    console.log('[Olanga DEBUG] Parsed response (text):', JSON.stringify(parsed.response));
    
    // In text mode, we already know exactly what the user said
    userText.textContent = userTextInput;
    transcriptUser.classList.remove('hidden');

    // Add to history
    conversationHistory.push({ role: 'user', text: userTextInput });

    let spokenResponse = parsed.response;
    
    // Intercept Open App command
    const openAppMatch = spokenResponse.match(/\[OPEN_APP:\s*([^\]]+)\]/i);
    if (openAppMatch) {
      const appName = openAppMatch[1].trim();
      console.log(`[Olanga] 🖥️ Opening App: ${appName}`);
      window.electronAPI.openApp(appName);
      spokenResponse = spokenResponse.replace(openAppMatch[0], '').trim();
      if (!spokenResponse) spokenResponse = `Opening ${appName} for you now.`;
    }

    const spotifyMatch = spokenResponse.match(/\[SPOTIFY_(SONG|ALBUM|PLAYLIST|ARTIST):\s*([^\]]+)\]/i);
    if (spotifyMatch) {
      const type = spotifyMatch[1].toUpperCase();
      const searchTerm = spotifyMatch[2].trim().replace(/^"|"$/g, '');
      console.log(`[Olanga] 🎵 Requesting Spotify play for ${type}: ${searchTerm}`);
      window.electronAPI.playSpotify(type, searchTerm);
      spokenResponse = spokenResponse.replace(spotifyMatch[0], '').trim();
      if (!spokenResponse) spokenResponse = `Playing your request on Spotify.`;
    }

    // Intercept Media/Volume commands
    const mediaRegex = /\[(MEDIA_PLAY_PAUSE|MEDIA_NEXT|MEDIA_PREV|VOLUME_UP|VOLUME_DOWN|VOLUME_MUTE)\]/ig;
    let mediaMatch;
    while ((mediaMatch = mediaRegex.exec(spokenResponse)) !== null) {
      const command = mediaMatch[1].toUpperCase();
      console.log(`[Olanga] 🎛️ Media control requested: ${command}`);
      window.electronAPI.mediaControl(command);
    }
    spokenResponse = spokenResponse.replace(mediaRegex, '').trim();

    // Intercept Mic Mute/Unmute command
    const micMuteRegex = /\[(MUTE_MIC|UNMUTE_MIC|MUTE_TTS|UNMUTE_TTS)\]/ig;
    let micMuteMatch;
    while ((micMuteMatch = micMuteRegex.exec(spokenResponse)) !== null) {
      const command = micMuteMatch[1].toUpperCase();
      console.log(`[Olanga] 🎙️ Audio control requested: ${command}`);
      if (command === 'MUTE_MIC') muteMic();
      else if (command === 'UNMUTE_MIC') unmuteMic();
      else if (command === 'MUTE_TTS') muteTts();
      else if (command === 'UNMUTE_TTS') unmuteTts();
    }
    spokenResponse = spokenResponse.replace(micMuteRegex, '').trim();

    // Intercept Timer commands
    const setTimerMatch = spokenResponse.match(/\[SET_TIMER:\s*(\d+),\s*([^\]]+)\]/i);
    if (setTimerMatch) {
      const duration = parseInt(setTimerMatch[1]);
      const label = setTimerMatch[2].trim();
      console.log(`[Olanga] ⏱️ Timer requested: ${duration}s, labeled: ${label}`);
      createTimer(duration, label);
      spokenResponse = spokenResponse.replace(setTimerMatch[0], '').trim();
    }

    const cancelTimerMatch = spokenResponse.match(/\[CANCEL_TIMER:\s*([^\]]+)\]/i);
    if (cancelTimerMatch) {
      const label = cancelTimerMatch[1].trim();
      console.log(`[Olanga] ⏱️ Cancel timer requested: ${label}`);
      cancelTimerByLabel(label);
      spokenResponse = spokenResponse.replace(cancelTimerMatch[0], '').trim();
    }

    // Intercept Task commands
    const addTaskMatch = spokenResponse.match(/\[ADD_TASK:\s*([^,\]]+)(?:,\s*([^\]]+))?\]/i);
    if (addTaskMatch) {
      const text = addTaskMatch[1].trim();
      const dueDate = addTaskMatch[2] ? addTaskMatch[2].trim() : null;
      console.log(`[Olanga] 📋 Task add requested: "${text}", due: ${dueDate}`);
      addTask(text, dueDate);
      spokenResponse = spokenResponse.replace(addTaskMatch[0], '').trim();
    }

    const removeTaskMatch = spokenResponse.match(/\[REMOVE_TASK:\s*([^\]]+)\]/i);
    if (removeTaskMatch) {
      const target = removeTaskMatch[1].trim();
      console.log(`[Olanga] 📋 Task remove requested for: "${target}"`);
      removeTask(target);
      spokenResponse = spokenResponse.replace(removeTaskMatch[0], '').trim();
    }

    const clearTasksMatch = spokenResponse.match(/\[CLEAR_ALL_TASKS\]/i);
    if (clearTasksMatch) {
      console.log(`[Olanga] 📋 Task clear all requested`);
      clearAllTasks();
      spokenResponse = spokenResponse.replace(clearTasksMatch[0], '').trim();
    }

    const setTaskDueMatch = spokenResponse.match(/\[SET_TASK_DUE:\s*([^,\]]+),\s*([^\]]+)\]/i);
    if (setTaskDueMatch) {
      const target = setTaskDueMatch[1].trim();
      const dueDate = setTaskDueMatch[2].trim();
      console.log(`[Olanga] 📋 Task due date update requested for: "${target}" to "${dueDate}"`);
      setTaskDue(target, dueDate);
      spokenResponse = spokenResponse.replace(setTaskDueMatch[0], '').trim();
    }

    const completeTaskMatch2 = spokenResponse.match(/\[COMPLETE_TASK:\s*([^\]]+)\]/i);
    if (completeTaskMatch2) {
      const target = completeTaskMatch2[1].trim();
      console.log(`[Olanga] 📋 Task complete requested for: "${target}"`);
      completeTask(target, true);
      spokenResponse = spokenResponse.replace(completeTaskMatch2[0], '').trim();
    }

    const uncompleteTaskMatch2 = spokenResponse.match(/\[UNCOMPLETE_TASK:\s*([^\]]+)\]/i);
    if (uncompleteTaskMatch2) {
      const target = uncompleteTaskMatch2[1].trim();
      console.log(`[Olanga] 📋 Task uncomplete requested for: "${target}"`);
      completeTask(target, false);
      spokenResponse = spokenResponse.replace(uncompleteTaskMatch2[0], '').trim();
    }

    // Intercept Follow-Up request (catch variants: [FOLLOW_UP], [follow_up], [Follow Up], [followup])
    const followUpRegex2 = /\[FOLLOW[_ ]?UP\]/gi;
    const wantsFollowUp = followUpRegex2.test(spokenResponse) || spokenResponse.trim().endsWith('?');
    console.log('[Olanga DEBUG] wantsFollowUp (text) =', wantsFollowUp, '| spokenResponse before strip:', JSON.stringify(spokenResponse));
    spokenResponse = spokenResponse.replace(/\[FOLLOW[_ ]?UP\]/gi, '').trim();

    // Intercept Screenshot request
    if (spokenResponse.includes('[REQUEST_SCREENSHOT]')) {
      console.log(`[Olanga] 📸 Screenshot requested by AI`);
      aiText.textContent = "Please select an area on your screen...";
      const base64Image = await window.electronAPI.requestScreenshot();
      if (!base64Image) {
        console.log(`[Olanga] 📸 Screenshot cancelled by user or timed out`);
        aiText.textContent = "Screenshot cancelled.";
        setState(State.IDLE);
        return;
      }
      aiText.textContent = "Processing image...";
      const secondResponseRaw = await sendTextToGemini(userTextInput, base64Image);
      parsed = parseResponse(secondResponseRaw);
      spokenResponse = parsed.response;
    }

    conversationHistory.push({ role: 'model', text: spokenResponse });

    if (conversationHistory.length > 20) {
      conversationHistory = conversationHistory.slice(-16);
    }

    aiText.textContent = spokenResponse;
    transcriptAi.classList.remove('hidden');

    if (wantsFollowUp) {
      console.log('[Olanga] 🔁 AI requested a follow-up from the user (text mode)');
      await speakResponseAndThen(spokenResponse, () => enterAiFollowUpMode());
    } else {
      speakResponse(spokenResponse);
    }

  } catch (error) {
    console.error('[Olanga] ❌ Processing error:', error);
    showError(error.message || 'Failed to process text');
    setState(State.IDLE);
  }
}

function buildHistoryContext() {
  let context = '';
  
  if (activeTasks && activeTasks.length > 0) {
    const taskNames = activeTasks.map(t => `- "${t.text}" (Completed: ${t.completed})`).join('\n');
    context += `CURRENT TASKS:\n${taskNames}\n\n`;
  }
  
  if (conversationHistory.length > 0) {
    const recent = conversationHistory.slice(-6);
    const lines = recent.map(m => `${m.role === 'user' ? 'User' : 'Olanga'}: ${m.text}`);
    context += `Recent conversation:\n${lines.join('\n')}`;
  }
  
  return context;
}

// ============================================
// PCM → WAV HELPER (needed for TTS output)
// ============================================

function pcmToWav(pcmBytes, sampleRate, numChannels, bitDepth) {
  const byteRate = sampleRate * numChannels * (bitDepth / 8);
  const blockAlign = numChannels * (bitDepth / 8);
  const dataSize = pcmBytes.length;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // Subchunk1Size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  new Uint8Array(buffer).set(pcmBytes, 44);
  return new Blob([buffer], { type: 'audio/wav' });
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBase64ToUint8Array(base64Text) {
  const binary = atob(base64Text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function parseMagpieAudioText(payloadText) {
  const trimmed = payloadText.trim();
  if (!trimmed) {
    throw new Error('Empty NVIDIA TTS response');
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.audio === 'string') {
      return decodeBase64ToUint8Array(parsed.audio);
    }
    if (typeof parsed?.content === 'string') {
      return decodeBase64ToUint8Array(parsed.content);
    }
  } catch (error) {
    // Streamed audio is often plain text rather than JSON.
  }

  const chunks = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => line.startsWith('data:') ? line.slice(5).trim() : line)
    .filter(Boolean)
    .map((line) => {
      try {
        const maybeJson = JSON.parse(line);
        return typeof maybeJson?.audio === 'string' ? maybeJson.audio : line;
      } catch (error) {
        return line;
      }
    })
    .filter(Boolean);

  if (chunks.length === 0) {
    return decodeBase64ToUint8Array(trimmed);
  }

  return concatUint8Arrays(chunks.map(decodeBase64ToUint8Array));
}

function getSelectedNvidiaVoiceConfig() {
  const selected = nvidiaVoiceCatalog.find(voice => voice.voiceName === nvidiaVoiceName);
  if (selected) return selected;
  return {
    languageCode: inferVoiceLanguageCode(nvidiaVoiceName),
    voiceName: nvidiaVoiceName || defaultNvidiaVoiceName,
    label: nvidiaVoiceName || defaultNvidiaVoiceName
  };
}

function inferVoiceLanguageCode(voiceName) {
  if (!voiceName) return 'en-US';
  const normalized = voiceName.toLowerCase();
  const languageMatch = normalized.match(/(?:magpie-multilingual\.)?([a-z]{2}-[a-z]{2})\./i) || normalized.match(/([a-z]{2}-[a-z]{2})/i);
  return languageMatch ? normalizeLanguageCode(languageMatch[1]) : 'en-US';
}

function playAudioBlob(blob, callback, doneLabel) {
  const audioUrl = URL.createObjectURL(blob);
  const audio = new Audio(audioUrl);
  audio.volume = isMuted ? 0 : currentVolume;
  audio.playbackRate = Number.isFinite(ttsRate) ? ttsRate : 1;
  currentTTSAudio = audio;
  audio.addEventListener('ended', () => {
    URL.revokeObjectURL(audioUrl);
    currentTTSAudio = null;
    if (doneLabel) {
      console.log(doneLabel);
    }
    if (callback) callback();
    else setState(State.IDLE);
  });
  audio.addEventListener('error', (error) => {
    URL.revokeObjectURL(audioUrl);
    currentTTSAudio = null;
    console.error('[Olanga] TTS playback error:', error);
    if (callback) callback();
    else setState(State.IDLE);
  });
  audio.play().catch((error) => {
    URL.revokeObjectURL(audioUrl);
    currentTTSAudio = null;
    console.error('[Olanga] TTS autoplay error:', error);
    if (callback) callback();
    else setState(State.IDLE);
  });
}

async function speakWithNvidiaTts(text, callback) {
  if (!nvidiaApiKey) {
    throw new Error('NVIDIA API key is missing');
  }

  const voiceConfig = getSelectedNvidiaVoiceConfig();
  const requestBody = JSON.stringify({
    text,
    voiceName: voiceConfig.voiceName || defaultNvidiaVoiceName,
    encoding: 'LINEAR_PCM',
    sampleRateHz: 44100,
    languageCode: voiceConfig.languageCode || 'en-US'
  });

  const response = await fetch('https://integrate.api.nvidia.com/v2/riva/tts/synthesize', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${nvidiaApiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/plain, application/json, audio/wav',
      'function-id': nvidiaFunctionId,
      'NVCF-Function-Id': nvidiaFunctionId
    },
    body: requestBody
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NVIDIA TTS error: ${response.status} ${errorText}`.trim());
  }

  const contentType = response.headers.get('content-type') || '';
  const audioBlob = contentType.includes('audio/')
    ? await response.blob()
    : pcmToWav(parseMagpieAudioText(await response.text()), 44100, 1, 16);
  playAudioBlob(audioBlob, callback, '[Olanga] Done speaking (Magpie TTS)');
  return true;
}

// ============================================
// FOLLOW-UP HELPERS
// ============================================

// Speaks a response then fires a callback once done
async function speakResponseAndThen(text, callback) {
  if (isTtsMuted) {
    if (callback) callback();
    else setState(State.IDLE);
    return;
  }

  setState(State.SPEAKING);
  synthesis.cancel();

  if (nvidiaApiKey) {
    try {
      await speakWithNvidiaTts(text, callback);
      return;
    } catch (err) {
      console.error('[Olanga] NVIDIA TTS failed:', err.message);
      showError(`NVIDIA TTS failed: ${err.message}`);
      if (callback) callback();
      else setState(State.IDLE);
      return;
    }
  }

  showError('Please add an NVIDIA API key to use TTS.');
  if (callback) callback();
  else setState(State.IDLE);
}

// Opens a 5-second listening window specifically triggered by an AI [FOLLOW_UP] command
function enterAiFollowUpMode() {
  if (isMicMuted) {
    console.log('[Olanga] Mic is muted. Entering text-based follow-up window.');
    setState(State.IDLE, true); // Go IDLE but preserve memory so they can type
    hint.innerHTML = 'Waiting for your typed reply...';
    hint.classList.remove('hidden');
    
    if (followUpTimer) clearTimeout(followUpTimer);
    followUpTimer = setTimeout(() => {
      console.log('[Olanga] AI follow-up window expired (text)');
      setState(State.IDLE); // Clear memory for real
      followUpTimer = null;
    }, 5000);
    return;
  }

  setState(State.LISTENING);
  hint.innerHTML = 'Listening for your reply...';
  hint.classList.remove('hidden');
  startRecording();

  if (followUpTimer) clearTimeout(followUpTimer);

  followUpTimer = setTimeout(() => {
    if (currentState === State.LISTENING) {
      console.log('[Olanga] AI follow-up window expired (voice)');
      cancelRecording();
      setState(State.IDLE);
      followUpTimer = null;
      hint.innerHTML = 'Say <strong>"Hey Olanga"</strong> to start';
    }
  }, 5000); // 5 seconds as requested
}

function parseResponse(raw) {
  let userSaid = '';
  let response = raw;

  const userMatch = raw.match(/USER_SAID:\s*(.+?)(?:\n|RESPONSE:)/is);
  const responseMatch = raw.match(/RESPONSE:\s*(.+)/is);

  if (userMatch) {
    userSaid = userMatch[1].trim();
  }

  if (responseMatch) {
    response = responseMatch[1].trim();
  } else if (userMatch) {
    response = raw.substring(raw.indexOf(userMatch[0]) + userMatch[0].length).trim();
  }

  return { userSaid, response };
}

// ============================================
// TEXT-TO-SPEECH
// ============================================

async function speakResponse(text) {
  if (isTtsMuted) {
    setState(State.IDLE);
    return;
  }

  setState(State.SPEAKING);
  synthesis.cancel();

  if (nvidiaApiKey) {
    try {
      await speakWithNvidiaTts(text, null);
      return;
    } catch (e) {
      console.error('[Olanga] NVIDIA TTS failed:', e.message);
      showError(`NVIDIA TTS failed: ${e.message}`);
      setState(State.IDLE);
      return;
    }
  }
  showError('Please add an NVIDIA API key to use Magpie TTS.');
  setState(State.IDLE);
}

function enterFollowUpMode() {
  setState(State.LISTENING);
  hint.innerHTML = 'Ask a follow-up or say <strong>"Hey Olanga"</strong> anytime';
  hint.classList.remove('hidden');
  startRecording();

  if (followUpTimer) clearTimeout(followUpTimer);

  followUpTimer = setTimeout(() => {
    if (currentState === State.LISTENING) {
      console.log('[Olanga] Follow-up window expired');
      cancelRecording();
      setState(State.IDLE);
      followUpTimer = null;
    }
  }, FOLLOW_UP_WINDOW);
}

// Ensure voices are loaded
if (synthesis.onvoiceschanged !== undefined) {
  synthesis.onvoiceschanged = () => {
    console.log('[Olanga] Voices loaded:', synthesis.getVoices().length);
  };
}

// ============================================
// ORB CANVAS ANIMATION
// ============================================

function startOrbAnimation() {
  const canvas = orbCanvas;
  const ctx = orbCanvasCtx;
  if (!ctx) return;

  let time = 0;

  function draw() {
    time += 0.02;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = 80;

    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2 + time;
      const dist = radius * 0.5 + Math.sin(time * 2 + i) * 20;
      const x = cx + Math.cos(angle) * dist * 0.6;
      const y = cy + Math.sin(angle) * dist * 0.6;
      const size = 2 + Math.sin(time + i * 0.5) * 1.5;

      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${0.1 + Math.sin(time + i) * 0.08})`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.7, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.03 + Math.sin(time * 1.5) * 0.02})`;
    ctx.lineWidth = 1;
    ctx.stroke();

    animationFrameId = requestAnimationFrame(draw);
  }

  draw();
}

// ============================================
// CLOCK LOGIC
// ============================================
function updateClock() {
  if (!clockDisplay) return;
  const now = new Date();
  let hours = now.getHours();
  let minutes = now.getMinutes();
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // the hour '0' should be '12'
  minutes = minutes < 10 ? '0' + minutes : minutes;
  clockDisplay.textContent = `${hours}:${minutes} ${ampm}`;

  // Update date
  if (dateDisplay) {
    const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    dateDisplay.textContent = now.toLocaleDateString('en-US', options);
  }
}

// ============================================
// ERROR TOAST
// ============================================

function showError(message) {
  const existing = document.querySelector('.error-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'error-toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

// ============================================
// CLEANUP
// ============================================

window.addEventListener('beforeunload', () => {
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioContext) audioContext.close();
  synthesis.cancel();
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (voskModel) voskModel.terminate();
});

// ---- Boot ----
document.addEventListener('DOMContentLoaded', init);

// ============================================
// AUDIO CONTROLS (Mute, Silence, Volume)
// ============================================

function initAudioControls() {
  const savedMicMute = localStorage.getItem('olanga_mic_muted');
  if (savedMicMute === 'true') {
    muteMic();
  } else {
    unmuteMic();
  }

  const savedTtsMute = localStorage.getItem('olanga_tts_muted');
  if (savedTtsMute === 'true') {
    muteTts();
  } else {
    unmuteTts();
  }

  if (micToggleBtn) {
    micToggleBtn.addEventListener('click', toggleMic);
  }

  if (ttsToggleBtn) {
    ttsToggleBtn.addEventListener('click', toggleTts);
  }
}

function muteMic() {
  isMicMuted = true;
  if (micToggleBtn) {
    micToggleBtn.classList.add('muted');
    micToggleBtn.title = "Unmute Microphone";
  }
  if (micIconOn && micIconOff) {
    micIconOn.style.display = 'none';
    micIconOff.style.display = 'block';
  }
  localStorage.setItem('olanga_mic_muted', 'true');
  console.log('[Olanga] Microphone muted');
  
  if (currentState === State.LISTENING) {
    cancelRecording();
    setState(State.IDLE);
  }
}

function unmuteMic() {
  isMicMuted = false;
  if (micToggleBtn) {
    micToggleBtn.classList.remove('muted');
    micToggleBtn.title = "Mute Microphone";
  }
  if (micIconOn && micIconOff) {
    micIconOn.style.display = 'block';
    micIconOff.style.display = 'none';
  }
  localStorage.setItem('olanga_mic_muted', 'false');
  console.log('[Olanga] Microphone unmuted');
}

function toggleMic() {
  if (isMicMuted) {
    unmuteMic();
  } else {
    muteMic();
  }
}

function muteTts() {
  isTtsMuted = true;
  if (ttsToggleBtn) {
    ttsToggleBtn.classList.add('muted');
    ttsToggleBtn.title = "Unmute Olanga (Enable TTS)";
  }
  if (ttsIconOn && ttsIconOff) {
    ttsIconOn.style.display = 'none';
    ttsIconOff.style.display = 'block';
  }
  localStorage.setItem('olanga_tts_muted', 'true');
  console.log('[Olanga] TTS muted');
}

function unmuteTts() {
  isTtsMuted = false;
  if (ttsToggleBtn) {
    ttsToggleBtn.classList.remove('muted');
    ttsToggleBtn.title = "Silence Olanga (Disable TTS)";
  }
  if (ttsIconOn && ttsIconOff) {
    ttsIconOn.style.display = 'block';
    ttsIconOff.style.display = 'none';
  }
  localStorage.setItem('olanga_tts_muted', 'false');
  console.log('[Olanga] TTS unmuted');
}

function toggleTts() {
  if (isTtsMuted) {
    unmuteTts();
  } else {
    muteTts();
  }
}

// ============================================
// TIMER MANAGEMENT SUBSYSTEM
// ============================================

function createTimer(durationSeconds, label = 'Timer') {
  const id = Date.now() + Math.random().toString(36).substr(2, 9);
  const durationMs = durationSeconds * 1000;
  const endTime = Date.now() + durationMs;
  
  const timerObj = {
    id,
    endTime,
    label: label || 'Timer',
    intervalId: null,
    ringing: false
  };
  
  activeTimers.push(timerObj);
  
  // Render the new timer immediately
  renderTimers();
  
  // Start the countdown interval
  timerObj.intervalId = setInterval(() => {
    const remainingMs = timerObj.endTime - Date.now();
    if (remainingMs <= 0) {
      clearInterval(timerObj.intervalId);
      timerObj.intervalId = null;
      ringTimer(timerObj);
    } else {
      updateTimerDisplay(timerObj);
    }
  }, 1000);
}

function ringTimer(timerObj) {
  timerObj.ringing = true;
  playAlarmSoundLoop();
  
  const card = document.getElementById(`timer-card-${timerObj.id}`);
  if (card) {
    card.classList.add('ringing');
    const timeEl = card.querySelector('.timer-time');
    if (timeEl) timeEl.textContent = '00:00';
  }
}

function cancelTimer(id) {
  const timerIndex = activeTimers.findIndex(t => t.id === id);
  if (timerIndex !== -1) {
    const timer = activeTimers[timerIndex];
    if (timer.intervalId) {
      clearInterval(timer.intervalId);
    }
    activeTimers.splice(timerIndex, 1);
    
    // Check if we can stop the alarm sound loop
    const stillRinging = activeTimers.some(t => t.ringing);
    if (!stillRinging && alarmIntervalId) {
      clearInterval(alarmIntervalId);
      alarmIntervalId = null;
    }
    
    renderTimers();
  }
}

function cancelTimerByLabel(label) {
  const lowercaseLabel = label.toLowerCase().trim();
  const matched = activeTimers.filter(t => t.label.toLowerCase().trim() === lowercaseLabel);
  if (matched.length > 0) {
    matched.forEach(t => cancelTimer(t.id));
  }
}

function clearAllTimers() {
  activeTimers.forEach(t => {
    if (t.intervalId) clearInterval(t.intervalId);
  });
  activeTimers = [];
  if (alarmIntervalId) {
    clearInterval(alarmIntervalId);
    alarmIntervalId = null;
  }
  renderTimers();
}

function renderTimers() {
  if (!timersContainer) return;
  timersContainer.innerHTML = '';
  
  if (activeTimers.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'timers-empty';
    emptyEl.textContent = 'No active timers';
    timersContainer.appendChild(emptyEl);
    return;
  }
  
  activeTimers.forEach(timer => {
    const card = document.createElement('div');
    card.className = `timer-card ${timer.ringing ? 'ringing' : ''}`;
    card.id = `timer-card-${timer.id}`;
    
    const remainingMs = timer.endTime - Date.now();
    const formatted = formatTime(remainingMs > 0 ? remainingMs : 0);
    
    card.innerHTML = `
      <div class="timer-info">
        <span class="timer-label">${escapeHTML(timer.label)}</span>
        <span class="timer-time">${formatted}</span>
      </div>
      <button class="timer-btn-close" title="Dismiss Timer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    `;
    
    const closeBtn = card.querySelector('.timer-btn-close');
    closeBtn.addEventListener('click', () => {
      cancelTimer(timer.id);
    });
    
    timersContainer.appendChild(card);
  });
}

function updateTimerDisplay(timerObj) {
  const card = document.getElementById(`timer-card-${timerObj.id}`);
  if (!card) return;
  
  const timeEl = card.querySelector('.timer-time');
  if (!timeEl) return;
  
  const remainingMs = timerObj.endTime - Date.now();
  timeEl.textContent = formatTime(remainingMs > 0 ? remainingMs : 0);
}

function formatTime(ms) {
  const totalSecs = Math.ceil(ms / 1000);
  const hrs = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const secs = totalSecs % 60;
  
  let result = '';
  if (hrs > 0) {
    result += (hrs < 10 ? '0' + hrs : hrs) + ':';
  }
  result += (mins < 10 ? '0' + mins : mins) + ':';
  result += (secs < 10 ? '0' + secs : secs);
  return result;
}

function parseTimerInput(input) {
  const cleaned = input.toLowerCase().trim();
  
  // Try matching patterns like "1h30m", "3m", "10s", "1h", "2m30s"
  const hMatch = cleaned.match(/(\d+)\s*h/);
  const mMatch = cleaned.match(/(\d+)\s*m/);
  const sMatch = cleaned.match(/(\d+)\s*s/);
  
  if (hMatch || mMatch || sMatch) {
    const hours = hMatch ? parseInt(hMatch[1]) : 0;
    const minutes = mMatch ? parseInt(mMatch[1]) : 0;
    const seconds = sMatch ? parseInt(sMatch[1]) : 0;
    return hours * 3600 + minutes * 60 + seconds;
  }
  
  // Plain number = seconds
  const num = parseInt(cleaned);
  if (!isNaN(num) && num > 0) {
    return num;
  }
  
  return 0;
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

function playAlarmSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    
    gain.gain.setValueAtTime(0.5, ctx.currentTime);
    const now = ctx.currentTime;
    
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
    
    gain.gain.setValueAtTime(0.5, now + 0.3);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);

    gain.gain.setValueAtTime(0.5, now + 0.6);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.75);
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    osc.start(now);
    osc.stop(now + 1.0);
  } catch (err) {
    console.error('Failed to play alarm sound:', err);
  }
}

function playAlarmSoundLoop() {
  if (alarmIntervalId) return;
  
  playAlarmSound();
  
  alarmIntervalId = setInterval(() => {
    const stillRinging = activeTimers.some(t => t.ringing);
    if (stillRinging) {
      playAlarmSound();
    } else {
      clearInterval(alarmIntervalId);
      alarmIntervalId = null;
    }
  }, 2000);
}

// ============================================
// TASK / CHECKLIST MANAGEMENT SUBSYSTEM
// ============================================

function saveTasks() {
  localStorage.setItem('olanga_tasks', JSON.stringify(activeTasks));
}

function loadTasks() {
  const stored = localStorage.getItem('olanga_tasks');
  if (stored) {
    try {
      activeTasks = JSON.parse(stored);
    } catch (e) {
      console.error('Failed to parse tasks', e);
      activeTasks = [];
    }
  }
}

function addTask(text, dueDate = null) {
  if (!text.trim()) return;
  const id = Date.now() + Math.random().toString(36).substr(2, 9);
  
  activeTasks.push({
    id,
    text: text.trim(),
    completed: false,
    dueDate: dueDate ? dueDate.trim() : null
  });
  
  saveTasks();
  renderTasks();
}

function removeTask(idOrText) {
  const lowercaseVal = idOrText.toLowerCase().trim();
  
  let index = activeTasks.findIndex(t => t.id === idOrText);
  if (index === -1) {
    index = activeTasks.findIndex(t => t.text.toLowerCase().includes(lowercaseVal));
  }
  
  if (index !== -1) {
    activeTasks.splice(index, 1);
    saveTasks();
    renderTasks();
  }
}

function clearAllTasks() {
  activeTasks = [];
  saveTasks();
  renderTasks();
}

function setTaskDue(idOrText, dueDate) {
  const lowercaseVal = idOrText.toLowerCase().trim();
  
  let task = activeTasks.find(t => t.id === idOrText);
  if (!task) {
    task = activeTasks.find(t => t.text.toLowerCase().includes(lowercaseVal));
  }
  
  if (task) {
    task.dueDate = dueDate ? dueDate.trim() : null;
    saveTasks();
    renderTasks();
  }
}

function toggleTaskComplete(id) {
  const task = activeTasks.find(t => t.id === id);
  if (task) {
    task.completed = !task.completed;
    saveTasks();
    renderTasks();
  }
}

function completeTask(idOrText, markDone = true) {
  const lowercaseVal = idOrText.toLowerCase().trim();

  let task = activeTasks.find(t => t.id === idOrText);
  if (!task) {
    task = activeTasks.find(t => t.text.toLowerCase().includes(lowercaseVal));
  }

  if (task) {
    task.completed = markDone;
    saveTasks();
    renderTasks();
    console.log(`[Olanga] ✅ Task "${task.text}" marked as ${markDone ? 'complete' : 'incomplete'}`);
  } else {
    console.warn(`[Olanga] ⚠️ Could not find task matching: "${idOrText}"`);
  }
}

function renderTasks() {
  const listContainer = document.getElementById('tasksList');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  
  if (activeTasks.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'tasks-empty';
    emptyEl.textContent = 'Checklist is empty';
    listContainer.appendChild(emptyEl);
    return;
  }
  
  activeTasks.forEach(task => {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.id = `task-item-${task.id}`;
    
    item.innerHTML = `
      <input type="checkbox" class="task-checkbox" ${task.completed ? 'checked' : ''} />
      <div class="task-content">
        <span class="task-text ${task.completed ? 'completed' : ''}">${escapeHTML(task.text)}</span>
        ${task.dueDate ? `<span class="task-due">📅 ${escapeHTML(task.dueDate)}</span>` : ''}
      </div>
      <button class="task-delete-btn" title="Delete Task">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;
    
    const cb = item.querySelector('.task-checkbox');
    cb.addEventListener('change', () => {
      toggleTaskComplete(task.id);
    });
    
    const delBtn = item.querySelector('.task-delete-btn');
    delBtn.addEventListener('click', () => {
      const idx = activeTasks.findIndex(t => t.id === task.id);
      if (idx !== -1) {
        activeTasks.splice(idx, 1);
        saveTasks();
        renderTasks();
      }
    });
    
    listContainer.appendChild(item);
  });
}

// ============================================
// FLOATING ICONS NAVIGATION
// ============================================

const floatingIcons = document.querySelectorAll('.floating-icon');
const notepadScreen = document.getElementById('notepadScreen');
const terminalScreen = document.getElementById('terminalScreen');
const settingsScreen = document.getElementById('settingsScreen');

const screens = {
  mainScreen,
  notepadScreen,
  terminalScreen,
  settingsScreen
};

floatingIcons.forEach(icon => {
  icon.addEventListener('click', () => {
    const targetScreen = icon.getAttribute('data-screen');
    
    // Update active state
    floatingIcons.forEach(i => i.classList.remove('active'));
    icon.classList.add('active');
    
    // Show target screen
    Object.keys(screens).forEach(key => {
      if (screens[key]) {
        screens[key].classList.add('hidden');
      }
    });
    
    if (screens[targetScreen]) {
      screens[targetScreen].classList.remove('hidden');
    }
    
    // Load settings values dynamically when navigating to the settings screen
    if (targetScreen === 'settingsScreen' && window.loadSettingsValues) {
      window.loadSettingsValues();
    }
  });
});

// ============================================
// NOTEPAD FUNCTIONALITY
// ============================================

const notepadTextarea = document.getElementById('notepadTextarea');
const notepadClearBtn = document.getElementById('notepadClearBtn');
const notepadExportBtn = document.getElementById('notepadExportBtn');
const notepadImportBtn = document.getElementById('notepadImportBtn');
const notepadBoldBtn = document.getElementById('notepadBoldBtn');
const notepadItalicBtn = document.getElementById('notepadItalicBtn');
const notepadStrikeBtn = document.getElementById('notepadStrikeBtn');
const notepadAiToggleBtn = document.getElementById('notepadAiToggleBtn');
const notepadRenameBtn = document.getElementById('notepadRenameBtn');
const notepadAiSidebar = document.getElementById('notepadAiSidebar');
const notepadAiCloseBtn = document.getElementById('notepadAiCloseBtn');
const notepadAiChat = document.getElementById('notepadAiChat');
const notepadAiInput = document.getElementById('notepadAiInput');
const notepadAiSendBtn = document.getElementById('notepadAiSendBtn');
const notepadAiModelSelect = document.getElementById('notepadAiModelSelect');
const notepadAiStatusDot = document.getElementById('notepadAiStatusDot');
const notepadAiStatusText = document.getElementById('notepadAiStatusText');
const notepadTabs = document.getElementById('notepadTabs');
const notepadTabAddBtn = document.getElementById('notepadTabAddBtn');

// Tab management
let notepadTabsData = [];
let currentTabId = 0;

// Load saved tabs
const savedTabs = localStorage.getItem('olangaNotepadTabs');
if (savedTabs) {
  try {
    notepadTabsData = JSON.parse(savedTabs);
  } catch (e) {
    console.error("Error parsing notepad tabs from localStorage, resetting tabs:", e);
    notepadTabsData = [{ id: 0, name: 'Note 1', content: '' }];
  }
} else {
  // Create default tab
  notepadTabsData = [{ id: 0, name: 'Note 1', content: '' }];
}

// Make sure currentTabId is initialized to an existing tab ID
if (notepadTabsData.length > 0) {
  const exists = notepadTabsData.some(t => t.id == currentTabId);
  if (!exists) {
    currentTabId = notepadTabsData[0].id;
  }
}

// Render tabs
function renderNotepadTabs() {
  notepadTabs.innerHTML = '';
  notepadTabsData.forEach(tab => {
    const tabBtn = document.createElement('button');
    tabBtn.className = `notepad-tab ${tab.id == currentTabId ? 'active' : ''}`;
    tabBtn.dataset.tab = tab.id;
    tabBtn.innerHTML = `${tab.name} <span class="notepad-tab-delete" data-tab="${tab.id}">×</span>`;
    tabBtn.addEventListener('click', (e) => {
      if (e.target.classList.contains('notepad-tab-delete')) {
        e.stopPropagation();
        deleteNotepadTab(tab.id);
      } else {
        switchNotepadTab(tab.id);
      }
    });
    notepadTabs.appendChild(tabBtn);
  });
  
  const addBtn = document.createElement('button');
  addBtn.className = 'notepad-tab-add';
  addBtn.id = 'notepadTabAddBtn';
  addBtn.textContent = '+';
  addBtn.title = 'Add New Tab';
  addBtn.addEventListener('click', addNotepadTab);
  notepadTabs.appendChild(addBtn);
}

// Add new tab
function addNotepadTab() {
  const newId = notepadTabsData.length > 0 ? Math.max(...notepadTabsData.map(t => Number(t.id))) + 1 : 0;
  const newTab = { id: newId, name: `Note ${notepadTabsData.length + 1}`, content: '' };
  notepadTabsData.push(newTab);
  saveNotepadTabs();
  switchNotepadTab(newId);
}

// Delete tab
function deleteNotepadTab(tabId) {
  if (notepadTabsData.length <= 1) {
    alert('Cannot delete the last tab.');
    return;
  }
  
  if (confirm('Delete this tab?')) {
    const tabIndex = notepadTabsData.findIndex(t => t.id == tabId);
    if (tabIndex !== -1) {
      // Save current content before deleting
      notepadTabsData[tabIndex].content = notepadTextarea.innerHTML;
      
      notepadTabsData = notepadTabsData.filter(t => t.id != tabId);
      saveNotepadTabs();
      
      // Switch to another tab
      const newCurrentTab = notepadTabsData[Math.max(0, tabIndex - 1)];
      switchNotepadTab(newCurrentTab.id);
    }
  }
}

// Switch tab
function switchNotepadTab(tabId) {
  // Save current content
  const currentTab = notepadTabsData.find(t => t.id == currentTabId);
  if (currentTab) {
    currentTab.content = notepadTextarea.innerHTML;
  }
  
  currentTabId = tabId;
  const newTab = notepadTabsData.find(t => t.id == tabId);
  if (newTab) {
    notepadTextarea.innerHTML = newTab.content;
  }
  
  renderNotepadTabs();
}

// Save tabs to localStorage
function saveNotepadTabs() {
  localStorage.setItem('olangaNotepadTabs', JSON.stringify(notepadTabsData));
}

// Rename tab (double-click on tab)
notepadTabs.addEventListener('dblclick', (e) => {
  const tabBtn = e.target.closest('.notepad-tab');
  if (tabBtn && !tabBtn.classList.contains('notepad-tab-add')) {
    const tabId = tabBtn.dataset.tab;
    const tab = notepadTabsData.find(t => t.id == tabId);
    if (tab) {
      const newName = prompt('Enter new tab name:', tab.name);
      if (newName && newName.trim()) {
        tab.name = newName.trim();
        saveNotepadTabs();
        renderNotepadTabs();
      }
    }
  }
});

// Auto-save on input
notepadTextarea.addEventListener('input', () => {
  const currentTab = notepadTabsData.find(t => t.id == currentTabId);
  if (currentTab) {
    currentTab.content = notepadTextarea.innerHTML;
    saveNotepadTabs();
  }
});

// Clear current note
notepadClearBtn.addEventListener('click', () => {
  if (notepadTextarea.innerHTML.trim() && confirm('Clear the current note? Content will be lost.')) {
    notepadTextarea.innerHTML = '';
    const currentTab = notepadTabsData.find(t => t.id === currentTabId);
    if (currentTab) {
      currentTab.content = '';
      saveNotepadTabs();
    }
  } else if (!notepadTextarea.innerHTML.trim()) {
    notepadTextarea.innerHTML = '';
  }
});

// Export note as HTML file
notepadExportBtn.addEventListener('click', () => {
  const content = notepadTextarea.innerHTML;
  if (!content.trim()) {
    alert('The current note is empty. Nothing to export.');
    return;
  }
  
  const blob = new Blob([content], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const currentTab = notepadTabsData.find(t => t.id === currentTabId);
  a.download = `olanga-note-${currentTab ? currentTab.name : 'note'}-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// Import note from file (HTML, TXT, JSON, and popular code files)
notepadImportBtn.addEventListener('click', () => {
  const input = document.createElement('input');
  input.type = 'file';
  // Allow popular coding files, txt files, json files
  input.accept = '.txt,.json,.html,.htm,.css,.js,.ts,.py,.cpp,.h,.hpp,.cc,.cs,.java,.go,.rs,.rb,.php,.sh,.bat,.ps1,.md';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      // Load all files as plain text (so HTML shows its raw code rather than rendering it)
      notepadTextarea.textContent = event.target.result;
      
      const currentTab = notepadTabsData.find(t => t.id == currentTabId);
      if (currentTab) {
        currentTab.content = notepadTextarea.innerHTML;
        saveNotepadTabs();
      }
    };
    reader.readAsText(file);
  };
  input.click();
});

// Initialize tabs
renderNotepadTabs();
const initialTab = notepadTabsData.find(t => t.id == currentTabId);
if (initialTab) {
  notepadTextarea.innerHTML = initialTab.content;
}

// Text formatting buttons (use mousedown and preventDefault to keep editor focus)
notepadBoldBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.execCommand('bold', false, null);
  updateFormattingButtonsState();
});

notepadItalicBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.execCommand('italic', false, null);
  updateFormattingButtonsState();
});

notepadStrikeBtn.addEventListener('mousedown', (e) => {
  e.preventDefault();
  document.execCommand('strikeThrough', false, null);
  updateFormattingButtonsState();
});

// Update formatting button active states based on cursor selection
function updateFormattingButtonsState() {
  notepadBoldBtn.classList.toggle('active', document.queryCommandState('bold'));
  notepadItalicBtn.classList.toggle('active', document.queryCommandState('italic'));
  notepadStrikeBtn.classList.toggle('active', document.queryCommandState('strikeThrough'));
}

document.addEventListener('selectionchange', () => {
  if (document.activeElement === notepadTextarea) {
    updateFormattingButtonsState();
  }
});
notepadTextarea.addEventListener('keyup', updateFormattingButtonsState);
notepadTextarea.addEventListener('mouseup', updateFormattingButtonsState);

// Rename tab button
if (notepadRenameBtn) {
  notepadRenameBtn.addEventListener('click', () => {
    const tab = notepadTabsData.find(t => t.id == currentTabId);
    if (tab) {
      const newName = prompt('Enter new tab name:', tab.name);
      if (newName && newName.trim()) {
        tab.name = newName.trim();
        saveNotepadTabs();
        renderNotepadTabs();
      }
    }
  });
}

// ============================================
// NOTEPAD AI SIDEBAR
// ============================================

let notepadAiSidebarOpen = false;
let notepadAiChatHistory = [];
let notepadAiChatSummary = '';
const MAX_MESSAGES = 15;
const COMPACT_COUNT = 10;

// Toggle AI sidebar
notepadAiToggleBtn.addEventListener('click', () => {
  notepadAiSidebarOpen = !notepadAiSidebarOpen;
  notepadAiSidebar.classList.toggle('hidden', !notepadAiSidebarOpen);
});

// Close AI sidebar
notepadAiCloseBtn.addEventListener('click', () => {
  notepadAiSidebarOpen = false;
  notepadAiSidebar.classList.add('hidden');
});

// Send AI message
notepadAiSendBtn.addEventListener('click', sendNotepadAiMessage);
notepadAiInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    sendNotepadAiMessage();
  }
});

async function sendNotepadAiMessage() {
  const message = notepadAiInput.value.trim();
  if (!message) return;

  // Set AI status to working
  notepadAiStatusDot.classList.add('working');
  notepadAiStatusText.textContent = 'Working...';
  notepadAiSendBtn.disabled = true;

  // Add user message to chat
  addNotepadAiMessage(message, 'user');
  notepadAiInput.value = '';

  // Get current note content (convert HTML to plain text for AI)
  const noteContent = htmlToPlainText(notepadTextarea.innerHTML);

  // Get current tab name
  const currentTab = notepadTabsData.find(t => t.id == currentTabId);
  const currentTabName = currentTab ? currentTab.name : 'Note';

  // Get selected model
  const selectedModel = notepadAiModelSelect.value;
  
  // Map model names to Nvidia API models
  const modelMap = {
    'fast': 'meta/llama-3.1-8b-instruct',
    'smart': 'meta/llama-3.1-70b-instruct',
    'code': 'meta/llama-3.1-70b-instruct'
  };
  
  const modelName = modelMap[selectedModel] || 'meta/llama-3.1-70b-instruct';

  // Prepare AI prompt with note context and chat history
  let systemPrompt;

  if (selectedModel === 'code') {
    systemPrompt = `You are a precise code-writing assistant embedded in a notepad. Your job is to write or modify code exactly as instructed — nothing more, nothing less.

Current tab name: ${currentTabName}

STRICT RULES — follow these at all times:
- Write ONLY the code that was explicitly asked for. Do not add unrequested features, functions, or logic.
- Any explanation, reasoning, warnings, or notes MUST be written as code comments (e.g. // comment or /* comment */) — never as plain prose outside of code blocks.
- Always use correct formatting and indentation for the language being written.
- Match the indentation style already present in the note (spaces vs tabs).
- Keep code clean, readable, and production-quality.
- When you provide updated content, wrap it in triple backticks with the language tag (e.g. \`\`\`python) and start with "UPDATED NOTE:" to clearly indicate it's meant to replace the current note.

IMPORTANT: When the user asks you to rename the note/tab:
- If they want to rename the current tab, respond with "RENAMED TAB: [new name]" on its own line
- Keep the new name concise and descriptive (under 20 characters if possible)

Current note content:\n\n${noteContent || '(empty)'}`;
  } else {
    systemPrompt = `You are an AI assistant for a notepad application. You have access to the user's notes and can help them edit, organize, and improve their notes.

Current tab name: ${currentTabName}

IMPORTANT: When the user asks you to make changes to their notes:
- EDIT the existing content rather than replacing everything
- Make targeted changes to specific sections
- Preserve the structure and overall content
- Only replace what needs to be changed
- Use markdown formatting in the updated note: use ** for bold text, and # at the start of lines for headers (which will be bolded)
- When you provide updated content, wrap it in triple backticks (\`\`\`) and start with "UPDATED NOTE:" to clearly indicate it's meant to replace the current note

IMPORTANT: When the user asks you to rename the note/tab:
- If they want to rename the current tab, respond with "RENAMED TAB: [new name]" on its own line
- Keep the new name concise and descriptive (under 20 characters if possible)

Current note content:\n\n${noteContent || '(empty)'}`;
  };

  // Add chat summary if it exists
  if (notepadAiChatSummary) {
    systemPrompt += `\n\nPrevious conversation summary: ${notepadAiChatSummary}`;
  }

  // Build messages array with chat history
  const messages = [
    { role: 'system', content: systemPrompt }
  ];

  // Add recent chat history (last 5 messages for context)
  const recentHistory = notepadAiChatHistory.slice(-5);
  messages.push(...recentHistory);

  // Add current message
  messages.push({ role: 'user', content: message });

  try {
    // Get Nvidia API key from settings
    const nvidiaApiKey = localStorage.getItem('olanga_nvidia_key');
    if (!nvidiaApiKey) {
      addNotepadAiMessage('Please add your Nvidia API key in Settings to use the AI assistant.', 'ai');
      setAiStatusIdle();
      return;
    }

    // Call Nvidia API
    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nvidiaApiKey}`
      },
      body: JSON.stringify({
        model: modelName,
        messages: messages,
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error:', errorText);
      throw new Error(`API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content;

    // Add AI response to chat
    addNotepadAiMessage(aiResponse, 'ai');

    // Check if AI wants to rename the tab
    const renameMatch = aiResponse.match(/RENAMED TAB:\s*(.+)/i);
    if (renameMatch) {
      const newName = renameMatch[1].trim();
      if (newName && currentTab) {
        currentTab.name = newName;
        saveNotepadTabs();
        renderNotepadTabs();
        addNotepadAiMessage(`I've renamed the tab to "${newName}".`, 'ai');
      }
    }

    // Check if AI wants to update the notes
    const hasCodeBlock = /```[\s\S]*?```/.test(aiResponse);
    const hasUpdateKeywords = aiResponse.toLowerCase().includes('updated note') || 
                             aiResponse.toLowerCase().includes('here\'s the updated') || 
                             aiResponse.toLowerCase().includes('new content') ||
                             aiResponse.toLowerCase().includes('i\'ve updated') ||
                             aiResponse.toLowerCase().includes('here is the updated');
    
    if (hasCodeBlock || hasUpdateKeywords) {
      // Extract the updated note content — use code-safe path for code mode
      const isCodeMode = selectedModel === 'code';
      const updatedNote = isCodeMode
        ? extractUpdatedCode(aiResponse)
        : extractUpdatedNote(aiResponse);
      if (updatedNote && updatedNote !== noteContent) {
        notepadTextarea.innerHTML = updatedNote;
        // Restore focus and place cursor at end so the user can keep editing
        notepadTextarea.focus();
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(notepadTextarea);
        range.collapse(false); // collapse to end
        sel.removeAllRanges();
        sel.addRange(range);
        const currentTab = notepadTabsData.find(t => t.id == currentTabId);
        if (currentTab) {
          currentTab.content = updatedNote;
          saveNotepadTabs();
        }
        addNotepadAiMessage('I\'ve updated your notes with the changes.', 'ai');
      }
    }
  } catch (error) {
    console.error('AI error:', error);
    addNotepadAiMessage(`Sorry, I encountered an error: ${error.message}. Please check your Nvidia API key and try again.`, 'ai');
    notepadAiStatusDot.classList.add('error');
    notepadAiStatusText.textContent = 'Error';
  } finally {
    setAiStatusIdle();
  }
}

function setAiStatusIdle() {
  notepadAiStatusDot.classList.remove('working', 'error');
  notepadAiStatusText.textContent = 'Idle';
  notepadAiSendBtn.disabled = false;
}

function addNotepadAiMessage(text, type) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `notepad-ai-message ${type}-message`;
  
  const label = document.createElement('span');
  label.className = 'notepad-ai-label';
  label.textContent = type === 'user' ? 'You' : 'AI';
  
  const textP = document.createElement('p');
  textP.className = 'notepad-ai-text';
  // Strip markdown formatting from AI responses
  const cleanText = type === 'ai' ? stripMarkdown(text) : text;
  textP.textContent = cleanText;
  
  messageDiv.appendChild(label);
  messageDiv.appendChild(textP);
  
  notepadAiChat.appendChild(messageDiv);
  notepadAiChat.scrollTop = notepadAiChat.scrollHeight;
  
  // Add to chat history
  notepadAiChatHistory.push({ role: type === 'user' ? 'user' : 'assistant', content: text });
  
  // Check if we need to compact
  if (notepadAiChatHistory.length > MAX_MESSAGES) {
    compactChatHistory();
  }
}

function stripMarkdown(text) {
  // Remove markdown formatting
  return text
    .replace(/#{1,6}\s/g, '') // Remove headers
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
    .replace(/\*([^*]+)\*/g, '$1') // Remove italic
    .replace(/`([^`]+)`/g, '$1') // Remove inline code
    .replace(/```[\s\S]*?```/g, '') // Remove code blocks
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Remove links
    .replace(/^- /gm, '') // Remove list bullets
    .replace(/^\d+\. /gm, '') // Remove numbered lists
    .trim();
}

async function compactChatHistory() {
  // Get the oldest COMPACT_COUNT messages
  const messagesToCompact = notepadAiChatHistory.slice(0, COMPACT_COUNT);
  
  // Create a summary prompt
  const summaryPrompt = `Summarize the following conversation between a user and an AI assistant about editing notes. Keep it concise and focus on the main topics and decisions made:\n\n${messagesToCompact.map(m => `${m.role}: ${m.content}`).join('\n')}`;
  
  try {
    const nvidiaApiKey = localStorage.getItem('olanga_nvidia_key');
    if (!nvidiaApiKey) {
      return;
    }

    const response = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${nvidiaApiKey}`
      },
      body: JSON.stringify({
        model: 'meta/llama-3.1-70b-instruct',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that summarizes conversations concisely.' },
          { role: 'user', content: summaryPrompt }
        ],
        temperature: 0.3,
        max_tokens: 500
      })
    });

    if (response.ok) {
      const data = await response.json();
      notepadAiChatSummary = data.choices[0].message.content;
      
      // Remove the compacted messages from history
      notepadAiChatHistory = notepadAiChatHistory.slice(COMPACT_COUNT);
      
      // Add a system message indicating compaction
      const summaryDiv = document.createElement('div');
      summaryDiv.className = 'notepad-ai-message ai-message';
      summaryDiv.style.fontStyle = 'italic';
      summaryDiv.style.fontSize = '12px';
      summaryDiv.style.color = 'var(--text-dim)';
      summaryDiv.textContent = 'Chat Compacted';
      notepadAiChat.insertBefore(summaryDiv, notepadAiChat.firstChild);
    }
  } catch (error) {
    console.error('Failed to compact chat history:', error);
    // If compaction fails, just remove the old messages without a summary
    notepadAiChatHistory = notepadAiChatHistory.slice(COMPACT_COUNT);
  }
}

function extractUpdatedNote(aiResponse) {
  // Look for content between triple backticks with UPDATED NOTE marker
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = aiResponse.match(codeBlockRegex);
  
  if (codeBlocks && codeBlocks.length > 0) {
    // Extract content from the first code block
    let content = codeBlocks[0].replace(/```/g, '').trim();
    // Remove language identifier if present (e.g., ```text)
    const lines = content.split('\n');
    if (lines.length > 0 && /^[a-z]+$/i.test(lines[0])) {
      content = lines.slice(1).join('\n').trim();
    }
    // Convert markdown to HTML bold formatting
    return convertMarkdownToHtml(content);
  }
  
  // Fallback: look for UPDATED NOTE marker
  const lines = aiResponse.split('\n');
  let inNoteContent = false;
  let noteContent = [];
  
  for (const line of lines) {
    if (line.toLowerCase().includes('updated note:') || line.toLowerCase().includes('new content:') || line.toLowerCase().includes('---')) {
      inNoteContent = true;
      continue;
    }
    if (inNoteContent && (line.toLowerCase().includes('---') || line.trim() === '')) {
      break;
    }
    if (inNoteContent) {
      noteContent.push(line);
    }
  }
  
  if (noteContent.length > 0) {
    // Convert markdown to HTML bold formatting
    return convertMarkdownToHtml(noteContent.join('\n').trim());
  }
  
  // If no clear markers, return null (don't auto-update)
  return null;
}

// Code-safe extraction: preserves indentation, spaces, and comment lines exactly
function extractUpdatedCode(aiResponse) {
  const codeBlockRegex = /```(?:[a-zA-Z0-9]*)?(\n[\s\S]*?)```/;
  const match = aiResponse.match(codeBlockRegex);

  let rawCode = null;
  if (match) {
    rawCode = match[1];
  } else {
    // Fallback: everything after UPDATED NOTE:
    const marker = aiResponse.match(/UPDATED NOTE:\s*\n([\s\S]+)/i);
    if (marker) rawCode = marker[1];
  }

  if (!rawCode) return null;

  // Trim only trailing blank lines, preserve all internal whitespace
  rawCode = rawCode.replace(/\n+$/, '');

  // Convert to HTML preserving indentation:
  // - tabs → 4 non-breaking spaces
  // - leading spaces → non-breaking spaces (so contenteditable keeps them)
  // - newlines → <br>
  const lines = rawCode.split('\n');
  const htmlLines = lines.map(line => {
    // Escape HTML special chars first
    let escaped = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    // Preserve leading whitespace: replace each leading tab or space
    escaped = escaped.replace(/^(\t| )+/, (match) =>
      match.replace(/\t/g, '\u00a0\u00a0\u00a0\u00a0').replace(/ /g, '\u00a0')
    );
    return escaped;
  });

  return htmlLines.join('<br>');
}

function convertMarkdownToHtml(text) {
  // Convert markdown to HTML bold formatting
  let html = text;
  
  // Handle headers (# at start of line) - make whole line bold
  html = html.replace(/^#+\s+(.*)$/gm, '<strong>$1</strong>');
  
  // Handle bold (**text**) - multiline support
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // Handle italic (*text*) - multiline support
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // Convert newlines to <br> for contenteditable
  html = html.replace(/\n/g, '<br>');
  
  return html;
}

function htmlToPlainText(html) {
  // Convert HTML back to plain text for AI processing
  let text = html;
  
  // Convert <br> to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');
  
  // Convert <strong> to **
  text = text.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');
  
  // Convert <em> to *
  text = text.replace(/<em>(.*?)<\/em>/gi, '*$1*');
  
  // Remove any other HTML tags
  text = text.replace(/<[^>]+>/g, '');
  
  return text;
}

// ============================================
// TERMINAL FUNCTIONALITY
// ============================================

const terminalInput = document.getElementById('terminalInput');
const terminalOutput = document.getElementById('terminalOutput');
const terminalClearBtn = document.getElementById('terminalClearBtn');
const terminalPrompt = document.getElementById('terminalPrompt');

// Track the current directory state
let currentTerminalCwd = '';

// Check if we're in Electron environment
const isElectron = typeof window !== 'undefined' && window.process && window.process.type;

// Print PowerShell startup header
function printTerminalStartupHeader() {
  terminalOutput.innerHTML = '';
  
  const headerDiv = document.createElement('div');
  headerDiv.className = 'terminal-startup-header';
  headerDiv.innerHTML = `Windows PowerShell<br>Copyright (C) Microsoft Corporation. All rights reserved.<br><br>Try the new cross-platform PowerShell https://aka.ms/pscore6<br>`;
  terminalOutput.appendChild(headerDiv);
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// Initialize terminal CWD on startup
async function initTerminalCwd() {
  printTerminalStartupHeader();
  
  if (window.electronAPI && window.electronAPI.executeCommand) {
    try {
      // Run an empty command to fetch the default process CWD
      const result = await window.electronAPI.executeCommand({ command: '', cwd: null });
      if (result && result.cwd) {
        currentTerminalCwd = result.cwd;
        updateTerminalPromptText();
      }
    } catch (error) {
      console.error("Failed to initialize terminal CWD:", error);
      currentTerminalCwd = 'C:\\';
      updateTerminalPromptText();
    }
  } else {
    currentTerminalCwd = 'C:\\';
    updateTerminalPromptText();
  }
}

function updateTerminalPromptText() {
  if (terminalPrompt) {
    terminalPrompt.textContent = `PS ${currentTerminalCwd}>`;
  }
}

// Terminal input handling
terminalInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const command = terminalInput.value.trim();
    if (command) {
      executeTerminalCommand(command);
      terminalInput.value = '';
    }
  }
});

// Terminal clear button (now the X on the tab)
terminalClearBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  printTerminalStartupHeader();
});

// Execute terminal command
async function executeTerminalCommand(command) {
  // Add command to output matching custom Windows Terminal design
  const commandLine = document.createElement('div');
  commandLine.className = 'terminal-command-line';
  commandLine.innerHTML = `<span class="terminal-prompt">PS ${currentTerminalCwd}&gt;</span> <span class="terminal-command-text">${command}</span>`;
  terminalOutput.appendChild(commandLine);
  
  // Handle special commands
  if (command.toLowerCase() === 'clear' || command.toLowerCase() === 'cls') {
    printTerminalStartupHeader();
    return;
  }
  
  // Execute command using Node.js if in Electron
  if (window.electronAPI && window.electronAPI.executeCommand) {
    try {
      const response = await window.electronAPI.executeCommand({ command: command, cwd: currentTerminalCwd });
      
      // Update CWD if returned
      if (response && response.cwd) {
        currentTerminalCwd = response.cwd;
        updateTerminalPromptText();
      }
      
      // Add output to terminal
      if (response && response.output) {
        const outputLine = document.createElement('div');
        outputLine.textContent = response.output;
        terminalOutput.appendChild(outputLine);
      }
    } catch (error) {
      const errorLine = document.createElement('div');
      errorLine.style.color = 'var(--danger)';
      errorLine.textContent = error.message || 'Command execution failed';
      terminalOutput.appendChild(errorLine);
    }
  } else {
    // Fallback for non-Electron environment - use browser APIs
    let output = '';
    
    if (command.toLowerCase() === 'help') {
      output = 'Available commands: help, clear, cls, echo [text], date, whoami, ls, pwd';
    } else if (command.toLowerCase().startsWith('echo ')) {
      output = command.substring(5);
    } else if (command.toLowerCase() === 'date') {
      output = new Date().toString();
    } else if (command.toLowerCase() === 'whoami') {
      output = 'Olanga User';
    } else if (command.toLowerCase() === 'pwd') {
      output = currentTerminalCwd;
    } else if (command.toLowerCase() === 'ls') {
      output = 'index.html\nstyles.css\nrenderer.js\npackage.json\nnode_modules/';
    } else {
      output = `Command not found: ${command}. Type 'help' for available commands.`;
    }
    
    // Add output to terminal
    const outputLine = document.createElement('div');
    outputLine.textContent = output;
    terminalOutput.appendChild(outputLine);
  }
  
  // Scroll to bottom
  terminalOutput.scrollTop = terminalOutput.scrollHeight;
}

// Call initializer
initTerminalCwd();
