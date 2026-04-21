// ── Preload guard ─────────────────────────────────────────────────────────────
if (!window.api) {
  document.body.innerHTML =
    '<div style="padding:2rem;color:#ef4444;font-family:monospace">' +
    '<b>Preload bridge failed.</b> Check preload.js path in main.js.' +
    '</div>';
  throw new Error("window.api is undefined");
}

// ── State ─────────────────────────────────────────────────────────────────────
var selectedDevice = null;
var sessionMeta    = null;
var sessionData    = null;
var aiResult       = null;
var timerHandle    = null;
var elapsedSec     = 0;
var allPackages    = [];

// ── Element refs — resolved AFTER DOM is ready ────────────────────────────────
var btnRefresh, btnStart, btnStop, btnGenerate, btnCopy, btnSave;
var btnLoadPkgs, pkgSearchWrap, pkgSearch, pkgSelect, pkgBadge;
var deviceSel, deviceInfo, statusEl, timerEl;
var actionList, logOut, outputEmpty, outputCards;

function initRefs() {
  btnRefresh   = document.getElementById("btn-refresh");
  btnStart     = document.getElementById("btn-start");
  btnStop      = document.getElementById("btn-stop");
  btnGenerate  = document.getElementById("btn-generate");
  btnCopy      = document.getElementById("btn-copy");
  btnSave      = document.getElementById("btn-save");
  btnLoadPkgs  = document.getElementById("btn-load-packages");
  pkgSearchWrap= document.getElementById("pkg-search-wrap");
  pkgSearch    = document.getElementById("pkg-search");
  pkgSelect    = document.getElementById("pkg-select");
  pkgBadge     = document.getElementById("pkg-selected");
  deviceSel    = document.getElementById("device-select");
  deviceInfo   = document.getElementById("device-info");
  statusEl     = document.getElementById("status");
  timerEl      = document.getElementById("timer");
  actionList   = document.getElementById("action-list");
  logOut       = document.getElementById("log-out");
  outputEmpty  = document.getElementById("output-empty");
  outputCards  = document.getElementById("output-cards");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function status(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function setButtons(opts) {
  var o = opts || {};
  if (btnStart)    btnStart.disabled    = !o.start;
  if (btnStop)     btnStop.disabled     = !o.stop;
  if (btnGenerate) btnGenerate.disabled = !o.generate;
  if (btnCopy)     btnCopy.disabled     = !o.copy;
  if (btnSave)     btnSave.disabled     = !o.save;
}

function startTimer() {
  elapsedSec = 0;
  timerEl.classList.remove("hidden");
  timerHandle = setInterval(function() {
    elapsedSec++;
    var m = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    var s = String(elapsedSec % 60).padStart(2, "0");
    timerEl.textContent = m + ":" + s;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerHandle);
  if (timerEl) timerEl.classList.add("hidden");
}

function addActionItem(a) {
  var li       = document.createElement("li");
  li.className = "type-" + a.type;

  var numSpan  = document.createElement("span");
  numSpan.className   = "step-num";
  numSpan.textContent = "Step " + a.step;

  var tsSpan   = document.createElement("span");
  tsSpan.className    = "step-ts";
  tsSpan.textContent  = new Date(a.ts).toLocaleTimeString();

  var typeSpan = document.createElement("span");
  typeSpan.className   = "step-type";
  typeSpan.textContent = a.type;

  var lblSpan  = document.createElement("span");
  lblSpan.textContent = a.label;

  li.appendChild(numSpan);
  li.appendChild(tsSpan);
  li.appendChild(typeSpan);
  li.appendChild(lblSpan);
  actionList.appendChild(li);
  li.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll(".tab").forEach(function(btn) {
    btn.addEventListener("click", function() {
      document.querySelectorAll(".tab").forEach(function(t) {
        t.classList.remove("active");
      });
      document.querySelectorAll(".tab-panel").forEach(function(p) {
        p.classList.add("hidden");
      });
      btn.classList.add("active");
      var panel = document.getElementById("tab-" + btn.dataset.tab);
      if (panel) panel.classList.remove("hidden");
    });
  });
}

// ── Plain text report ─────────────────────────────────────────────────────────
function buildPlainReport() {
  if (!aiResult) return "";
  var steps = Array.isArray(aiResult.steps)
    ? aiResult.steps.map(function(s, i) { return (i + 1) + ". " + s; }).join("\n")
    : "";
  var pkg = pkgBadge ? pkgBadge.textContent : "";
  return [
    "Bug ID: " + (aiResult.bugId || ""),
    "", "Title:",    aiResult.title    || "",
    "", "Summary:",  aiResult.summary  || "",
    "", "Steps:",    steps,
    "", "Expected:", aiResult.expected || "",
    "", "Actual:",   aiResult.actual   || "",
    "", "Error:",    aiResult.error    || "None",
    "", "Device:",   selectedDevice ? selectedDevice.brand + " " + selectedDevice.model : "",
    "", "OS:",       "Android " + (selectedDevice ? selectedDevice.osVer : ""),
    "", "Serial No:", selectedDevice ? (selectedDevice.serialNo || selectedDevice.serial) : "",
    "", "Firmware:", selectedDevice ? (selectedDevice.firmwareVer || "N/A") : "",
    "", "Package:",  pkg || "Not specified",
    "", "Screen Flow:", aiResult.screenFlow || "",
    "", "Relevant Logs:", aiResult.relevantLogs || "None",
    "", "Logs file:",    sessionMeta ? sessionMeta.logPath   : "attached",
    "", "Recording:",    sessionMeta ? sessionMeta.videoPath : "attached",
  ].join("\n");
}

// ── Package list ──────────────────────────────────────────────────────────────
function renderPackages(list) {
  pkgSelect.innerHTML = "";
  list.forEach(function(pkg) {
    var opt = document.createElement("option");
    opt.value       = pkg;
    opt.textContent = pkg;
    pkgSelect.appendChild(opt);
  });
}

function initPackageHandlers() {
  // Filter as user types
  pkgSearch.addEventListener("input", function() {
    var q = pkgSearch.value.toLowerCase().trim();
    renderPackages(q ? allPackages.filter(function(p) { return p.includes(q); }) : allPackages);
  });

  // Select package on click
  pkgSelect.addEventListener("change", function() {
    var pkg = pkgSelect.value;
    if (!pkg) return;
    window.api.setPackage(pkg).then(function() {
      pkgBadge.textContent = pkg;
      pkgBadge.classList.remove("hidden");
      status("Package selected: " + pkg);
    }).catch(function(e) {
      status("Error setting package: " + e.message);
    });
  });

  // Load packages button
  btnLoadPkgs.addEventListener("click", function() {
    if (!selectedDevice) { status("Select a device first."); return; }
    btnLoadPkgs.textContent = "Loading...";
    btnLoadPkgs.disabled    = true;
    window.api.listPackages(selectedDevice.serial).then(function(pkgs) {
      allPackages = pkgs || [];
      pkgSearchWrap.classList.remove("hidden");
      pkgSelect.classList.remove("hidden");
      renderPackages(allPackages);
      status(allPackages.length + " packages found — select your app");
    }).catch(function(e) {
      status("Error loading packages: " + e.message);
    }).finally(function() {
      btnLoadPkgs.textContent = "Reload packages";
      btnLoadPkgs.disabled    = false;
    });
  });
}

// ── Device refresh ────────────────────────────────────────────────────────────
function initDeviceHandlers() {
  btnRefresh.addEventListener("click", function() {
    status("Scanning for devices...");
    btnRefresh.disabled = true;
    window.api.listDevices().then(function(devices) {
      deviceSel.innerHTML = "";
      var placeholder     = document.createElement("option");
      placeholder.value   = "";
      placeholder.textContent = "\u2014 select device \u2014";
      deviceSel.appendChild(placeholder);

      if (!devices || !devices.length) {
        status("No devices found. Connect via ADB.");
        return;
      }
      devices.forEach(function(d) {
        var opt         = document.createElement("option");
        opt.value       = d.serial;
        opt.textContent = d.brand + " " + d.model + " (" + d.serial + ")";
        opt.dataset.info = JSON.stringify(d);
        deviceSel.appendChild(opt);
      });
      status(devices.length + " device(s) found");
    }).catch(function(e) {
      status("Error: " + e.message);
    }).finally(function() {
      btnRefresh.disabled = false;
    });
  });

  deviceSel.addEventListener("change", function() {
    var opt = deviceSel.selectedOptions[0];
    if (!opt || !opt.dataset.info) {
      selectedDevice = null;
      deviceInfo.classList.add("hidden");
      btnLoadPkgs.disabled = true;
      pkgBadge.classList.add("hidden");
      pkgSelect.classList.add("hidden");
      pkgSearchWrap.classList.add("hidden");
      setButtons();
      return;
    }

    selectedDevice = JSON.parse(opt.dataset.info);

    // Populate device info panel
    function diRow(label, value) {
      var row = document.createElement("div"); row.className = "device-info-row";
      var l = document.createElement("span"); l.className = "di-label"; l.textContent = label;
      var v = document.createElement("span"); v.className = "di-value"; v.textContent = value;
      row.appendChild(l); row.appendChild(v); return row;
    }
    deviceInfo.innerHTML = "";
    var nameEl = document.createElement("div"); nameEl.className = "device-info-name";
    nameEl.textContent = selectedDevice.brand + " " + selectedDevice.model;
    deviceInfo.appendChild(nameEl);
    deviceInfo.appendChild(diRow("Android", selectedDevice.osVer + " · API " + selectedDevice.sdk));
    deviceInfo.appendChild(diRow("Resolution", selectedDevice.resolution));
    deviceInfo.appendChild(diRow("S/N", selectedDevice.serialNo || selectedDevice.serial));
    deviceInfo.appendChild(diRow("Firmware", selectedDevice.firmwareVer || "N/A"));
    deviceInfo.classList.remove("hidden");
    // Reset package state
    allPackages = [];
    pkgBadge.classList.add("hidden");
    pkgSelect.classList.add("hidden");
    pkgSearchWrap.classList.add("hidden");
    pkgSearch.value = "";
    window.api.setPackage("").catch(function() {});
    btnLoadPkgs.disabled = false;

    setButtons({ start: true });
    status("Device ready \u2014 load packages to filter logs");
  });
}

// ── Recording ─────────────────────────────────────────────────────────────────
function initRecordingHandlers() {
  btnStart.addEventListener("click", function() {
    if (!selectedDevice) return;
    status("Starting session...");
    actionList.innerHTML = "";
    outputEmpty.classList.remove("hidden");
    outputCards.classList.add("hidden");
    setButtons({ stop: true });
    window.api.startRecording(selectedDevice.serial).then(function(meta) {
      sessionMeta = meta;
      startTimer();
      status("Recording \u00B7 watching screen");
    }).catch(function(e) {
      status("Error: " + e.message);
      setButtons({ start: true });
    });
  });

  btnStop.addEventListener("click", function() {
    status("Stopping session...");
    setButtons();
    stopTimer();
    window.api.stopRecording({
      serial:    selectedDevice.serial,
      videoPath: sessionMeta.videoPath,
      logPath:   sessionMeta.logPath,
    }).then(function(data) {
      sessionData = data;
      (sessionData.actions || []).forEach(function(a) { addActionItem(a); });
      logOut.textContent = (sessionData.logs || "").split("\n").slice(-200).join("\n");
      setButtons({ start: true, generate: true });
      status("Done \u00B7 " + (sessionData.actions || []).length + " steps recorded");
    }).catch(function(e) {
      status("Error: " + e.message);
      setButtons({ start: true });
    });
  });
}

// ── Generate bug report ───────────────────────────────────────────────────────
function initGenerateHandler() {
  btnGenerate.addEventListener("click", function() {
    if (!sessionData) return;
    status("Generating bug report...");
    setButtons({ start: true });
    window.api.generateAI({
      logs:            sessionData.logs,
      capturedActions: sessionData.actions,
      uiIssues:        sessionData.uiIssues,
      deviceInfo:      selectedDevice,
    }).then(function(result) {
      aiResult = result;

      document.getElementById("out-bug-id").textContent   = aiResult.bugId    || "";
      document.getElementById("out-title").textContent    = aiResult.title    || "";
      document.getElementById("out-summary").textContent  = aiResult.summary  || "";
      document.getElementById("out-expected").textContent = aiResult.expected || "";
      document.getElementById("out-actual").textContent   = aiResult.actual   || "";
      document.getElementById("out-error").textContent    = aiResult.error    || "None";
      document.getElementById("out-device").textContent   = selectedDevice.brand + " " + selectedDevice.model;
      document.getElementById("out-os").textContent       = "Android " + selectedDevice.osVer;
      document.getElementById("out-serial").textContent   = selectedDevice.serialNo || selectedDevice.serial;
      document.getElementById("out-firmware").textContent = selectedDevice.firmwareVer || "N/A";
      document.getElementById("out-flow").textContent     = aiResult.screenFlow || "\u2014";

      // Package
      var pkgEl = document.getElementById("out-package");
      if (pkgEl) pkgEl.textContent = pkgBadge.textContent || "Not specified";

      // Steps
      var ol = document.getElementById("out-steps");
      ol.innerHTML = "";
      (aiResult.steps || []).forEach(function(s) {
        var li = document.createElement("li");
        li.textContent = s;
        ol.appendChild(li);
      });

      // Logs
      var logsEl = document.getElementById("out-relevant-logs");
      if (logsEl) logsEl.textContent = aiResult.relevantLogs || "No errors in logs";

      // Attachments
      document.getElementById("out-video-path").textContent = sessionMeta.videoPath || "\u2014";
      document.getElementById("out-log-path").textContent   = sessionMeta.logPath   || "\u2014";

      var btnOpenVideo = document.getElementById("btn-open-video");
      var btnOpenLog   = document.getElementById("btn-open-log");
      btnOpenVideo.disabled = !sessionMeta.videoPath;
      btnOpenLog.disabled   = !sessionMeta.logPath;
      btnOpenVideo.onclick  = function() { window.api.openPath(sessionMeta.videoPath); };
      btnOpenLog.onclick    = function() { window.api.openPath(sessionMeta.logPath); };

      // Copy-all button
      var btnCopyAll = document.getElementById("btn-copy-all");
      if (btnCopyAll) {
        btnCopyAll.onclick = function() {
          window.api.copyReport(buildPlainReport()).then(function() {
            btnCopyAll.textContent = "\u2713 Copied";
            setTimeout(function() { btnCopyAll.textContent = "\u2398 Copy full report"; }, 1500);
          });
        };
      }

      outputEmpty.classList.add("hidden");
      outputCards.classList.remove("hidden");

      var reportTab = document.querySelector('[data-tab="report"]');
      if (reportTab) reportTab.click();

      setButtons({ start: true, generate: true, copy: true, save: true });
      status("Report ready");

    }).catch(function(e) {
      status("Error: " + e.message);
      setButtons({ start: true, generate: true });
    });
  });
}

// ── Copy / Save ───────────────────────────────────────────────────────────────
function initCopySave() {
  btnCopy.addEventListener("click", function() {
    window.api.copyReport(buildPlainReport()).then(function() {
      btnCopy.textContent = "\u2713 Copied!";
      setTimeout(function() { btnCopy.textContent = "\u2398 Copy report"; }, 1500);
    });
  });

  btnSave.addEventListener("click", function() {
    window.api.saveReport({ text: buildPlainReport(), ts: sessionMeta.ts }).then(function(p) {
      status("Saved: " + p);
    });
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function init() {
  initRefs();
  initTabs();
  initDeviceHandlers();
  initPackageHandlers();
  initRecordingHandlers();
  initGenerateHandler();
  initCopySave();
  setButtons();
  status("Click 'Refresh devices' to begin");
}

// Run after DOM is fully parsed
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}