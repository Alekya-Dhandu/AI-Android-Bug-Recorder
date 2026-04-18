/**
 * ULTRA UI Detection Engine v4
 * Follows all 16 rules from spec.
 * Produces steps like a manual QA tester:
 *   Open "Live Channels screen"
 *   Navigate to "Sony TV"
 *   Click on "Sony TV"
 *   Open "Live Channel Details screen"
 *   Navigate to "Go Live"
 *   Click on "Go Live"
 */

const { exec, spawn } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

// ── State ─────────────────────────────────────────────────────────────────────
let actionLog        = [];
let uiIssues         = [];
let stepCounter      = 0;
let geteventProc     = null;
let logcatProc       = null;
let activityPoll     = null;
let mediaPoll        = null;
let currentSerial    = null;

let lastScreenName   = "";
let lastDecorRaw     = "";
let lastFragmentKey  = "";   // tracks fragment changes
let lastActivityKey  = "";
let lastLabel        = "";   // dedupe consecutive identical steps
let lastPlayback     = "";
let lastPosition     = -1;

let prevHierarchy    = null;
let currHierarchy    = null;
let dumpInFlight     = false;

// ── Keyboard / IME state detection ───────────────────────────────────────────
let imeVisible       = false;
let imeCheckTimer    = null;
let typingBuffer     = "";      // accumulates what the user typed
let typingField      = "";      // label of the field being typed into
let typingTimer      = null;    // flush typing buffer after idle

async function checkImeState(serial) {
  try {
    const { stdout } = await execAsync(
      "adb -s " + serial + " shell dumpsys input_method | grep -i mInputShown",
      { timeout: 2000 }
    );
    imeVisible = /mInputShown=true/i.test(stdout);
  } catch { imeVisible = false; }
}

// Flush accumulated typing as a single step
function flushTypingBuffer(screen) {
  if (!typingBuffer.trim()) return;
  const field = typingField ? " in \"" + typingField + "\"" : "";
  addStep({
    type:  "input",
    screen,
    label: "Type \"" + typingBuffer.trim() + "\"" + field,
    raw:   "keyboard input: " + typingBuffer,
  });
  typingBuffer = "";
  typingField  = "";
}

// Called when a key event comes in while IME is visible
function handleImeKey(keyCode, screen, snap) {
  clearTimeout(typingTimer);

  // OK / ENTER while IME = confirm search / submit
  if (keyCode === "KEY_ENTER" || keyCode === "KEY_SELECT" || keyCode === "KEY_DPAD_CENTER") {
    flushTypingBuffer(screen);
    addStep({ type:"select", screen, label:"Click OK on keyboard", raw:"IME_OK" });
    return;
  }
  // BACK while IME = dismiss keyboard
  if (keyCode === "KEY_BACK") {
    flushTypingBuffer(screen);
    addStep({ type:"back", screen, label:"Dismiss keyboard", raw:"IME_BACK" });
    return;
  }
  // DPAD while IME = navigating keyboard keys — capture the focused key text
  if (keyCode.startsWith("KEY_DPAD") || ["KEY_UP","KEY_DOWN","KEY_LEFT","KEY_RIGHT"].includes(keyCode)) {
    if (snap) {
      const focused = getFocusedNode(snap);
      const keyText = focused ? (cleanText(focused.text) || cleanText(focused.desc)) : null;
      if (keyText && keyText.length <= 3) {
        // It's a keyboard key — accumulate into typing buffer
        typingBuffer += keyText;
        typingTimer = setTimeout(function() { flushTypingBuffer(screen); }, 2000);
      }
    }
    return; // never output raw DPAD while keyboard is open
  }
}
const KEY_INTENT = {
  KEY_UP:"dpad_up",   KEY_DOWN:"dpad_down",
  KEY_LEFT:"dpad_left", KEY_RIGHT:"dpad_right",
  KEY_DPAD_UP:"dpad_up", KEY_DPAD_DOWN:"dpad_down",
  KEY_DPAD_LEFT:"dpad_left", KEY_DPAD_RIGHT:"dpad_right",
  KEY_SELECT:"select", KEY_ENTER:"select", KEY_DPAD_CENTER:"select",
  KEY_BACK:"back",   KEY_HOME:"home",
  KEY_SEARCH:"search", KEY_MENU:"menu",
  KEY_PLAYPAUSE:"player", KEY_PLAY:"player", KEY_PAUSE:"player",
  KEY_STOP:"player",  KEY_FASTFORWARD:"player", KEY_REWIND:"player",
  KEY_LIVE:"player",  KEY_NEXTSONG:"player",   KEY_PREVIOUSSONG:"player",
  KEY_RECORD:"player",
  KEY_CHANNELUP:"channel", KEY_CHANNELDOWN:"channel",
  KEY_VOLUMEUP:"volume",   KEY_VOLUMEDOWN:"volume",  KEY_MUTE:"volume",
  KEY_RED:"color", KEY_GREEN:"color", KEY_YELLOW:"color", KEY_BLUE:"color",
  KEY_INFO:"info",   KEY_CAPTIONS:"captions",
};

const IGNORE_KEYS = new Set([
  "KEY_LEFTSHIFT","KEY_RIGHTSHIFT","KEY_LEFTCTRL","KEY_RIGHTCTRL",
  "KEY_LEFTALT","KEY_RIGHTALT","KEY_LEFTMETA","KEY_RIGHTMETA",
  "KEY_CAPSLOCK","KEY_NUMLOCK","KEY_SCROLLLOCK",
]);

// ── Key intent map ────────────────────────────────────────────────────────────
const BAD_ID_RE = [
  /^iv\d*/i, /^tv\d*/i, /^btn\d*$/i, /^view\d*/i, /^layout\d*/i,
  /^container\d*/i, /^card\d*/i, /^item\d*$/i, /^root\d*/i,
  /^id\d*$/i, /^v\d+$/i, /^c\d+$/i, /^img\d*/i, /^image\d*$/i,
  /^frame\d*/i, /^group\d*/i, /^row\d*$/i, /^col\d*$/i,
  /^placeholder/i, /^stub/i, /^divider/i, /^spacer/i,
  /^recycler/i, /^scroll/i, /^pager/i, /^coordinator/i,
];

function isBadId(str) {
  if (!str) return true;
  const id = str.includes("/") ? str.split("/").pop() : str;
  return BAD_ID_RE.some(p => p.test(id));
}

// Convert resource-id to human label: btnGoLive → Go Live
function resourceToLabel(rid) {
  if (!rid || isBadId(rid)) return null;
  let id = rid.includes("/") ? rid.split("/").pop() : rid;
  // Strip common prefixes: btn, iv, tv, ic, img, lbl, txt, menu
  id = id.replace(/^(btn|iv|tv|ic|img|lbl|txt|menu|btn_|ic_|img_)/i, "");
  // snake_case → words
  id = id.replace(/_/g, " ");
  // CamelCase → words
  id = id.replace(/([a-z])([A-Z])/g, "$1 $2");
  id = id.trim();
  if (!id || id.length < 2) return null;
  return toTitleCase(id);
}

// ── BAD resource-id patterns — never use as labels ───────────────────────────
const SCREEN_OVERRIDES = {
  mainactivity:"Home", launcheractivity:"Home",
  homeactivity:"Home", homefragment:"Home",
  playeractivity:"Player", playerfragment:"Player",
  liveplayeractivity:"Live Player", liveplayerfragment:"Live Player",
  livechannelaactivity:"Live Channels", livechannelsfragment:"Live Channels",
  livechanneldetailsactivity:"Live Channel Details",
  livechanneldetailsfragment:"Live Channel Details",
  detailsactivity:"Details", detailsfragment:"Details",
  settingsactivity:"Settings", settingsfragment:"Settings",
  searchactivity:"Search", searchfragment:"Search",
  loginactivity:"Login", loginfragment:"Login",
  reportactivity:"Report", reportfragment:"Report",
  epgactivity:"TV Guide", epgfragment:"TV Guide", guidefragment:"TV Guide",
  profileactivity:"Profile", profilefragment:"Profile",
  onboardingactivity:"Onboarding", splashactivity:"Splash",
  offlineplansactivity:"Offline Plans", offlineplansfragment:"Offline Plans",
  subscriptionactivity:"Subscription", subscriptionfragment:"Subscription",
};

function toScreenName(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/(fragment|activity)$/, "");
  // Check full name override
  const fullKey = raw.toLowerCase();
  if (SCREEN_OVERRIDES[fullKey]) return SCREEN_OVERRIDES[fullKey];
  // Partial match
  for (const [k, v] of Object.entries(SCREEN_OVERRIDES)) {
    if (key === k || key.includes(k)) return v;
  }
  // Generic CamelCase split
  const words = raw
    .replace(/(Fragment|Activity)$/, "")
    .replace(/([A-Z][a-z]+)/g, " $1")
    .replace(/([A-Z]{2,})/g, " $1")
    .trim().split(/\s+/).filter(Boolean);
  return words.join(" ");
}

function toTitleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ── System / lifecycle fragment patterns to IGNORE ───────────────────────────
const IGNORE_FRAGMENT_PATTERNS = [
  /report_fragment_tag/i,
  /androidx\.lifecycle/i,
  /LifecycleDispatcher/i,
  /android:fragment:\d+/i,
  /SupportRequestManagerFragment/i,
  /FragmentManagerImpl/i,
  /NavHostFragment/i,           // navigation host — not a real screen
  /BackStackRecord/i,
  /androidx\.navigation/i,
  /^ReportFragment$/i,          // bare "ReportFragment" with no screen context
  /CrashlyticsFrag/i,
  /FirebaseAnalytics/i,
  /WorkManagerInit/i,
];

function isSystemFragment(name) {
  if (!name) return true;
  return IGNORE_FRAGMENT_PATTERNS.some(p => p.test(name));
}

// ── RULE 1 — Fragment detection (visible, added, not hidden, not system) ──────
function extractVisibleFragment(dumpsysOut) {
  const candidates = [];
  const lines = dumpsysOut.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fragMatch = line.match(/\b([\w.]+Fragment[\w]*)\{/);
    if (fragMatch) {
      const name = fragMatch[1];

      // ── Immediately discard system / lifecycle fragments ─────────────────
      if (!isSystemFragment(name)) {
        const block    = lines.slice(i, i + 15).join("\n");
        const isAdded  = /mAdded=true/i.test(block);
        const isHidden = /mHidden=true/i.test(block);
        const isVisible = /mUserVisibleHint=true/i.test(block);
        if (isAdded && !isHidden) {
          candidates.push({ name, visible: isVisible, idx: i });
        }
      }
    }
    i++;
  }

  // Fallback patterns — also filtered
  const mParentMatches = [...dumpsysOut.matchAll(/mParent=([\w.]+Fragment[\w]*)/g)];
  mParentMatches.forEach(m => {
    if (!isSystemFragment(m[1])) candidates.push({ name: m[1], visible: true, idx: 998 });
  });

  const addedSection = dumpsysOut.match(/(?:Added|Active) Fragments:([\s\S]*?)(?:\n\s*\n|\nLocal|\nBack Stack)/);
  if (addedSection) {
    const addedMatches = [...addedSection[1].matchAll(/#\d+:\s*([\w.]+Fragment[\w]*)/g)];
    addedMatches.forEach(m => {
      if (!isSystemFragment(m[1])) candidates.push({ name: m[1], visible: true, idx: 999 });
    });
  }

  if (!candidates.length) return null;

  // Prefer explicitly visible, then last in list (most foreground)
  const visible = candidates.filter(c => c.visible);
  const pool    = visible.length ? visible : candidates;
  return pool[pool.length - 1].name;
}

// ── RULE 2 — DecorView fallback ───────────────────────────────────────────────
function extractDecorActivity(decorOut) {
  const m = decorOut.match(/DecorView@[a-f0-9]+\[([A-Za-z0-9_.]+)\]/);
  if (!m) return null;
  const raw = m[1];
  return raw.includes(".") ? raw.split(".").pop() : raw;
}

// ── Combined screen info fetch ────────────────────────────────────────────────
async function getActivityInfo(serial) {
  const result = {
    pkg:"", activity: lastActivityKey, fragment:"",
    decorActivity:"", screenName:"",
  };

  const [actOut, winOut] = await Promise.all([
    execAsync("adb -s " + serial + " shell dumpsys activity top", { timeout: 4000 })
      .then(r => r.stdout).catch(() => ""),
    execAsync("adb -s " + serial + " shell dumpsys window | grep -i DecorView", { timeout: 3000 })
      .then(r => r.stdout).catch(() => ""),
  ]);

  // Fragment (Rule 1)
  result.fragment = extractVisibleFragment(actOut) || "";

  // Activity
  const pkgMatch = actOut.match(/ACTIVITY\s+([\w.]+)\/([\w.]+)/);
  if (pkgMatch) {
    result.pkg      = pkgMatch[1];
    result.activity = pkgMatch[2].split(".").pop();
  }

  // DecorView (Rule 2)
  result.decorActivity = extractDecorActivity(winOut) || "";

  return result;
}

// ── Resolve screen name using priority chain ──────────────────────────────────
function resolveScreenName(info, hierarchy) {
  // 1. Visible Fragment
  if (info.fragment) {
    const name = toScreenName(info.fragment);
    if (name) return name + " screen";
  }
  // 2. DecorView Activity
  if (info.decorActivity) {
    const name = toScreenName(info.decorActivity);
    if (name) return name + " screen";
  }
  // 3. Toolbar title from UI hierarchy
  if (hierarchy) {
    const t = resolveToolbarTitle(hierarchy.nodes);
    if (t) return t + " screen";
  }
  // 4. Top TextView from UI hierarchy
  if (hierarchy) {
    const topNodes = hierarchy.nodes
      .filter(n => n.bounds && n.bounds.y1 < 280 && cleanText(n.text))
      .sort((a,b) => a.bounds.y1 - b.bounds.y1);
    if (topNodes.length) return cleanText(topNodes[0].text) + " screen";
  }
  // 5. Activity
  if (info.activity) {
    const name = toScreenName(info.activity);
    if (name) return name + " screen";
  }
  return lastScreenName || "App";
}

function currentScreen() { return lastScreenName || "the app"; }

// ── Public ────────────────────────────────────────────────────────────────────
function reset() {
  actionLog = []; uiIssues = []; stepCounter = 0;
  lastScreenName = ""; lastDecorRaw = ""; lastFragmentKey = "";
  lastActivityKey = ""; lastLabel = ""; lastPlayback = ""; lastPosition = -1;
  prevHierarchy = null; currHierarchy = null;
  imeVisible = false; typingBuffer = ""; typingField = "";
  processingKey = false;
  clearTimeout(typingTimer); clearTimeout(imeCheckTimer);
}

function addStep({ type, screen, label, raw }) {
  if (label === lastLabel && type !== "navigate_screen" && type !== "ui_issue") return;
  lastLabel = label;
  stepCounter++;
  const entry = { step: stepCounter, ts: new Date().toISOString(), type, screen, label, raw };
  actionLog.push(entry);
  console.log("[step " + stepCounter + "] " + label);
  return entry;
}

function recordUiIssue(desc) {
  if (uiIssues[uiIssues.length - 1] === desc) return;
  uiIssues.push(desc);
  addStep({ type:"ui_issue", screen:currentScreen(), label:"[UI Issue] " + desc, raw:desc });
}

// ── UI Hierarchy snapshot ─────────────────────────────────────────────────────
async function takeSnapshot(serial) {
  if (dumpInFlight) return currHierarchy;
  dumpInFlight = true;
  const t0 = Date.now();
  try {
    await execAsync("adb -s " + serial + " shell uiautomator dump /sdcard/ui.xml", { timeout: 6000 });
    const { stdout } = await execAsync("adb -s " + serial + " shell cat /sdcard/ui.xml");
    const ms = Date.now() - t0;
    if (ms > 1500) recordUiIssue("UI thread slow — dump took " + ms + "ms");
    prevHierarchy = currHierarchy;
    currHierarchy = parseHierarchy(stdout);
    currHierarchy.dumpMs = ms;
    return currHierarchy;
  } catch { return currHierarchy; }
  finally { dumpInFlight = false; }
}

function parseHierarchy(xml) {
  const nodes = [];
  const regex = /<node([^>]+)\/>/g;
  let m, idx = 0;
  while ((m = regex.exec(xml)) !== null) {
    const a = m[1];
    nodes.push({
      idx,
      text:      xattr(a, "text"),
      desc:      xattr(a, "content-desc"),
      hint:      xattr(a, "hint"),
      cls:       xattr(a, "class"),
      resource:  xattr(a, "resource-id"),
      bounds:    parseBounds(xattr(a, "bounds")),
      focused:   a.includes('focused="true"'),
      selected:  a.includes('selected="true"'),
      enabled:   a.includes('enabled="true"'),
      clickable: a.includes('clickable="true"'),
      scrollable:a.includes('scrollable="true"'),
      checked:   a.includes('checked="true"'),
    });
    idx++;
  }
  return { nodes, xml };
}

// ── RULE 4 — Label resolution (10-level chain) ────────────────────────────────
function resolveLabel(h, node) {
  if (!h || !node) return null;
  const nodes = h.nodes;

  // 1. text
  if (cleanText(node.text)) return cleanText(node.text);
  // 2. content-desc
  if (cleanText(node.desc)) return cleanText(node.desc);
  // 3. hint
  if (cleanText(node.hint)) return cleanText(node.hint);
  // 4. resource-id (only if meaningful, converted to human label)
  const ridLabel = resourceToLabel(node.resource);
  if (ridLabel) return ridLabel;

  // 5–7. Spatial relatives
  const { parents, siblings, children } = getSpatialRelatives(nodes, node);

  // 5. Parent text (smallest parent first = most direct)
  for (const p of parents) {
    const l = firstText(p);
    if (l) return l;
  }
  // 6. Sibling text
  for (const s of siblings) {
    const l = firstText(s);
    if (l) return l;
  }
  // 7. Child text
  for (const c of children) {
    const l = firstText(c);
    if (l) return l;
  }

  // 8. RecyclerView item (RULE 5) — find item container, collect all text
  const rvLabel = resolveRecyclerItem(nodes, node);
  if (rvLabel) return rvLabel;

  // 9. Toolbar title
  const toolbar = resolveToolbarTitle(nodes);
  if (toolbar) return toolbar;

  // 10. Fragment name fallback (from screen)
  return null;
}

function cleanText(t) {
  if (!t) return null;
  const s = t.trim();
  if (!s || s.length < 1) return null;
  if (/^[\d\s.]+$/.test(s)) return null;  // numbers only
  if (isBadId(s)) return null;
  return s;
}

function firstText(n) {
  return cleanText(n.text) || cleanText(n.desc) || cleanText(n.hint) || null;
}

function getSpatialRelatives(nodes, target) {
  if (!target.bounds) return { parents:[], siblings:[], children:[] };
  const tb = target.bounds;
  const parents = [], siblings = [], children = [];

  for (const n of nodes) {
    if (n.idx === target.idx || !n.bounds) continue;
    const nb = n.bounds;
    if (nb.x1 <= tb.x1 && nb.y1 <= tb.y1 && nb.x2 >= tb.x2 && nb.y2 >= tb.y2) {
      parents.push(n);
    } else if (tb.x1 <= nb.x1 && tb.y1 <= nb.y1 && tb.x2 >= nb.x2 && tb.y2 >= nb.y2) {
      children.push(n);
    } else {
      const yOverlap = Math.min(tb.y2, nb.y2) - Math.max(tb.y1, nb.y1);
      const yMin     = Math.min(tb.y2 - tb.y1, nb.y2 - nb.y1);
      if (yOverlap > yMin * 0.5 && Math.abs(nb.x1 - tb.x2) < 300) {
        siblings.push(n);
      }
    }
  }
  parents.sort((a,b) => (a.bounds.w * a.bounds.h) - (b.bounds.w * b.bounds.h));
  return { parents, siblings, children };
}

// RULE 5 — RecyclerView item text
function resolveRecyclerItem(nodes, target) {
  if (!target.bounds) return null;
  const tb = target.bounds;
  const isRV = n => {
    const cls = (n.cls||"").toLowerCase();
    return cls.includes("recyclerview") || cls.includes("listview") ||
           cls.includes("gridview")     || cls.includes("horizontalgridview");
  };
  const rv = nodes.find(n => n.bounds && isRV(n) &&
    n.bounds.x1 <= tb.x1 && n.bounds.y1 <= tb.y1 &&
    n.bounds.x2 >= tb.x2 && n.bounds.y2 >= tb.y2);
  if (!rv) return null;

  const isLayout = n => {
    const cls = (n.cls||"").toLowerCase();
    return cls.includes("layout") || cls.includes("cardview") || cls.includes("viewgroup");
  };
  const containers = nodes.filter(n =>
    n.bounds && n.idx !== rv.idx && isLayout(n) &&
    n.bounds.x1 <= tb.x1 && n.bounds.y1 <= tb.y1 &&
    n.bounds.x2 >= tb.x2 && n.bounds.y2 >= tb.y2 &&
    (n.bounds.w < rv.bounds.w || n.bounds.h < rv.bounds.h)
  );
  if (!containers.length) return null;
  containers.sort((a,b) => (a.bounds.w*a.bounds.h) - (b.bounds.w*b.bounds.h));
  const item = containers[0];

  const texts = nodes
    .filter(n => n.bounds &&
      n.bounds.x1 >= item.bounds.x1 && n.bounds.y1 >= item.bounds.y1 &&
      n.bounds.x2 <= item.bounds.x2 && n.bounds.y2 <= item.bounds.y2)
    .map(n => cleanText(n.text) || cleanText(n.desc))
    .filter(Boolean);
  return texts.length ? texts[texts.length - 1] : null;
}

// Toolbar title = meaningful text near top of screen
function resolveToolbarTitle(nodes) {
  const top = nodes
    .filter(n => n.bounds && n.bounds.y1 < 300 && cleanText(n.text))
    .sort((a,b) => a.bounds.y1 - b.bounds.y1);
  return top.length ? cleanText(top[0].text) : null;
}

// ── RULE 6 — Dialog / popup detection ────────────────────────────────────────
function detectDialog(h) {
  if (!h) return null;
  const dlgNode = h.nodes.find(n => {
    const cls = (n.cls||"").toLowerCase();
    const rid = (n.resource||"").toLowerCase();
    return cls.includes("dialog") || cls.includes("alertdialog") ||
           cls.includes("bottomsheet") || rid.includes("dialog") ||
           rid.includes("popup") || rid.includes("alert");
  });
  if (!dlgNode) return null;
  // Find the dialog title/message
  const msg = h.nodes.find(n =>
    n.text && n.text.length > 2 && n.bounds && dlgNode.bounds &&
    n.bounds.y1 >= dlgNode.bounds.y1 && n.bounds.y2 <= dlgNode.bounds.y2
  );
  return { text: msg ? msg.text : "dialog" };
}

// ── RULE 8/9 — Toast / error detection ───────────────────────────────────────
function detectErrorNode(h) {
  if (!h) return null;
  return h.nodes.find(n => {
    const t = (n.text||"").toLowerCase();
    return t.includes("error") || t.includes("failed") ||
           t.includes("not available") || t.includes("something went wrong") ||
           t.includes("unable") || t.includes("try again");
  });
}

// ── Get focused node ──────────────────────────────────────────────────────────
function getFocusedNode(h) {
  if (!h) return null;
  return h.nodes.find(n => n.focused)
      || h.nodes.find(n => n.selected)
      || h.nodes.find(n => n.clickable && firstText(n));
}

// ── Diff hierarchies ──────────────────────────────────────────────────────────
function diffHierarchies(prev, curr) {
  if (!prev || !curr) return;
  for (const pn of prev.nodes) {
    const cn = curr.nodes.find(n => nodeKey(n) === nodeKey(pn));
    if (!cn || !pn.bounds || !cn.bounds) continue;
    const dx = Math.abs(cn.bounds.x1 - pn.bounds.x1);
    const dy = Math.abs(cn.bounds.y1 - pn.bounds.y1);
    if (dx > 40 || dy > 40) {
      const l = firstText(pn);
      if (l) recordUiIssue("Layout shift on \"" + l + "\" (" + dx + "px, " + dy + "px)");
    }
    if (pn.enabled && !cn.enabled) {
      const l = firstText(pn);
      if (l) recordUiIssue("\"" + l + "\" became unresponsive");
    }
  }
  const prevKeys = new Set(prev.nodes.map(nodeKey));
  const frozen   = curr.nodes.every(n => prevKeys.has(nodeKey(n)));
  if (frozen && curr.dumpMs > 800) recordUiIssue("UI freeze — no update after interaction");
}

function nodeKey(n) {
  return (n.cls||"") + "|" + (n.resource||"") + "|" + (n.text||"") + "|" + (n.desc||"");
}

// ── Core: process key event ───────────────────────────────────────────────────
let processingKey = false;  // prevent overlapping processKey calls

async function processKey(serial, keyCode) {
  // Debounce — skip if previous key is still processing
  if (processingKey) return;
  processingKey = true;

  try {
    await sleep(220);

    // ── Check IME (keyboard) state first ──────────────────────────────────
    await checkImeState(serial);

    const [info, snap] = await Promise.all([
      getActivityInfo(serial),
      takeSnapshot(serial),
    ]);

    const prevScreen    = lastScreenName;
    const newScreen     = resolveScreenName(info, snap);
    const fragChanged   = info.fragment      && info.fragment      !== lastFragmentKey;
    const actChanged    = info.activity      && info.activity      !== lastActivityKey;
    const decorChanged  = info.decorActivity && info.decorActivity !== lastDecorRaw;
    const screenChanged = prevScreen !== newScreen && !!prevScreen;

    if (info.fragment)      lastFragmentKey = info.fragment;
    if (info.activity)      lastActivityKey = info.activity;
    if (info.decorActivity) lastDecorRaw    = info.decorActivity;
    lastScreenName = newScreen;

    const screen = currentScreen();
    const intent = KEY_INTENT[keyCode] || "other";

    diffHierarchies(prevHierarchy, snap);

    // ── RULE: If IME visible, route to keyboard handler ───────────────────
    if (imeVisible) {
      handleImeKey(keyCode, screen, snap);
      return;
    }

    // ── Screen change ──────────────────────────────────────────────────────
    if (screenChanged) {
      // Flush any pending typing before announcing screen change
      flushTypingBuffer(prevScreen);
      lastLabel = "";
      addStep({
        type:  "navigate_screen",
        screen: prevScreen,
        label: "Open \"" + screen + "\"",
        raw:   prevScreen + " -> " + screen,
      });
    }

    // ── Dialog detection ───────────────────────────────────────────────────
    const dialog = detectDialog(snap);
    if (dialog && !screenChanged) {
      addStep({
        type:  "dialog", screen,
        label: "Open \"" + dialog.text + " dialog\"",
        raw:   "dialog: " + dialog.text,
      });
    }

    // ── Error node ─────────────────────────────────────────────────────────
    const errNode = detectErrorNode(snap);
    if (errNode) {
      recordUiIssue("Error shown: \"" + errNode.text + "\"");
    }

    // ── Resolve focused element ────────────────────────────────────────────
    const focused = getFocusedNode(snap);
    const label   = focused ? resolveLabel(snap, focused) : null;

    // ── BACK ───────────────────────────────────────────────────────────────
    if (intent === "back") {
      addStep({ type:"back", screen, label:"Go back to \"" + screen + "\"", raw:"BACK" }); return;
    }
    if (intent === "home") {
      addStep({ type:"home", screen, label:"Press Home", raw:"HOME" }); return;
    }
    if (intent === "search") {
      addStep({ type:"search", screen, label:"Open Search", raw:"SEARCH" }); return;
    }
    if (intent === "volume") {
      const d = keyCode==="KEY_VOLUMEUP"?"up":keyCode==="KEY_MUTE"?"mute":"down";
      addStep({ type:"volume", screen, label:"Press Volume " + d, raw:keyCode }); return;
    }
    if (intent === "channel") {
      addStep({ type:"channel", screen,
        label:"Press Channel " + (keyCode==="KEY_CHANNELUP"?"Up":"Down"), raw:keyCode }); return;
    }
    if (intent === "color") {
      addStep({ type:"rcu", screen,
        label:"Press \"" + keyCode.replace("KEY_","") + "\" button", raw:keyCode }); return;
    }

    // ── Player keys ────────────────────────────────────────────────────────
    if (intent === "player") {
      const pos = await getMediaPosition(serial);
      const playerLabels = {
        KEY_PLAY:"Press Play", KEY_PAUSE:"Press Pause",
        KEY_PLAYPAUSE:"Press Play/Pause", KEY_STOP:"Press Stop",
        KEY_FASTFORWARD:"Fast forward",   KEY_REWIND:"Rewind",
        KEY_LIVE:"Click on \"Go Live\"",  KEY_NEXTSONG:"Skip to next",
        KEY_PREVIOUSSONG:"Go to previous", KEY_RECORD:"Press Record",
      };
      const act = label
        ? "Click on \"" + label + "\""
        : (playerLabels[keyCode] || "Player action");
      addStep({ type:"player", screen, label: act + (pos ? " at " + pos : ""), raw:keyCode });
      return;
    }

    // ── SELECT / OK ────────────────────────────────────────────────────────
    if (intent === "select") {
      // If focused element is an EditText → user is activating the field
      const cls = focused ? (focused.cls||"").toLowerCase() : "";
      if (cls.includes("edittext") || cls.includes("textinput")) {
        typingField = label || "search field";
        addStep({ type:"select", screen,
          label:"Click on \"" + (label || "search field") + "\"", raw:"OK field" });
      } else {
        addStep({ type:"select", screen,
          label: label ? "Click on \"" + label + "\"" : "Press OK",
          raw:"OK " + (label||"") });
      }
      return;
    }

    // ── DPAD ───────────────────────────────────────────────────────────────
    if (intent.startsWith("dpad")) {
      const dirVerbs = {
        dpad_down:"Navigate to", dpad_up:"Navigate up to",
        dpad_right:"Navigate right to", dpad_left:"Navigate left to",
      };
      const verb = dirVerbs[intent] || "Navigate to";
      if (label) {
        addStep({ type:"focus", screen,
          label: verb + " \"" + label + "\"",
          raw: intent + " " + label });
      } else {
        const ctx = resolveToolbarTitle(snap ? snap.nodes : []);
        addStep({ type:"focus", screen,
          label: ctx ? verb + " item in \"" + ctx + "\"" : "Navigate in " + screen,
          raw: intent });
      }
      return;
    }

  } finally {
    processingKey = false;
  }
}

// ── Touch ─────────────────────────────────────────────────────────────────────
async function processTouch(serial) {
  await sleep(150);
  const [info, snap] = await Promise.all([
    getActivityInfo(serial),
    takeSnapshot(serial),
  ]);
  const newScreen = resolveScreenName(info, snap);
  if (info.fragment)      lastFragmentKey = info.fragment;
  if (info.activity)      lastActivityKey = info.activity;
  if (info.decorActivity) lastDecorRaw    = info.decorActivity;
  lastScreenName = newScreen;

  const screen  = currentScreen();
  const focused = getFocusedNode(snap);
  const label   = focused ? resolveLabel(snap, focused) : null;
  diffHierarchies(prevHierarchy, snap);

  addStep({
    type:  "tap", screen,
    label: label ? "Click on \"" + label + "\"" : "Tap on screen",
    raw:   "tap " + (label||""),
  });
}

// ── getevent ──────────────────────────────────────────────────────────────────
function startGetevent(serial) {
  geteventProc = spawn("adb", ["-s", serial, "shell", "getevent", "-lt"]);
  let touchDown = false, touchTimer = null;
  geteventProc.stdout.on("data", function(data) {
    for (const line of data.toString().split("\n")) {
      if (line.includes("BTN_TOUCH") && line.includes("DOWN")) touchDown = true;
      if (line.includes("BTN_TOUCH") && line.includes("UP") && touchDown) {
        touchDown = false;
        clearTimeout(touchTimer);
        touchTimer = setTimeout(function() { processTouch(serial); }, 300);
      }
      if (line.includes("EV_KEY") && line.includes("DOWN")) {
        const m = line.match(/\b(KEY_[A-Z0-9_]+)\b/);
        if (!m || IGNORE_KEYS.has(m[1])) continue;
        processKey(serial, m[1]).catch(function(e) { console.error("[processKey]", e.message); });
      }
    }
  });
  geteventProc.stderr.on("data", function() {});
}

// ── logcat watcher ────────────────────────────────────────────────────────────
function startLogcatWatch(serial) {
  logcatProc = spawn("adb", ["-s", serial, "shell", "logcat", "-v", "time"]);
  let buf = "";
  logcatProc.stdout.on("data", function(data) {
    buf += data.toString();
    const lines = buf.split("\n"); buf = lines.pop();
    for (const line of lines) {
      const l = line.toLowerCase();
      const screen = currentScreen();
      // RULE 8 — Toast / Snackbar
      if (l.includes("toast") || l.includes("snackbar")) {
        const msg = line.match(/(?:text|message|show)[=:\s]+["']?([^"'\n]{4,80})/i);
        if (msg) addStep({ type:"toast", screen, label:"Error message displayed \"" + msg[1].trim() + "\"", raw:line.trim() });
      }
      // ANR
      if (l.includes("anr in") || l.includes("application not responding")) {
        recordUiIssue("ANR detected");
      }
      // Crash
      if (l.includes("fatal exception") && !l.includes("test")) {
        recordUiIssue("App crashed");
      }
      // RULE 9 — Playback / API errors
      if (l.includes("playbackexception") || (l.includes("exoplayer") && l.includes("error"))) {
        recordUiIssue("Playback error");
        addStep({ type:"error", screen, label:"Error shown \"Playback failed\"", raw:line.trim() });
      }
      if (l.includes("http") && /\s[45]\d{2}\s/.test(l)) {
        const code = l.match(/\s([45]\d{2})\s/);
        if (code) recordUiIssue("HTTP " + code[1] + " error");
      }
    }
  });
  logcatProc.stderr.on("data", function() {});
}

// ── Activity poll ─────────────────────────────────────────────────────────────
function startActivityPoll(serial) {
  activityPoll = setInterval(async function() {
    try {
      const info = await getActivityInfo(serial);
      const fc = info.fragment     && info.fragment     !== lastFragmentKey;
      const ac = info.activity     && info.activity     !== lastActivityKey;
      const dc = info.decorActivity && info.decorActivity !== lastDecorRaw;
      if (!fc && !ac && !dc) return;

      const prev      = lastScreenName;
      const newScreen = resolveScreenName(info, currHierarchy);
      if (info.fragment)      lastFragmentKey = info.fragment;
      if (info.activity)      lastActivityKey = info.activity;
      if (info.decorActivity) lastDecorRaw    = info.decorActivity;
      lastScreenName = newScreen;

      if (prev !== newScreen && prev) {
        lastLabel = "";
        addStep({ type:"navigate_screen", screen:prev, label:"Open \"" + newScreen + "\"", raw:prev + "->" + newScreen });
      }
    } catch {}
  }, 2000);
}

// ── Media session poll ────────────────────────────────────────────────────────
function startMediaPoll(serial) {
  mediaPoll = setInterval(async function() {
    try {
      const { stdout } = await execAsync("adb -s " + serial + " shell dumpsys media_session");
      const stateM = stdout.match(/state=(\w+)/i);
      const posM   = stdout.match(/position=(\d+)/i);
      const state  = stateM ? stateM[1] : null;
      const posMs  = posM   ? parseInt(posM[1]) : null;
      const screen = currentScreen();
      if (state && state !== lastPlayback) {
        lastPlayback = state;
        const map = {
          STATE_PLAYING:"Video starts playing", STATE_PAUSED:"Video is paused",
          STATE_BUFFERING:"Video is buffering", STATE_STOPPED:"Video stopped",
          STATE_ERROR:"Playback error occurred",
        };
        const lbl = map[state];
        if (lbl) {
          addStep({ type:"player", screen, label:lbl, raw:"state=" + state });
          if (state === "STATE_BUFFERING") recordUiIssue("Player stuck in buffering");
          if (state === "STATE_ERROR")     recordUiIssue("Player error state");
        }
      }
      if (posMs !== null && lastPosition !== -1) {
        const delta = posMs - lastPosition;
        if (!(delta >= 0 && delta < 7000)) {
          addStep({ type:"player", screen,
            label:"Seek " + (delta > 0 ? "forward" : "backward") + " to " + msToTime(posMs),
            raw:"seek delta=" + delta });
        }
      }
      lastPosition = posMs !== null ? posMs : lastPosition;
    } catch {}
  }, 4000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getMediaPosition(serial) {
  try {
    const { stdout } = await execAsync("adb -s " + serial + " shell dumpsys media_session");
    const m = stdout.match(/position=(\d+)/i);
    return m ? msToTime(parseInt(m[1])) : null;
  } catch { return null; }
}
function msToTime(ms) {
  const s=Math.floor(ms/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
  return h>0 ? h+":"+String(m).padStart(2,"0")+":"+String(sec).padStart(2,"0")
             : m+":"+String(sec).padStart(2,"0");
}
function xattr(str, name) {
  const m = str.match(new RegExp(name + '="([^"]{0,200})"'));
  return m ? m[1].trim() : null;
}
function parseBounds(b) {
  if (!b) return null;
  const m = b.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
  return m ? {x1:+m[1],y1:+m[2],x2:+m[3],y2:+m[4],w:+m[3]-+m[1],h:+m[4]-+m[2]} : null;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Public API ────────────────────────────────────────────────────────────────
function startPolling(serial) {
  currentSerial = serial;
  startGetevent(serial);
  startLogcatWatch(serial);
  startActivityPoll(serial);
  startMediaPoll(serial);
}
function stopPolling() {
  [geteventProc, logcatProc].forEach(p => { if (p) p.kill(); });
  [activityPoll, mediaPoll].forEach(t => { if (t) clearInterval(t); });
  geteventProc = logcatProc = activityPoll = mediaPoll = null;
}
function getActions()  { return [...actionLog]; }
function getUiIssues() { return [...uiIssues]; }

module.exports = { reset, startPolling, stopPolling, getActions, getUiIssues };