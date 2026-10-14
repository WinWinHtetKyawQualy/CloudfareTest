// ===== Natural Disaster Alarm =====
const FEED_URL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson";
const REFRESH_MS = 60000;
const MAX_ALERT_AGE_MS = 60 * 60 * 1000; // only alarm for quakes in the last hour

// ---- Elements ----
const $ = (id) => document.getElementById(id);
const el = {
  minMag: $("minMag"), minMagValue: $("minMagValue"),
  feedMag: $("feedMag"), feedMagValue: $("feedMagValue"),
  soundOn: $("soundOn"), notifyOn: $("notifyOn"), autoRefresh: $("autoRefresh"),
  refreshBtn: $("refreshBtn"),
  list: $("quakeList"), lastUpdated: $("lastUpdated"),
  statusDot: $("statusDot"), statusText: $("statusText"),
  alarm: $("alarm"), alarmIcon: $("alarmIcon"), alarmTitle: $("alarmTitle"),
  alarmMessage: $("alarmMessage"), alarmTips: $("alarmTips"),
  muteBtn: $("muteBtn"), dismissBtn: $("dismissBtn"),
};

// ---- Drill definitions ----
const DISASTERS = {
  earthquake: {
    icon: "🌍", title: "EARTHQUAKE ALERT",
    message: "Strong shaking detected in your area.",
    tips: ["DROP to your hands and knees", "Take COVER under a sturdy table", "HOLD ON until shaking stops", "Stay away from windows and heavy furniture"],
  },
  tsunami: {
    icon: "🌊", title: "TSUNAMI WARNING",
    message: "A tsunami may reach the coast shortly.",
    tips: ["Move to high ground immediately", "Go at least 30 m (100 ft) above sea level or 3 km inland", "Do not wait for official confirmation", "Stay away until officials say it is safe"],
  },
  flood: {
    icon: "🌧️", title: "FLOOD WARNING",
    message: "Rising water levels. Flooding is expected.",
    tips: ["Move to higher ground or upper floors", "Never walk or drive through floodwater", "Switch off electricity if safe to do so", "Take your emergency kit and documents"],
  },
  cyclone: {
    icon: "🌀", title: "CYCLONE WARNING",
    message: "Dangerous winds and storm surge approaching.",
    tips: ["Shelter in a strong building away from windows", "Secure or bring in loose outdoor objects", "Keep a battery radio and flashlight ready", "Follow evacuation orders from authorities"],
  },
  wildfire: {
    icon: "🔥", title: "WILDFIRE ALERT",
    message: "A fast-moving fire is threatening your area.",
    tips: ["Evacuate now if told to leave", "Close all windows and doors", "Wear a mask to reduce smoke inhalation", "Know two exit routes from your area"],
  },
  volcano: {
    icon: "🌋", title: "VOLCANIC ERUPTION ALERT",
    message: "Eruption activity reported nearby.",
    tips: ["Evacuate if ordered", "Protect your eyes, nose and mouth from ash", "Stay indoors and seal windows", "Avoid river valleys and low-lying areas"],
  },
};

// ---- State ----
let seenIds = new Set(JSON.parse(localStorage.getItem("nda_seen") || "[]"));
let firstLoad = true;
let timer = null;
let muted = false;

// ---- Settings persistence ----
function loadSettings() {
  const s = JSON.parse(localStorage.getItem("nda_settings") || "{}");
  if (s.minMag) el.minMag.value = s.minMag;
  if (s.feedMag) el.feedMag.value = s.feedMag;
  if (s.soundOn !== undefined) el.soundOn.checked = s.soundOn;
  if (s.autoRefresh !== undefined) el.autoRefresh.checked = s.autoRefresh;
  if (s.notifyOn && "Notification" in window && Notification.permission === "granted") {
    el.notifyOn.checked = true;
  }
  updateLabels();
}
function saveSettings() {
  localStorage.setItem("nda_settings", JSON.stringify({
    minMag: el.minMag.value, feedMag: el.feedMag.value,
    soundOn: el.soundOn.checked, notifyOn: el.notifyOn.checked,
    autoRefresh: el.autoRefresh.checked,
  }));
}
function updateLabels() {
  el.minMagValue.textContent = Number(el.minMag.value).toFixed(1);
  el.feedMagValue.textContent = Number(el.feedMag.value).toFixed(1);
}

// ---- Siren (Web Audio) ----
let audioCtx = null, sirenNodes = null;

function startSiren() {
  if (!el.soundOn.checked || muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    stopSiren();

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const lfo = audioCtx.createOscillator();
    const lfoGain = audioCtx.createGain();

    osc.type = "sawtooth";
    osc.frequency.value = 800;
    lfo.type = "triangle";
    lfo.frequency.value = 1.2;      // sweep speed
    lfoGain.gain.value = 300;       // sweep depth (Hz)
    gain.gain.value = 0.25;

    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(); lfo.start();

    sirenNodes = { osc, lfo, gain };
  } catch (e) {
    console.warn("Audio unavailable:", e);
  }
}

function stopSiren() {
  if (!sirenNodes) return;
  try { sirenNodes.osc.stop(); sirenNodes.lfo.stop(); } catch (_) {}
  sirenNodes = null;
}

// ---- Alarm UI ----
function showAlarm({ icon, title, message, tips }) {
  el.alarmIcon.textContent = icon;
  el.alarmTitle.textContent = title;
  el.alarmMessage.textContent = message;
  el.alarmTips.innerHTML = tips.map((t) => `<li>${escapeHtml(t)}</li>`).join("");
  el.alarm.hidden = false;
  muted = false;
  el.muteBtn.textContent = "🔇 Mute sound";
  startSiren();
  if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
  sendNotification(title, message);
}

function dismissAlarm() {
  el.alarm.hidden = true;
  stopSiren();
  if (navigator.vibrate) navigator.vibrate(0);
}

function sendNotification(title, body) {
  if (!el.notifyOn.checked || !("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

// ---- Fetch + render earthquakes ----
async function fetchQuakes() {
  setStatus("Checking…", "");
  try {
    const res = await fetch(FEED_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const quakes = data.features
      .filter((f) => f.properties.mag !== null)
      .sort((a, b) => b.properties.time - a.properties.time);

    renderList(quakes);
    checkForAlerts(quakes);

    el.lastUpdated.textContent = "Updated " + new Date().toLocaleTimeString();
    setStatus("Monitoring live", "ok");
  } catch (err) {
    console.error(err);
    setStatus("Connection problem – retrying", "err");
  }
}

function renderList(quakes) {
  const min = Number(el.feedMag.value);
  const shown = quakes.filter((q) => q.properties.mag >= min).slice(0, 60);

  if (!shown.length) {
    el.list.innerHTML = `<li class="muted">No earthquakes at this magnitude in the last 24 hours.</li>`;
    return;
  }

  el.list.innerHTML = shown.map((q) => {
    const p = q.properties;
    const cls = p.mag >= 6 ? "m6" : p.mag >= 5 ? "m5" : p.mag >= 4 ? "m4" : "";
    return `
      <li>
        <div class="mag ${cls}">${p.mag.toFixed(1)}</div>
        <div class="q-info">
          <div class="q-place">${escapeHtml(p.place || "Unknown location")}</div>
          <div class="q-time">${timeAgo(p.time)} · ${new Date(p.time).toLocaleString()}</div>
        </div>
        <a class="q-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Details</a>
      </li>`;
  }).join("");
}

function checkForAlerts(quakes) {
  const threshold = Number(el.minMag.value);
  const now = Date.now();
  let triggered = null;

  for (const q of quakes) {
    const p = q.properties;
    if (seenIds.has(q.id)) continue;
    seenIds.add(q.id);

    // On the very first load, don't alarm for old events – just remember them.
    if (firstLoad) continue;

    if (p.mag >= threshold && now - p.time <= MAX_ALERT_AGE_MS) {
      if (!triggered || p.mag > triggered.properties.mag) triggered = q;
    }
  }

  firstLoad = false;
  localStorage.setItem("nda_seen", JSON.stringify([...seenIds].slice(-500)));

  if (triggered) {
    const p = triggered.properties;
    showAlarm({
      ...DISASTERS.earthquake,
      title: `M${p.mag.toFixed(1)} EARTHQUAKE`,
      message: `${p.place || "Unknown location"} · ${timeAgo(p.time)}`,
    });
  }
}

// ---- Helpers ----
function setStatus(text, state) {
  el.statusText.textContent = text;
  el.statusDot.className = "dot " + state;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86400) + " d ago";
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function schedule() {
  clearInterval(timer);
  if (el.autoRefresh.checked) timer = setInterval(fetchQuakes, REFRESH_MS);
}

// ---- Events ----
el.minMag.addEventListener("input", () => { updateLabels(); saveSettings(); });
el.feedMag.addEventListener("input", () => { updateLabels(); saveSettings(); fetchQuakes(); });
el.soundOn.addEventListener("change", saveSettings);
el.autoRefresh.addEventListener("change", () => { saveSettings(); schedule(); });
el.refreshBtn.addEventListener("click", fetchQuakes);

el.notifyOn.addEventListener("change", async () => {
  if (el.notifyOn.checked) {
    if (!("Notification" in window)) {
      alert("Notifications are not supported in this browser.");
      el.notifyOn.checked = false;
    } else if (Notification.permission !== "granted") {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") el.notifyOn.checked = false;
    }
  }
  saveSettings();
});

document.querySelectorAll("[data-drill]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const d = DISASTERS[btn.dataset.drill];
    showAlarm({ ...d, title: "DRILL: " + d.title, message: d.message + " (This is a test.)" });
  });
});

el.muteBtn.addEventListener("click", () => {
  muted = !muted;
  if (muted) { stopSiren(); el.muteBtn.textContent = "🔊 Unmute"; }
  else { startSiren(); el.muteBtn.textContent = "🔇 Mute sound"; }
});
el.dismissBtn.addEventListener("click", dismissAlarm);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.alarm.hidden) dismissAlarm(); });

// ---- Init ----
loadSettings();
fetchQuakes();
schedule();