const { app, BrowserWindow, ipcMain, shell, Tray, Menu, clipboard } = require('electron');
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
