const { app, BrowserWindow, ipcMain, shell, Tray, Menu, clipboard } = require('electron');
const http2 = require('http2');
const path = require('path');

let mainWindow;
let tray = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    fullscreen: true,
    minWidth: 400,
    minHeight: 550,
    frame: false,
    transparent: true,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
      backgroundThrottling: false // CRITICAL: keeps VAD and audio processing running at full speed in the background
    },
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#00000000',
    titleBarStyle: 'hidden',
    hasShadow: true
  });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Prevent app from closing when clicking the X button
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  tray = new Tray(iconPath);
  
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Olanga', click: () => mainWindow.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => {
        app.isQuiting = true;
        app.quit();
      }
    }
  ]);
  
  tray.setToolTip('Olanga Voice Assistant');
  tray.setContextMenu(contextMenu);
  
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });
}

const GRPC_TTS_AUTHORITY = 'grpc.nvcf.nvidia.com';
const GRPC_TTS_SERVICE = 'nvidia.riva.RivaSpeechSynthesis';
const GRPC_TTS_SYNTHESIZE_PATH = `/${GRPC_TTS_SERVICE}/Synthesize`;
const GRPC_TTS_CONFIG_PATH = `/${GRPC_TTS_SERVICE}/GetRivaSynthesisConfig`;

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

function encodeLengthDelimitedField(fieldNumber, bytes) {
  return concatUint8Arrays([
    encodeVarint((fieldNumber << 3) | 2),
    encodeVarint(bytes.length),
    bytes
  ]);
}

function encodeStringField(fieldNumber, text) {
  return encodeLengthDelimitedField(fieldNumber, Buffer.from(text, 'utf8'));
}

function encodeVarintField(fieldNumber, value) {
  return concatUint8Arrays([
    encodeVarint((fieldNumber << 3) | 0),
    encodeVarint(value)
  ]);
}

function buildGrpcFrame(messageBytes) {
  const payload = Buffer.from(messageBytes);
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt8(0, 0);
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
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

function parseGrpcFrames(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const messages = [];
  let offset = 0;

  while (offset + 5 <= bytes.length) {
    const compressed = bytes.readUInt8(offset);
    const length = bytes.readUInt32BE(offset + 1);
    offset += 5;

    if (compressed !== 0) {
      throw new Error('Compressed gRPC frames are not supported');
    }

    if (offset + length > bytes.length) {
      break;
    }

    messages.push(bytes.slice(offset, offset + length));
    offset += length;
  }

  return messages;
}

function parseSynthesisConfigResponse(buffer) {
  const messages = parseGrpcFrames(buffer);
  const responseBytes = messages[0] || Buffer.alloc(0);
  let offset = 0;
  const modelConfig = [];

  while (offset < responseBytes.length) {
    const tagInfo = readVarint(responseBytes, offset);
    offset = tagInfo.offset;
    const fieldNumber = tagInfo.value >>> 3;
    const wireType = tagInfo.value & 7;

    if (fieldNumber === 1 && wireType === 2) {
      const configInfo = readDelimited(responseBytes, offset);
      offset = configInfo.offset;
      const configBytes = configInfo.value;
      let configOffset = 0;
      const config = { model_name: '', parameters: {} };

      while (configOffset < configBytes.length) {
        const configTagInfo = readVarint(configBytes, configOffset);
        configOffset = configTagInfo.offset;
        const configFieldNumber = configTagInfo.value >>> 3;
        const configWireType = configTagInfo.value & 7;

        if (configFieldNumber === 1 && configWireType === 2) {
          const modelInfo = readDelimited(configBytes, configOffset);
          configOffset = modelInfo.offset;
          config.model_name = Buffer.from(modelInfo.value).toString('utf8');
        } else if (configFieldNumber === 2 && configWireType === 2) {
          const entryInfo = readDelimited(configBytes, configOffset);
          configOffset = entryInfo.offset;
          const entryBytes = entryInfo.value;
          let entryOffset = 0;
          const entry = { key: '', value: '' };

          while (entryOffset < entryBytes.length) {
            const entryTagInfo = readVarint(entryBytes, entryOffset);
            entryOffset = entryTagInfo.offset;
            const entryFieldNumber = entryTagInfo.value >>> 3;
            const entryWireType = entryTagInfo.value & 7;

            if (entryWireType !== 2) {
              if (entryWireType === 0) {
                entryOffset = readVarint(entryBytes, entryOffset).offset;
              } else {
                throw new Error(`Unsupported config entry wire type: ${entryWireType}`);
              }
              continue;
            }

            const valueInfo = readDelimited(entryBytes, entryOffset);
            entryOffset = valueInfo.offset;
            const text = Buffer.from(valueInfo.value).toString('utf8');
            if (entryFieldNumber === 1) {
              entry.key = text;
            } else if (entryFieldNumber === 2) {
              entry.value = text;
            }
          }

          if (entry.key) {
            config.parameters[entry.key] = entry.value;
          }
        } else {
          if (configWireType === 0) {
            configOffset = readVarint(configBytes, configOffset).offset;
          } else if (configWireType === 2) {
            configOffset = readDelimited(configBytes, configOffset).offset;
          } else {
            throw new Error(`Unsupported config wire type: ${configWireType}`);
          }
        }
      }

      modelConfig.push(config);
    } else if (wireType === 0) {
      offset = readVarint(responseBytes, offset).offset;
    } else if (wireType === 2) {
      offset = readDelimited(responseBytes, offset).offset;
    } else {
      throw new Error(`Unsupported config response wire type: ${wireType}`);
    }
  }

  return { modelConfig };
}

function parseSynthResponse(buffer) {
  const messages = parseGrpcFrames(buffer);
  const responseBytes = messages[0] || Buffer.alloc(0);
  let offset = 0;

  while (offset < responseBytes.length) {
    const tagInfo = readVarint(responseBytes, offset);
    offset = tagInfo.offset;
    const fieldNumber = tagInfo.value >>> 3;
    const wireType = tagInfo.value & 7;

    if (fieldNumber === 1 && wireType === 2) {
      const audioInfo = readDelimited(responseBytes, offset);
      return Buffer.from(audioInfo.value);
    }

    if (wireType === 0) {
      offset = readVarint(responseBytes, offset).offset;
    } else if (wireType === 2) {
      offset = readDelimited(responseBytes, offset).offset;
    } else {
      throw new Error(`Unsupported synth response wire type: ${wireType}`);
    }
  }

  throw new Error('No audio returned from NVIDIA TTS');
}

function grpcUnaryCall({ pathName, apiKey, functionId, requestBytes }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(`https://${GRPC_TTS_AUTHORITY}`);
    const responseChunks = [];
    let responseHeaders = {};
    let responseTrailers = {};
    let settled = false;

    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      client.close();
      if (error) {
        reject(error);
      } else {
        resolve(buffer);
      }
    };

    client.on('error', (error) => finish(error));

    const request = client.request({
      ':method': 'POST',
      ':path': pathName,
      ':scheme': 'https',
      ':authority': GRPC_TTS_AUTHORITY,
      'content-type': 'application/grpc',
      te: 'trailers',
      authorization: `Bearer ${apiKey}`,
      'function-id': functionId,
      'NVCF-Function-Id': functionId
    });

    request.on('response', (headers) => {
      responseHeaders = headers;
    });

    request.on('data', (chunk) => {
      responseChunks.push(Buffer.from(chunk));
    });

    request.on('trailers', (trailers) => {
      responseTrailers = trailers;
    });

    request.on('end', () => {
      const grpcStatus = String(responseTrailers['grpc-status'] || responseHeaders['grpc-status'] || '0');
      if (grpcStatus !== '0') {
        const grpcMessage = Buffer.from(String(responseTrailers['grpc-message'] || responseHeaders['grpc-message'] || 'gRPC request failed')).toString('utf8');
        finish(new Error(`gRPC ${grpcStatus}: ${grpcMessage}`));
        return;
      }

      finish(null, Buffer.concat(responseChunks));
    });

    request.on('error', (error) => finish(error));

    request.end(buildGrpcFrame(requestBytes || Buffer.alloc(0)));
  });
}

async function fetchNvidiaTtsConfig(apiKey, functionId) {
  const responseBuffer = await grpcUnaryCall({
    pathName: GRPC_TTS_CONFIG_PATH,
    apiKey,
    functionId,
    requestBytes: Buffer.alloc(0)
  });

  return parseSynthesisConfigResponse(responseBuffer);
}

async function synthesizeNvidiaTts(apiKey, functionId, requestBytes) {
  const responseBuffer = await grpcUnaryCall({
    pathName: GRPC_TTS_SYNTHESIZE_PATH,
    apiKey,
    functionId,
    requestBytes
  });

  return parseSynthResponse(responseBuffer);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine, workingDirectory) => {
    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    createTray();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
}

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.hide();
});

ipcMain.on('open-external', (event, url) => {
  shell.openExternal(url);
});

ipcMain.on('play-spotify', (event, { type, term }) => {
  // Bring Spotify to the front
  shell.openExternal('spotify:');

  // Escape special characters for SendKeys: + ^ % ~ ( ) { } [ ]
  // Also escape single quotes for the PowerShell string literal
  const safeTermForSendKeys = term.replace(/[{}^%+~()[\]]/g, '{$&}');
  const safeTermForPowerShell = safeTermForSendKeys.replace(/'/g, "''");

  const { exec } = require('child_process');
  
  // Choose key based on type. Songs = Shift+Enter, Albums/Playlists/Artists = Enter
  const playKey = (type === 'SONG') ? '+{ENTER}' : '{ENTER}';
  
  const script = `
    $wshell = New-Object -ComObject wscript.shell;
    $wshell.SendKeys('^k');
    Start-Sleep -Milliseconds 600;
    $wshell.SendKeys('${safeTermForPowerShell}');
    Start-Sleep -Milliseconds 1500;
    $wshell.SendKeys('${playKey}');
  `;
  
  setTimeout(() => {
    exec(`powershell -Command "${script.replace(/\n/g, ' ')}"`);
  }, 1500);
});

ipcMain.on('media-control', (event, command) => {
  const { exec } = require('child_process');
  let charCode = 0;
  
  switch (command) {
    case 'VOLUME_MUTE': charCode = 173; break;
    case 'VOLUME_DOWN': charCode = 174; break;
    case 'VOLUME_UP': charCode = 175; break;
    case 'MEDIA_NEXT': charCode = 176; break;
    case 'MEDIA_PREV': charCode = 177; break;
    case 'MEDIA_PLAY_PAUSE': charCode = 179; break;
  }
  
  if (charCode > 0) {
    // If it's volume, we might want to press it multiple times so it's noticeable
    let repeat = (command === 'VOLUME_UP' || command === 'VOLUME_DOWN') ? 5 : 1;
    
    let script = `$wshell = New-Object -ComObject wscript.shell; `;
    for (let i = 0; i < repeat; i++) {
      script += `$wshell.SendKeys([char]${charCode}); `;
    }
    exec(`powershell -Command "${script}"`);
  }
});

ipcMain.on('open-app', (event, appName) => {
  const { spawn } = require('child_process');
  console.log(`[Main] Opening app via Windows Search: ${appName}`);
  // Use Windows Search to find and open the app
  const script = `
    $wshell = New-Object -ComObject wscript.shell
    $wshell.SendKeys('^{ESC}')
    Start-Sleep -Milliseconds 400
    $wshell.SendKeys('${appName}')
    Start-Sleep -Milliseconds 600
    $wshell.SendKeys('{ENTER}')
  `;
  
  const ps = spawn('powershell', ['-NoProfile', '-Command', script]);
  
  ps.stderr.on('data', (data) => {
    console.error(`[Main] PowerShell Error: ${data.toString()}`);
  });
});

ipcMain.handle('request-screenshot', async () => {
  return new Promise((resolve) => {
    clipboard.clear();
    
    const { exec } = require('child_process');
    exec(`powershell -Command "start ms-screenclip:"`);
    
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const image = clipboard.readImage();
      if (!image.isEmpty()) {
        clearInterval(interval);
        resolve(image.toDataURL());
      } else if (attempts > 60) { // 30 seconds timeout
        clearInterval(interval);
        resolve(null);
      }
    }, 500);
  });
});

ipcMain.handle('nvidia-tts-config', async (event, payload = {}) => {
  const apiKey = (payload.apiKey || '').trim();
  const functionId = (payload.functionId || '').trim();

  if (!apiKey) {
    throw new Error('Missing NVIDIA API key');
  }

  return fetchNvidiaTtsConfig(apiKey, functionId);
});

ipcMain.handle('nvidia-tts-synthesize', async (event, payload = {}) => {
  const apiKey = (payload.apiKey || '').trim();
  const functionId = (payload.functionId || '').trim();
  const text = (payload.text || '').trim();
  const voiceName = (payload.voiceName || '').trim();
  const languageCode = (payload.languageCode || 'en-US').trim();

  if (!apiKey) {
    throw new Error('Missing NVIDIA API key');
  }

  if (!text) {
    throw new Error('Missing TTS text');
  }

  const requestBytes = concatUint8Arrays([
    encodeStringField(1, text),
    encodeStringField(2, languageCode),
    encodeVarintField(3, 1),
    encodeVarintField(4, 44100),
    encodeStringField(5, voiceName)
  ]);

  const audioBytes = await synthesizeNvidiaTts(apiKey, functionId, requestBytes);
  return { audioBase64: Buffer.from(audioBytes).toString('base64') };
});

ipcMain.handle('execute-command', async (event, payload) => {
  const { exec } = require('child_process');
  
  let commandStr = '';
  let commandCwd = null;
  
  if (payload && typeof payload === 'object') {
    commandStr = payload.command || '';
    commandCwd = payload.cwd || null;
  } else {
    commandStr = payload || '';
  }
  
  if (!commandCwd) {
    const os = require('os');
    commandCwd = os.homedir();
  }

  return new Promise((resolve) => {
    // Append PowerShell instruction to output the current working directory path at the end of execution
    const fullCommand = `${commandStr}; Write-Output "__CWD__:$((Get-Location).Path)"`;
    
    exec(`powershell -NoProfile -Command "${fullCommand.replace(/"/g, '\\"')}"`, 
      { 
        timeout: 30000, 
        maxBuffer: 1024 * 1024,
        cwd: commandCwd
      },
      (error, stdout, stderr) => {
        let output = stdout || '';
        let errorOutput = stderr || '';
        
        // Parse current working directory from the output
        const cwdPattern = /__CWD__:(.*)$/m;
        const match = output.match(cwdPattern);
        let newCwd = commandCwd;
        
        if (match) {
          newCwd = match[1].trim();
          output = output.replace(cwdPattern, '').trim();
        }
        
        if (error && !output) {
          resolve({
            output: errorOutput || error.message,
            cwd: newCwd
          });
        } else {
          resolve({
            output: output + (errorOutput ? '\n' + errorOutput : ''),
            cwd: newCwd
          });
        }
      }
    );
  });
});
