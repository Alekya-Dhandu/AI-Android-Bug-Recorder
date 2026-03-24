const api = window.electronAPI;

const state = {
  devices: [],
  selectedDevice: null,
  isRecording: false,
  session: null,
  ai: null,
  reportText: "",
  timerId: null,
};

const elements = {};

function $(id) {
  return document.getElementById(id);
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "var(--red)" : "var(--text2)";
}

function setHidden(element, hidden) {
  element.classList.toggle("hidden", hidden);
}

function setDisabled(element, disabled) {
  element.disabled = disabled;
}

function formatTimer(startTs) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startTs) / 1000));
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function startTimer(startTs) {
  stopTimer();
  setHidden(elements.timer, false);
  elements.timer.textContent = formatTimer(startTs);
  state.timerId = window.setInterval(() => {
    elements.timer.textContent = formatTimer(startTs);
  }, 1000);
}

function stopTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
  elements.timer.textContent = "00:00";
  setHidden(elements.timer, true);
}

function escapeText(value) {
  return String(value ?? "").trim();
}

function renderDeviceOptions() {
  const currentSerial = state.selectedDevice?.serial ?? "";
  elements.deviceSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.devices.length ? "Select a device" : "— no device —";
  elements.deviceSelect.appendChild(placeholder);

  state.devices.forEach((device) => {
    const option = document.createElement("option");
    option.value = device.serial;
    option.textContent = `${device.brand} ${device.model} (${device.serial})`;
    if (device.serial === currentSerial) {
      option.selected = true;
    }
    elements.deviceSelect.appendChild(option);
  });
}

function renderDeviceInfo() {
  if (!state.selectedDevice) {
    elements.deviceInfo.textContent = "";
    setHidden(elements.deviceInfo, true);
    return;
  }

  const { brand, model, osVer, sdk, resolution, serial } = state.selectedDevice;
  elements.deviceInfo.innerHTML = [
    `Brand / Model: ${escapeText(brand)} ${escapeText(model)}`,
    `Android: ${escapeText(osVer)} (API ${escapeText(sdk)})`,
    `Resolution: ${escapeText(resolution)}`,
    `Serial: ${escapeText(serial)}`,
  ].join("<br>");
  setHidden(elements.deviceInfo, false);
}

function renderActions(actions = [], placeholderText = "No actions recorded yet.") {
  elements.actionList.innerHTML = "";

  if (!actions.length) {
    const item = document.createElement("li");
    item.textContent = placeholderText;
    elements.actionList.appendChild(item);
    return;
  }

  actions.forEach((action) => {
    const item = document.createElement("li");

    const step = document.createElement("span");
    step.className = "step-num";
    step.textContent = `Step ${action.step}`;

    const ts = document.createElement("span");
    ts.className = "step-ts";
    ts.textContent = new Date(action.ts).toLocaleTimeString();

    const text = document.createElement("span");
    text.textContent = action.description;

    item.append(step, ts, text);
    elements.actionList.appendChild(item);
  });
}

function renderOutput() {
  const hasOutput = Boolean(state.ai);
  setHidden(elements.outputEmpty, hasOutput);
  setHidden(elements.outputCards, !hasOutput);

  if (!hasOutput) {
    elements.outTitle.textContent = "";
    elements.outSteps.innerHTML = "";
    elements.outLogs.textContent = "";
    elements.outVideoPath.textContent = "—";
    setDisabled(elements.btnOpenVideo, true);
    setDisabled(elements.btnOpenLog, true);
    return;
  }

  elements.outTitle.textContent = state.ai.title || "Untitled bug";
  elements.outSteps.innerHTML = "";

  const steps = Array.isArray(state.ai.steps) ? state.ai.steps : [];
  steps.forEach((stepText) => {
    const item = document.createElement("li");
    item.textContent = stepText;
    elements.outSteps.appendChild(item);
  });

  elements.outLogs.textContent = state.session?.logs || "No logs captured.";
  elements.outVideoPath.textContent = state.session?.videoPath || "—";
  setDisabled(elements.btnOpenVideo, !state.session?.videoPath);
  setDisabled(elements.btnOpenLog, !state.session?.logPath);
}

function updateControls() {
  const hasDevice = Boolean(state.selectedDevice);
  const hasSession = Boolean(state.session);
  const hasReport = Boolean(state.reportText);

  setDisabled(elements.btnStart, !hasDevice || state.isRecording);
  setDisabled(elements.btnStop, !state.isRecording || !hasDevice);
  setDisabled(elements.btnGenerate, !hasSession || state.isRecording);
  setDisabled(elements.btnCopy, !hasReport);
  setDisabled(elements.btnSave, !hasReport);
}

function selectTab(tabName) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== `tab-${tabName}`);
  });
}

async function refreshDevices() {
  setStatus("Refreshing devices...");
  setDisabled(elements.btnRefresh, true);

  try {
    state.devices = await api.listDevices();
    const selectedSerial = state.selectedDevice?.serial;
    state.selectedDevice = state.devices.find((device) => device.serial === selectedSerial) || null;
    renderDeviceOptions();
    renderDeviceInfo();
    updateControls();
    setStatus(state.devices.length ? `Found ${state.devices.length} device(s).` : "No devices detected.");
  } catch (error) {
    setStatus(error.message || "Failed to refresh devices.", true);
  } finally {
    setDisabled(elements.btnRefresh, false);
  }
}

async function handleDeviceChange(event) {
  const serial = event.target.value;
  state.selectedDevice = null;
  renderDeviceInfo();
  updateControls();

  if (!serial) {
    setStatus("Ready");
    return;
  }

  setStatus("Loading device details...");

  try {
    state.selectedDevice = await api.selectDevice(serial);
    renderDeviceInfo();
    updateControls();
    setStatus(`Selected ${state.selectedDevice.brand} ${state.selectedDevice.model}.`);
  } catch (error) {
    event.target.value = "";
    setStatus(error.message || "Failed to load device details.", true);
  }
}

async function startRecording() {
  if (!state.selectedDevice || state.isRecording) {
    return;
  }

  setStatus("Starting recording...");
  setDisabled(elements.btnStart, true);

  try {
    const session = await api.startRecording(state.selectedDevice.serial);
    state.isRecording = true;
    state.session = {
      ...session,
      serial: state.selectedDevice.serial,
      logs: "",
      actions: [],
    };
    state.ai = null;
    state.reportText = "";
    renderActions([], "Recording in progress. Stop the session to collect detected actions.");
    renderOutput();
    startTimer(session.ts);
    updateControls();
    setStatus("Recording started.");
    selectTab("actions");
  } catch (error) {
    setStatus(error.message || "Failed to start recording.", true);
    updateControls();
  }
}

async function stopRecording() {
  if (!state.session || !state.isRecording) {
    return;
  }

  setStatus("Stopping recording...");
  setDisabled(elements.btnStop, true);

  try {
    const result = await api.stopRecording({
      serial: state.session.serial,
      videoPath: state.session.videoPath,
      logPath: state.session.logPath,
    });

    state.isRecording = false;
    state.session = {
      ...state.session,
      logs: result.logs || "",
      actions: Array.isArray(result.actions) ? result.actions : [],
    };

    stopTimer();
    renderActions(state.session.actions, "No actions were detected in this session.");
    elements.logOut.textContent = state.session.logs || "No logs captured.";
    renderOutput();
    updateControls();
    setStatus("Recording stopped. You can generate the bug report now.");
  } catch (error) {
    setStatus(error.message || "Failed to stop recording.", true);
    setDisabled(elements.btnStop, false);
  }
}

async function generateBugInfo() {
  if (!state.session || !state.selectedDevice) {
    return;
  }

  setStatus("Generating bug info...");
  setDisabled(elements.btnGenerate, true);

  try {
    const ai = await api.generateReport({
      logs: state.session.logs,
      capturedActions: state.session.actions,
      deviceInfo: state.selectedDevice,
    });

    state.ai = ai;
    state.reportText = await api.buildReport({
      ai,
      deviceInfo: state.selectedDevice,
      videoPath: state.session.videoPath,
      logPath: state.session.logPath,
      ts: state.session.ts,
    });

    renderOutput();
    updateControls();
    setStatus("Bug info generated.");
    selectTab("output");
  } catch (error) {
    setStatus(error.message || "Failed to generate bug info.", true);
    setDisabled(elements.btnGenerate, false);
  }
}

async function copyFullReport() {
  if (!state.reportText) {
    return;
  }

  try {
    await api.copyReport(state.reportText);
    setStatus("Bug report copied to clipboard.");
  } catch (error) {
    setStatus(error.message || "Failed to copy bug report.", true);
  }
}

async function saveFullReport() {
  if (!state.reportText || !state.session) {
    return;
  }

  try {
    const savedPath = await api.saveReport({ text: state.reportText, ts: state.session.ts });
    setStatus(`Report saved to ${savedPath}.`);
  } catch (error) {
    setStatus(error.message || "Failed to save bug report.", true);
  }
}

async function copySection(targetId) {
  let text = "";

  if (targetId === "out-steps") {
    text = Array.from(elements.outSteps.querySelectorAll("li"))
      .map((item, index) => `${index + 1}. ${item.textContent}`)
      .join("\n");
  } else {
    const target = $(targetId);
    text = target?.textContent?.trim() || "";
  }

  if (!text) {
    setStatus("Nothing to copy.", true);
    return;
  }

  try {
    await api.copyReport(text);
    setStatus("Copied to clipboard.");
  } catch (error) {
    setStatus(error.message || "Failed to copy content.", true);
  }
}

function bindCopyButtons() {
  document.querySelectorAll(".copy-btn[data-target]").forEach((button) => {
    button.addEventListener("click", () => copySection(button.dataset.target));
  });
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => selectTab(tab.dataset.tab));
  });
}

function wireElements() {
  elements.btnRefresh = $("btn-refresh");
  elements.deviceSelect = $("device-select");
  elements.deviceInfo = $("device-info");
  elements.btnStart = $("btn-start");
  elements.btnStop = $("btn-stop");
  elements.timer = $("timer");
  elements.btnGenerate = $("btn-generate");
  elements.btnCopy = $("btn-copy");
  elements.btnSave = $("btn-save");
  elements.status = $("status");
  elements.actionList = $("action-list");
  elements.outputEmpty = $("output-empty");
  elements.outputCards = $("output-cards");
  elements.outTitle = $("out-title");
  elements.outSteps = $("out-steps");
  elements.outVideoPath = $("out-video-path");
  elements.btnOpenVideo = $("btn-open-video");
  elements.outLogs = $("out-logs");
  elements.btnOpenLog = $("btn-open-log");
  elements.logOut = $("log-out");
}

function bindEvents() {
  elements.btnRefresh.addEventListener("click", refreshDevices);
  elements.deviceSelect.addEventListener("change", handleDeviceChange);
  elements.btnStart.addEventListener("click", startRecording);
  elements.btnStop.addEventListener("click", stopRecording);
  elements.btnGenerate.addEventListener("click", generateBugInfo);
  elements.btnCopy.addEventListener("click", copyFullReport);
  elements.btnSave.addEventListener("click", saveFullReport);
  elements.btnOpenVideo.addEventListener("click", () => {
    if (state.session?.videoPath) {
      api.showItemInFolder(state.session.videoPath);
    }
  });
  elements.btnOpenLog.addEventListener("click", () => {
    if (state.session?.logPath) {
      api.openPath(state.session.logPath);
    }
  });

  bindCopyButtons();
  bindTabs();
}

function init() {
  wireElements();
  bindEvents();
  renderDeviceOptions();
  renderDeviceInfo();
  renderActions();
  renderOutput();
  updateControls();
  selectTab("actions");
  refreshDevices();
}

window.addEventListener("DOMContentLoaded", init);