const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generate full bug report fields from raw session data.
 * Returns structured JSON: { title, summary, steps, expected, actual, rootCause, errorSummary }
 */
async function generateReport({ logs, actions, deviceInfo }) {
  const stepsText = actions
    .map(a => `  Step ${a.step} [${a.ts}]: ${a.description}`)
    .join("\n");

  // Trim logs to last 300 lines to stay within context
  const logLines = logs.split("\n");
  const trimmedLogs = logLines.slice(-300).join("\n");

  const prompt = `You are a senior Android QA engineer analysing a bug recording session.

## Device
Model: ${deviceInfo.brand} ${deviceInfo.model}
Android: ${deviceInfo.osVer} (API ${deviceInfo.sdk})
Resolution: ${deviceInfo.resolution}

## Recorded User Actions
${stepsText || "No actions detected"}

## ADB Logcat (last 300 lines)
\`\`\`
${trimmedLogs || "No logs captured"}
\`\`\`

Analyse the session and respond ONLY with a JSON object (no markdown fences, no preamble) with these keys:
{
  "title": "Short, descriptive bug title (max 80 chars)",
  "summary": "2–3 sentence executive summary of what went wrong",
  "steps": ["Step 1: ...", "Step 2: ...", ...],
  "expected": "What the app should have done",
  "actual": "What the app actually did",
  "errorSummary": "Key errors / exceptions from the logs (max 3 bullet points as a single string)",
  "rootCause": "Most likely root cause based on logs and actions (1–2 sentences)"
}`;

  const msg = await client.messages.create({
    model: "claude-opus-4-20250514",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = msg.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Fallback: extract JSON from response if there's surrounding text
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("AI response was not valid JSON: " + raw.slice(0, 200));
  }
}

module.exports = { generateReport };