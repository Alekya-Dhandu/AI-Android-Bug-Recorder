const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  listDevices:    ()  => ipcRenderer.invoke("adb:list-devices"),
  selectDevice:   (s) => ipcRenderer.invoke("adb:select-device", s),
  listPackages:   (s) => ipcRenderer.invoke("adb:list-packages", s),
  setPackage:     (p) => ipcRenderer.invoke("adb:set-package", p),
  getPackage:     ()  => ipcRenderer.invoke("adb:get-package"),
  startRecording: (s) => ipcRenderer.invoke("recording:start", s),
  stopRecording:  (d) => ipcRenderer.invoke("recording:stop", d),
  generateAI:     (d) => ipcRenderer.invoke("ai:generate", d),
  buildReport:    (d) => ipcRenderer.invoke("report:build", d),
  copyReport:     (t) => ipcRenderer.invoke("report:copy", t),
  saveReport:     (d) => ipcRenderer.invoke("report:save", d),
  openPath:       (p) => ipcRenderer.invoke("shell:open", p),
});