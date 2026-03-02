// Condo EV Charger Status (Option A - no login)
// Backend: Firebase Realtime Database (free tier via Spark plan)
// IMPORTANT: Fill in firebaseConfig below.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  update,
  get,
  push,
  set,
  query,
  limitToLast,
  onChildAdded
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

/**
 * ========= CONFIG =========
 * 1) Create a Firebase project (Spark/free)
 * 2) Enable Realtime Database
 * 3) Paste your Firebase web app config here
 */
const firebaseConfig = {
  apiKey: "AIzaSyCaHL-hbefe7P3lRL9-Xu7kn04GYxgjEsY",
  authDomain: "ow-ev-charger-status.firebaseapp.com",
  databaseURL: "https://ow-ev-charger-status-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ow-ev-charger-status",
  storageBucket: "ow-ev-charger-status.firebasestorage.app",
  messagingSenderId: "893019180923",
  appId: "1:893019180923:web:8bd870450ed7084625f7de"
};

// Charger naming (you wanted "location names")
const CHARGERS = [
  { id: "c1", name: "Charger 1" },
  { id: "c2", name: "Charger 2" },
  { id: "c3", name: "Charger 3" },
  { id: "c4", name: "Charger 4" }	
];

// You selected auto-expiry option "4 hours"
const EXPIRY_GRACE_MS = 30 * 60 * 1000; // 30 minutes grace after time limit
const PIN_KEY = "ow_ev_pin_v1";
const WATCH_KEY = "ow_ev_watch_v1";

// ========= UI =========
const cardsEl = document.getElementById("cards");
const refreshBtn = document.getElementById("refreshBtn");
const historyBtn = document.getElementById("historyBtn");
const toastRoot = document.getElementById("toastRoot");
const historyModal = document.getElementById("historyModal");
const historyList = document.getElementById("historyList");
const clearPinBtn = document.getElementById("clearPinBtn");
const pinModal = document.getElementById("pinModal");
const pinInput = document.getElementById("pinInput");
const pinSaveBtn = document.getElementById("pinSaveBtn");

const lastSyncPill = document.getElementById("lastSyncPill");

const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modalTitle");
const modalStatus = document.getElementById("modalStatus");
const modalUpdated = document.getElementById("modalUpdated");
const modalSince = document.getElementById("modalSince");
const modalEta = document.getElementById("modalEta");
const inUseRow = document.getElementById("inUseRow");
const etaMinutesEl = document.getElementById("etaMinutes");
const apartmentNoEl = document.getElementById("apartmentNo");
const vehicleNoteEl = document.getElementById("vehicleNote");
const checkInBtn = document.getElementById("checkInBtn");
const checkOutBtn = document.getElementById("checkOutBtn");
const markUnknownBtn = document.getElementById("markUnknownBtn");
const faultApartmentNoEl = document.getElementById("faultApartmentNo");
const faultNoteEl = document.getElementById("faultNote");
const reportFaultBtn = document.getElementById("reportFaultBtn");
const clearFaultBtn = document.getElementById("clearFaultBtn");
const faultMetaEl = document.getElementById("faultMeta");
const checkOutPanel = document.getElementById("checkOutPanel");
const checkInPanel = document.getElementById("checkInPanel");
const modalNote = document.getElementById("modalNote");

let app, db;
let state = {}; // chargers state from DB
let prevStatusById = {};
let recentEvents = [];

let activeChargerId = null;

// Helpers
function fmtTime(ts){
  if(!ts) return "—";
  try{
    const d = new Date(ts);
    return d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" });
  }catch{return "—";}
}
function fmtETA(endTs){
  if(!endTs) return "—";
  const d = new Date(endTs);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function statusLabel(s){
  if(s === "FREE") return "Free";
  if(s === "IN_USE") return "In use";
  if(s === "FAULT") return "Fault";
  return "Unknown";
}
function statusClass(s){
  if(s === "FREE") return "free";
  if(s === "IN_USE") return "in_use";
  if(s === "FAULT") return "fault";
  return "unknown";
}
function nowMs(){ return Date.now(); }

function maybeNotifyFree(nextState){
  const watchSet = getWatchSet();
  for(const ch of CHARGERS){
    const id = ch.id;
    const prev = prevStatusById[id] || null;
    const curr = (nextState[id]?.status) || "UNKNOWN";
    prevStatusById[id] = curr;
    if(!watchSet.has(id)) continue;
    if(prev && prev !== "FREE" && curr === "FREE"){
      toast(`${ch.name} is now Free`, "You can head to the charger.", [
        { label: "Open", onClick: ()=>openModal(id) }
      ]);
      if("Notification" in window && Notification.permission === "granted"){
        try{ new Notification(`${ch.name} is now Free`, { body: "You can head to the charger." }); }catch{}
      }
    }
  }
}

function ensureFirebaseConfigured(){
  // Basic guard to avoid confusing blank screen if config isn't set.
  const missing = Object.values(firebaseConfig).some(v => typeof v === "string" && v.startsWith("PASTE_"));
  if(missing){
    cardsEl.innerHTML = `
      <div class="card">
        <h3>Setup needed</h3>
        <p class="loc">Open <span class="mono">app.js</span> and paste your Firebase config values.</p>
        <p class="loc">Then redeploy this site. (See README)</p>
      </div>`;
    lastSyncPill.textContent = "Not connected (config missing)";
    throw new Error("Firebase config missing");
  }
}

function attachWatchListeners(){
  const setObj = getWatchSet();
  cardsEl.querySelectorAll("[data-watch]").forEach(inp=>{
    inp.addEventListener("change", ()=>{
      const id = inp.getAttribute("data-watch");
      if(inp.checked) setObj.add(id); else setObj.delete(id);
      setWatchSet(setObj);
      toast("Notifications updated", inp.checked ? `You'll be alerted when ${id.toUpperCase()} becomes Free.` : `Notifications turned off for ${id.toUpperCase()}.`);
      // Ask notification permission if turning on
      if(inp.checked && "Notification" in window && Notification.permission === "default"){
        Notification.requestPermission().catch(()=>{});
      }
    }, { once:true });
  });
}

function render(){
  cardsEl.innerHTML = "";
  for(const ch of CHARGERS){
    const chState = state[ch.id] || { status:"UNKNOWN" };
    const s = chState.status || "UNKNOWN";
    const updatedAt = chState.updatedAt || null;
    const session = chState.session || null;

    const since = session?.startedAt ?? null;
    const etaEnd = session?.expectedEndAt ?? null;
    const note = session?.note ?? "";

    const card = document.createElement("article");
    card.className = `card ${statusClass(s)}`;
    card.innerHTML = `
      <div class="card-head">
        <div>
          <h3>${escapeHtml(ch.name)}</h3>
        </div>
        <div class="status ${statusClass(s)}" aria-label="status">
          <span class="dot"></span>
          <span>${statusLabel(s)}</span>
        </div>
      </div>

      <div class="kv">
        <div class="item">
          <div class="label">Last updated</div>
          <div class="value mono">${updatedAt ? fmtTime(updatedAt) : "—"}</div>
        </div>
        <div class="item">
          <div class="label">ETA</div>
          <div class="value mono">${s === "IN_USE" ? fmtETA(etaEnd) : "—"}</div>
        </div>
      </div>

      ${s === "IN_USE" ? `
        <div class="kv">
          <div class="item">
            <div class="label">In use since</div>
            <div class="value mono">${fmtTime(since)}</div>
          </div>
          <div class="item">
            <div class="label">Vehicle note</div>
            <div class="value">${note ? escapeHtml(note) : "—"}</div>
          </div>
        </div>` : ""}

      ${renderNotifyBlock(ch.id, s)}

      <div class="card-actions">
        <button class="btn btn-primary" data-open="${ch.id}">Open</button>
      </div>
    `;
    cardsEl.appendChild(card);
  }

  cardsEl.querySelectorAll("[data-open]").forEach(btn=>{
    btn.addEventListener("click", () => openModal(btn.getAttribute("data-open")));
  });
  attachWatchListeners();
}

function openModal(chargerId){
  activeChargerId = chargerId;
  const ch = CHARGERS.find(x=>x.id===chargerId);
  const chState = state[chargerId] || { status:"UNKNOWN" };
  const s = chState.status || "UNKNOWN";
  const updatedAt = chState.updatedAt || null;
  const session = chState.session || null;

  modalTitle.textContent = ch ? `${ch.name}` : "Charger";
  modalStatus.textContent = statusLabel(s);
  modalUpdated.textContent = updatedAt ? fmtTime(updatedAt) : "—";

  const since = session?.startedAt ?? null;
  const etaEnd = session?.expectedEndAt ?? null;

  if(s === "IN_USE" && since){
    inUseRow.hidden = false;
    modalSince.textContent = fmtTime(since);
    modalEta.textContent = fmtETA(etaEnd);
    checkOutPanel.hidden = false;
    checkInPanel.hidden = true;
    const apt = session?.apartment ? `Apt ${session.apartment}` : "";
    const vn = session?.note ? `Vehicle note: ${session.note}` : "";
    modalNote.textContent = [apt, vn].filter(Boolean).join(" • ");
  }else{
    inUseRow.hidden = true;
    checkOutPanel.hidden = true;
    checkInPanel.hidden = false;
    modalNote.textContent = "";
    etaMinutesEl.value = "";
    apartmentNoEl.value = "";
    vehicleNoteEl.value = "";
  }

  // Fault meta
  const fault = chState.fault || null;
  if(fault && (s === "FAULT")){
    const who = fault.apartment ? `Apt ${fault.apartment}` : "Unknown";
    faultMetaEl.textContent = `Reported by ${who} • ${fmtTime(fault.reportedAt)}${fault.note ? " • " + fault.note : ""}`;
    faultApartmentNoEl.value = fault.apartment || "";
    faultNoteEl.value = fault.note || "";
  }else{
    faultMetaEl.textContent = "";
    faultApartmentNoEl.value = "";
    faultNoteEl.value = "";
  }

  modal.showModal();
}


function getSavedPin(){
  try{ 
    const pin = localStorage.getItem(PIN_KEY) || "";
    if(pin && !/^\d{4}$/.test(pin)){
      localStorage.removeItem(PIN_KEY);
      return "";
    }
    return pin;
  }catch{ return ""; }
}
function savePin(pin){
  try{ localStorage.setItem(PIN_KEY, pin); }catch{}
}
function clearPin(){
  try{ localStorage.removeItem(PIN_KEY); }catch{}
}
function getWatchSet(){
  try{
    const raw = localStorage.getItem(WATCH_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr : []);
  }catch{
    return new Set();
  }
}
function setWatchSet(setObj){
  try{
    localStorage.setItem(WATCH_KEY, JSON.stringify(Array.from(setObj)));
  }catch{}
}

function toast(title, subtitle, actions=[]){
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `
    <div>
      <div class="t-title">${escapeHtml(title)}</div>
      <div class="t-sub">${escapeHtml(subtitle || "")}</div>
    </div>
    <div class="t-actions"></div>
  `;
  const actionsEl = el.querySelector(".t-actions");
  for(const a of actions){
    const b = document.createElement("button");
    b.className = "btn btn-ghost";
    b.textContent = a.label;
    b.addEventListener("click", ()=>{ try{ a.onClick?.(); } finally { el.remove(); }});
    actionsEl.appendChild(b);
  }
  // Auto remove
  setTimeout(()=>{ if(el.isConnected) el.remove(); }, 9000);
  toastRoot.appendChild(el);
}

function renderNotifyBlock(chargerId, status){
  const watched = getWatchSet().has(chargerId);
  const disabled = (status === "FAULT"); // don't notify on fault
  return `
    <div class="notify">
      <div style="flex:1">
        <div class="label">Notify me</div>
        <div class="value">${disabled ? "Disabled (Fault)" : "Alert me when this becomes Free"}</div>
      </div>
      <label class="switch" aria-label="Notify toggle">
        <input type="checkbox" data-watch="${chargerId}" ${watched ? "checked" : ""} ${disabled ? "disabled" : ""} />
        <span class="slider"></span>
      </label>
    </div>
  `;
}

async function ensurePinForWrite(){
  const pin = getSavedPin();
  if(pin) return pin;
  // Ask user to enter PIN once per device
  pinInput.value = "";
  pinModal.showModal();
  return new Promise((resolve, reject)=>{
    const handler = ()=>{
      const v = (pinInput.value || "").trim();
      if(!/^\d{4}$/.test(v)){
        alert("Please enter a valid 4-digit PIN.");
        return;
      }
      savePin(v);
      pinModal.close();
      pinSaveBtn.removeEventListener("click", handler);
      resolve(v);
    };
    pinSaveBtn.addEventListener("click", handler);
    pinModal.addEventListener("close", ()=>{
      // If user cancels without saving
      const p = getSavedPin();
      if(!p){
        pinSaveBtn.removeEventListener("click", handler);
        reject(new Error("PIN not set"));
      }
    }, { once:true });
  });
}


// ========= DB Logic =========
function chargerRef(id){ return ref(db, `chargers/${id}`); }
function eventsRef(){ return ref(db, `events`); }
async function logEvent(type, chargerId, payload={}){
  const ts = nowMs();
  const entry = { type, chargerId, ts, ...payload };
  const p = push(eventsRef());
  await set(p, entry);
}

async function checkIn(){
  if(!activeChargerId) return;
  let pin;
  try{ pin = await ensurePinForWrite(); }catch{ return; }
  const etaMinutesRaw = (etaMinutesEl.value || "").trim();
  const etaMinutes = etaMinutesRaw ? parseInt(etaMinutesRaw, 10) : null;
  if(etaMinutesRaw && (!etaMinutes || etaMinutes < 1)){
    alert("Please choose a valid time limit (minutes), or leave it blank.");
    return;
  }
  const apartment = (apartmentNoEl.value || "").trim().slice(0, 12);
  if(!apartment){
    alert("Apartment number is mandatory.");
    return;
  }
  const note = (vehicleNoteEl.value || "").trim().slice(0, 30);

  const startedAt = nowMs();
  const expectedEndAt = etaMinutes ? (startedAt + etaMinutes * 60 * 1000) : null;

  await update(chargerRef(activeChargerId), {
    pin,
    status: "IN_USE",
    updatedAt: startedAt,
    session: {
      startedAt,
      expectedEndAt,
      etaMinutes,
      apartment,
      note
    }
  });
  await logEvent("CHECK_IN", activeChargerId, { apartment, etaMinutes, expectedEndAt, note });
  modal.close();
}

async function checkOut(){
  if(!activeChargerId) return;
  let pin;
  try{ pin = await ensurePinForWrite(); }catch{ return; }
  const ts = nowMs();
  await update(chargerRef(activeChargerId), {
    pin,
    status: "FREE",
    updatedAt: ts,
    session: null
  });
  await logEvent("CHECK_OUT", activeChargerId, {});
  modal.close();
}

async function reportFault(){
  if(!activeChargerId) return;
  let pin;
  try{ pin = await ensurePinForWrite(); }catch{ return; }
  const apartment = (faultApartmentNoEl.value || "").trim().slice(0, 12);
  if(!apartment){
    alert("Apartment number is mandatory to report a fault.");
    return;
  }
  const note = (faultNoteEl.value || "").trim().slice(0, 60);
  const ts = nowMs();
  await update(chargerRef(activeChargerId), {
    pin,
    status: "FAULT",
    updatedAt: ts,
    // If a charger is faulted, clear any active session to avoid confusion
    session: null,
    fault: {
      reportedAt: ts,
      apartment,
      note
    }
  });
  await logEvent("FAULT", activeChargerId, { apartment, note });
  modal.close();
}

async function clearFault(){
  if(!activeChargerId) return;
  let pin;
  try{ pin = await ensurePinForWrite(); }catch{ return; }
  const ts = nowMs();
  await update(chargerRef(activeChargerId), {
    pin,
    status: "UNKNOWN",
    updatedAt: ts,
    fault: null
  });
  await logEvent("CLEAR_FAULT", activeChargerId, {});
  modal.close();
}

async function markUnknown(){
  if(!activeChargerId) return;
  let pin;
  try{ pin = await ensurePinForWrite(); }catch{ return; }
  const ts = nowMs();
  await update(chargerRef(activeChargerId), {
    pin,
    status: "UNKNOWN",
    updatedAt: ts,
    session: null
  });
  await logEvent("MARK_UNKNOWN", activeChargerId, {});
  modal.close();
}

/**
 * Auto-expiry:
 * If charger is IN_USE for > AUTO_EXPIRY_MS, switch to UNKNOWN.
 * Runs:
 * - on every live update
 * - on manual refresh
 * This is client-driven (no server), but works because people will open the page.
 */
async function enforceAutoExpiry(){
  const now = nowMs();
  const ops = {};
  for(const ch of CHARGERS){
    const chState = state[ch.id];
    if(!chState) continue;

    // Only auto-expire when a time limit was provided
    if(chState.status === "IN_USE" && chState.session?.expectedEndAt){
      const expireAt = chState.session.expectedEndAt + EXPIRY_GRACE_MS;
      if(now > expireAt){
        ops[`chargers/${ch.id}/status`] = "UNKNOWN";
        ops[`chargers/${ch.id}/updatedAt`] = now;
        ops[`chargers/${ch.id}/session`] = null;
      }
    }
  }
  if(Object.keys(ops).length){
    let pin = getSavedPin();
    if(!pin){
      // Can't auto-expire without PIN on this device
      return;
    }
    // Attach pin for each affected charger node
    const opsWithPin = { ...ops };
    for(const ch of CHARGERS){
      if(ops[`chargers/${ch.id}/status`]){
        opsWithPin[`chargers/${ch.id}/pin`] = pin;
      }
    }
    await update(ref(db), opsWithPin);
  }
}

function setLastSync(text){
  lastSyncPill.textContent = text;
}

function chargerNameById(id){
  return CHARGERS.find(c=>c.id===id)?.name || id;
}

function renderHistory(){
  const items = [...recentEvents].sort((a,b)=>b.ts-a.ts).slice(0, 40);
  historyList.innerHTML = items.map(e=>{
    const title = `${chargerNameById(e.chargerId)} • ${e.type.replaceAll('_',' ')}`;
    const when = fmtTime(e.ts);
    const meta = [];
    if(e.apartment) meta.push(`Apt ${escapeHtml(e.apartment)}`);
    if(e.etaMinutes) meta.push(`Limit ${e.etaMinutes} min`);
    if(e.note) meta.push(escapeHtml(e.note));
    return `
      <div class="history-item">
        <div class="top">
          <div><b>${title}</b></div>
          <div class="mono">${when}</div>
        </div>
        <div class="meta">${meta.length ? meta.join(' • ') : ''}</div>
      </div>
    `;
  }).join('') || '<div class="fineprint">No activity yet.</div>';
}

function subscribeHistory(){
  const q = query(ref(db, 'events'), limitToLast(50));
  onChildAdded(q, (snap)=>{
    const v = snap.val();
    if(v && v.ts){
      recentEvents.push(v);
      if(recentEvents.length > 200) recentEvents = recentEvents.slice(-200);
      if(historyModal.open) renderHistory();
    }
  });
}

// HTML escaping
function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ========= Boot =========
function boot(){
  ensureFirebaseConfigured();
  app = initializeApp(firebaseConfig);
  db = getDatabase(app);

  // Initial seed is done via Firebase console (see README)
  seedIfEmpty();

  // Subscribe to activity history
  subscribeHistory();

  // Realtime subscribe
  onValue(ref(db, "chargers"), async (snap)=>{
    const next = snap.val() || {};
    state = next;
    maybeNotifyFree(next);
    render();
    setLastSync(`Live • ${new Date().toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}`);
    try{ await enforceAutoExpiry(); }catch(e){ /* ignore */ }
  });

  historyBtn.addEventListener("click", ()=>{
    renderHistory();
    historyModal.showModal();
  });
  clearPinBtn.addEventListener("click", ()=>{
    clearPin();
    toast("PIN forgotten", "This device will ask for PIN again before updates.");
  });

  refreshBtn.addEventListener("click", async ()=>{
    setLastSync("Refreshing…");
    const snap = await get(ref(db, "chargers"));
    state = snap.val() || {};
    render();
    setLastSync(`Refreshed • ${new Date().toLocaleTimeString(undefined,{hour:"2-digit",minute:"2-digit"})}`);
    try{ await enforceAutoExpiry(); }catch(e){ /* ignore */ }
  });

  checkInBtn.addEventListener("click", checkIn);
  checkOutBtn.addEventListener("click", checkOut);
  markUnknownBtn.addEventListener("click", markUnknown);
  reportFaultBtn.addEventListener("click", reportFault);
  clearFaultBtn.addEventListener("click", clearFault);
}

async function seedIfEmpty(){
  // With PIN-protected writes, initial seeding is best done from Firebase console (see README).
  // This function is kept as a no-op to avoid write failures on first load.
  return;
}

boot();
