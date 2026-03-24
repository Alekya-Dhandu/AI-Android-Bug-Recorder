/**
 * User action detection via multiple ADB strategies:
 *  1. getevent  — raw kernel touch/key events (always available)
 *  2. dumpsys activity — foreground activity / focused window changes
 *  3. UIAutomator dump — focused element label when interaction detected
 */

const { exec, spawn } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

let serial = null;
let actionLog = [];
let geteventProc = null;
let pollInterval = null;
let lastActivity = "";
let stepCounter = 0;
let pendingTouch = false;

function reset() {
  actionLog = [];
  stepCounter = 0;
  lastActivity = "";
  pendingTouch = false;
}

function addStep(description) {
  stepCounter++;
  actionLog.push({
    step: stepCounter,
    ts: new Date().toISOString(),
    description,
  });
  console.log(`[action] Step ${stepCounter}: ${description}`);
}

// ── getevent: raw touch/key stream ───────────────────────────────────────────

function startGetevent(deviceSerial) {
  geteventProc = spawn("adb", ["-s", deviceSerial, "shell", "getevent", "-lt"]);

  let touchDown = false;
  let keyBuffer = "";

  geteventProc.stdout.on("data", data => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      // Touch down → mark a tap pending
      if (line.includes("BTN_TOUCH") && line.includes("DOWN")) {
        touchDown = true;
        pendingTouch = true;
      }
      // Touch up → resolve tap with UIAutomator label
      if (line.includes("BTN_TOUCH") && line.includes("UP") && touchDown) {
        touchDown = false;
        resolveTouch(deviceSerial);
      }
      // Key press
      if (line.includes("KEY_") && line.includes("DOWN")) {
        const match = line.match(/KEY_(\w+)/);
        if (match) {
          const key = match[1];
          if (key === "ENTER") { addStep("Press Enter / Submit"); keyBuffer = ""; }
          else if (key === "DEL" || key === "BACKSPACE") { /* skip */ }
          else if (key === "BACK") addStep("Press Back button");
          else if (key === "HOME") addStep("Press Home button");
          else { keyBuffer += key; }
        }
      }
    }
  });
}

// Debounce rapid touch-ups — take the last one in 300ms window
let resolveTimer = null;
function resolveTouch(deviceSerial) {
  clearTimeout(resolveTimer);
  resolveTimer = setTimeout(() => doResolveTouch(deviceSerial), 300);
}

async function doResolveTouch(deviceSerial) {
  try {
    // UIAutomator dump to find focused/clicked element
    await execAsync(`adb -s ${deviceSerial} shell uiautomator dump /sdcard/ui.xml`);
    const { stdout: xml } = await execAsync(`adb -s ${deviceSerial} shell cat /sdcard/ui.xml`);

    // Find focused element
    const focusedMatch = xml.match(/focused="true"[^>]*?(?:text|content-desc)="([^"]+)"/);
    const clickableMatch = xml.match(/clickable="true"[^>]*?(?:text|content-desc)="([^"]+)"/);
    const textMatch = xml.match(/(?:text|content-desc)="([^"]{2,40})"/);

    const label =
      (focusedMatch && focusedMatch[1]) ||
      (clickableMatch && clickableMatch[1]) ||
      (textMatch && textMatch[1]) ||
      "element";

    if (label && label !== "element") {
      addStep(`Tap "${label}"`);
    } else {
      addStep("Tap on screen");
    }
  } catch {
    addStep("Tap on screen");
  }
  pendingTouch = false;
}

// ── Activity polling: detect screen/activity changes ─────────────────────────

function startActivityPoll(deviceSerial) {
  pollInterval = setInterval(async () => {
    try {
      const { stdout } = await execAsync(
        `adb -s ${deviceSerial} shell dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity" | head -1`
      );
      const match = stdout.match(/\{[^}]+\s+([\w.]+\/[\w.]+)/);
      if (match && match[1] !== lastActivity) {
        lastActivity = match[1];
        const screenName = lastActivity.split("/").pop().replace(/Activity$/, "");
        addStep(`Navigate to "${screenName}" screen`);
      }
    } catch { /* adb hiccup — ignore */ }
  }, 1500);
}

// ── Public API ────────────────────────────────────────────────────────────────

function startPolling(deviceSerial) {
  serial = deviceSerial;
  startGetevent(deviceSerial);
  startActivityPoll(deviceSerial);
}

function stopPolling() {
  if (geteventProc) { geteventProc.kill(); geteventProc = null; }
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function getActions() {
  return [...actionLog];
}

module.exports = { reset, startPolling, stopPolling, getActions };