const { exec, spawn } = require("child_process");
const fs = require("fs");
const util = require("util");
const execAsync = util.promisify(exec);

let logcatProc = null;
let logBuffer = [];

// ── Device discovery ──────────────────────────────────────────────────────────

async function listDevices() {
  const { stdout } = await execAsync("adb devices -l");
  const lines = stdout.trim().split("\n").slice(1).filter(l => l.includes("device "));

  const devices = await Promise.all(
    lines.map(async (line) => {
      const serial = line.split(/\s+/)[0];
      return getDeviceInfo(serial);
    })
  );
  return devices.filter(Boolean);
}

async function selectDevice(serial) {
  return getDeviceInfo(serial);
}

async function getDeviceInfo(serial) {
  try {
    const prop = async (key) => {
      const { stdout } = await execAsync(`adb -s ${serial} shell getprop ${key}`);
      return stdout.trim();
    };
    const [model, brand, osVer, sdk, res] = await Promise.all([
      prop("ro.product.model"),
      prop("ro.product.brand"),
      prop("ro.build.version.release"),
      prop("ro.build.version.sdk"),
      execAsync(`adb -s ${serial} shell wm size`).then(r => r.stdout.replace("Physical size:", "").trim()),
    ]);
    return { serial, model, brand, osVer, sdk, resolution: res };
  } catch {
    return null;
  }
}

// ── Screen recording ──────────────────────────────────────────────────────────

let recordProc = null;
const DEVICE_VIDEO = "/sdcard/aibug_record.mp4";

async function startRecording(serial, localPath) {
  // Remove any stale file
  await execAsync(`adb -s ${serial} shell rm -f ${DEVICE_VIDEO}`).catch(() => {});

  recordProc = spawn("adb", ["-s", serial, "shell", "screenrecord",
    "--bit-rate", "4000000", "--size", "1080x1920", DEVICE_VIDEO]);

  recordProc.stderr.on("data", d => console.error("[screenrecord]", d.toString()));
  return { started: true, localPath };
}

async function stopRecording(serial, localPath) {
  if (!recordProc) return;

  // SIGINT stops screenrecord gracefully so it finalises the mp4
  recordProc.kill("SIGINT");
  recordProc = null;

  // Wait for device to flush
  await new Promise(r => setTimeout(r, 2000));

  // Pull to local
  await execAsync(`adb -s ${serial} pull ${DEVICE_VIDEO} "${localPath}"`);
  await execAsync(`adb -s ${serial} shell rm -f ${DEVICE_VIDEO}`).catch(() => {});
  return localPath;
}

// ── Logcat ────────────────────────────────────────────────────────────────────

async function startLogcat(serial, logPath) {
  logBuffer = [];
  // Clear existing log buffer on device
  await execAsync(`adb -s ${serial} logcat -c`).catch(() => {});

  logcatProc = spawn("adb", ["-s", serial, "logcat", "-v", "time", "*:W"]);

  logcatProc.stdout.on("data", data => {
    const text = data.toString();
    logBuffer.push(text);
    // Live write
    fs.appendFileSync(logPath, text);
  });

  logcatProc.stderr.on("data", d => console.error("[logcat]", d.toString()));
}

async function stopLogcat() {
  if (logcatProc) {
    logcatProc.kill();
    logcatProc = null;
  }
  return logBuffer.join("");
}

module.exports = { listDevices, selectDevice, getDeviceInfo, startRecording, stopRecording, startLogcat, stopLogcat };