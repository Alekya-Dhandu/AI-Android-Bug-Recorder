require("dotenv").config();
const { app, BrowserWindow, ipcMain, clipboard, shell } = require("electron");
const path = require("path");
const fs = require("fs");

const adb     = require("./src/adb");
const actions = require("./src/actions");
const ai      = require("./src/ai");
const report  = require("./src/report");

const OUTPUT_DIR = path.join(app.getPath("userData"), "recordings");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle("adb:list-packages", async (_, serial) => {
  return adb.listPackages(serial);
});

ipcMain.handle("adb:set-package", async (_, pkg) => {
  adb.setSelectedPackage(pkg);
  return true;
});

ipcMain.handle("adb:get-package", async () => {
  return adb.getSelectedPackage();
});

ipcMain.handle("adb:list-devices", async () => {
  return adb.listDevices();
});

ipcMain.handle("adb:select-device", async (_, serial) => {
  return adb.selectDevice(serial);
});

ipcMain.handle("recording:start", async (_, serial) => {
  const ts = Date.now();
  const videoPath = path.join(OUTPUT_DIR, `recording_${ts}.mp4`);
  const logPath   = path.join(OUTPUT_DIR, `logcat_${ts}.txt`);
  actions.reset();
  await adb.startRecording(serial, videoPath);
  await adb.startLogcat(serial, logPath);
  actions.startPolling(serial);
  return { videoPath, logPath, ts };
});

ipcMain.handle("recording:stop", async (_, { serial, videoPath, logPath }) => {
  actions.stopPolling();
  await adb.stopRecording(serial, videoPath);
  const logs = await adb.stopLogcat();
  const capturedActions = actions.getActions();
  const capturedUiIssues = actions.getUiIssues();
  return { logs, actions: capturedActions, uiIssues: capturedUiIssues };
});

ipcMain.handle("ai:generate", async (_, { logs, capturedActions, uiIssues, deviceInfo }) => {
  return ai.generateReport({ logs, actions: capturedActions, uiIssues, deviceInfo });
});

ipcMain.handle("report:build", async (_, data) => {
  return report.build(data);
});

ipcMain.handle("report:copy", async (_, text) => {
  clipboard.writeText(text);
  return true;
});

ipcMain.handle("report:save", async (_, { text, ts }) => {
  const p = path.join(OUTPUT_DIR, `bug_report_${ts}.txt`);
  fs.writeFileSync(p, text, "utf8");
  return p;
});

ipcMain.handle("shell:open", async (_, filePath) => {
  shell.showItemInFolder(filePath);
});