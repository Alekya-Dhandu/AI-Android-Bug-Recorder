const { contextBridge, ipcRenderer, shell } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  listDevices: () => ipcRenderer.invoke("adb:list-devices"),
  selectDevice: (serial) => ipcRenderer.invoke("adb:select-device", serial),
  startRecording: (serial) => ipcRenderer.invoke("recording:start", serial),
  stopRecording: (payload) => ipcRenderer.invoke("recording:stop", payload),
  generateReport: (payload) => ipcRenderer.invoke("ai:generate", payload),
  buildReport: (payload) => ipcRenderer.invoke("report:build", payload),
  copyReport: (text) => ipcRenderer.invoke("report:copy", text),
  saveReport: (payload) => ipcRenderer.invoke("report:save", payload),
  createJiraItem: (payload) => ipcRenderer.invoke("jira:create", payload),
  openPath: (targetPath) => shell.openPath(targetPath),
  showItemInFolder: (targetPath) => shell.showItemInFolder(targetPath),
});