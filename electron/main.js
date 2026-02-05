import { app, BrowserWindow } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import isDev from 'electron-is-dev';

// Construct __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let oscBridgeProcess;
let bridgeProcess;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false, // For easier IPC if needed, or adjust for security
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startBackgroundServices() {
  const serverPath = isDev
    ? path.join(__dirname, '../server/osc-bridge.js')
    : path.join(__dirname, '../server/osc-bridge.js'); // Adjust for production packing if needed

  const bridgePath = isDev
    ? path.join(__dirname, '../bridge/index.js')
    : path.join(__dirname, '../bridge/index.js'); // Adjust for production packing if needed

  console.log('Starting OSC Bridge from:', serverPath);
  oscBridgeProcess = fork(serverPath, [], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } 
  });

  console.log('Starting Bridge from:', bridgePath);
  bridgeProcess = fork(bridgePath, [], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  });
}

function stopBackgroundServices() {
  if (oscBridgeProcess) {
    console.log('Killing OSC Bridge...');
    oscBridgeProcess.kill();
  }
  if (bridgeProcess) {
    console.log('Killing Bridge...');
    bridgeProcess.kill();
  }
}

app.whenReady().then(() => {
  startBackgroundServices();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBackgroundServices();
});
