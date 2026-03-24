/**
 * Assembles the final plain-text bug report from AI output + session metadata.
 */
function build({ ai, deviceInfo, videoPath, logPath, ts }) {
  const d = deviceInfo;
  const date = new Date(ts).toLocaleString();

  const steps = Array.isArray(ai.steps)
    ? ai.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
    : ai.steps;

  return `=====================================
  AI BUG RECORDER — Bug Report
  Generated: ${date}
=====================================

TITLE:
  ${ai.title}

SUMMARY:
  ${ai.summary}

STEPS TO REPRODUCE:
${steps}

EXPECTED RESULT:
  ${ai.expected}

ACTUAL RESULT:
  ${ai.actual}

ERROR SUMMARY:
  ${ai.errorSummary}

ROOT CAUSE (AI hypothesis):
  ${ai.rootCause}

DEVICE INFO:
  Brand / Model : ${d.brand} ${d.model}
  Android       : ${d.osVer} (API ${d.sdk})
  Resolution    : ${d.resolution}
  Serial        : ${d.serial}

ATTACHMENTS:
  Video : ${videoPath || "N/A"}
  Logs  : ${logPath  || "N/A"}

=====================================`;
}

module.exports = { build };