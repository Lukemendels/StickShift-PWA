"use strict";

/* StickShift mobile / HTTPS refactor smoke build.
   Architectural invariants:
   - OKF Markdown remains the state of record.
   - Directory access is always initiated by the operator.
   - Saved directory handles live only in IndexedDB; no OKF content is mirrored there.
   - Clipboard remains a manual transport boundary.
*/

const OKF_VERSION = "0.1";
const FOUNDATION_DIR = "_foundation";
const DIST_DIR = "-dist";
const HTML_DIR = "-html";
const SYSTEM_DIRS = new Set([DIST_DIR, HTML_DIR]);
const RESERVED = new Set(["index.md","log.md"]);
const DIST_THRESHOLD = 100000;

const $ = id => document.getElementById(id);
let ROOT = null;
let ROOT_NAME = "";
let FILES = new Map();
let ACTIVE_PATH = "";
let EDIT_MODE = false;
const EXPANDED_DIRS = new Set();

function log(msg, cls="info"){
  const line = document.createElement("div");
  line.className = "line";
  const t = new Date().toTimeString().slice(0,8);
  line.innerHTML = '<span class="t"></span><span></span>';
  line.children[0].textContent = t;
  line.children[1].textContent = msg;
  line.children[1].className = cls;
  $("log").appendChild(line);
  $("log").scrollTop = $("log").scrollHeight;
}

function isSystemDir(name){ return SYSTEM_DIRS.has(String(name||"")); }
function isConcept(name){ const n=String(name||"").toLowerCase(); return n.endsWith(".md") && !RESERVED.has(n); }
function pad(n){ return String(n).padStart(2,"0"); }
function stampNow(){
  const d=new Date();
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function runtimeCaps(){
  const standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || window.navigator.standalone === true;
  return {
    secure: !!window.isSecureContext,
    directory: typeof window.showDirectoryPicker === "function",
    clipboardRead: !!(navigator.clipboard && typeof navigator.clipboard.readText === "function"),
    clipboardWrite: !!(navigator.clipboard && typeof navigator.clipboard.writeText === "function"),
    indexedDB: "indexedDB" in window,
    standalone,
    protocol: location.protocol || "",
    origin: location.origin || location.href
  };
}

function renderRuntime(){
  const c = runtimeCaps();
  const banner = $("runtimeBanner");
  let title="", detail="", cls="";
  if(c.directory && c.secure){
    title="Mobile runtime ready";
    detail="Secure context + directory picker detected. Local OKF folder access can be operator-triggered.";
    cls="ok";
  }else if(!c.secure){
    title="HTTPS required for the full mobile path";
    detail="The UI can load here, but folder/clipboard capabilities may be restricted. Serve this file from HTTPS for the real test.";
    cls="warn";
  }else{
    title="Directory picker unavailable";
    detail="This browser does not expose showDirectoryPicker(). Use current Chrome/Chromium for the folder-backed StickShift workflow.";
    cls="";
  }
  banner.className = "runtime "+cls;
  $("runtimeTitle").textContent=title;
  $("runtimeDetail").textContent=detail;
  renderDiagnostics();
}

function renderDiagnostics(){
  const c = runtimeCaps();
  const rows = [
    ["Secure context", c.secure, c.secure ? "YES" : "NO"],
    ["Directory picker", c.directory, c.directory ? "AVAILABLE" : "MISSING"],
    ["Clipboard read", c.clipboardRead, c.clipboardRead ? "AVAILABLE" : "MISSING"],
    ["Clipboard write", c.clipboardWrite, c.clipboardWrite ? "AVAILABLE" : "MISSING"],
    ["IndexedDB", c.indexedDB, c.indexedDB ? "AVAILABLE" : "MISSING"],
    ["Display mode", true, c.standalone ? "STANDALONE / INSTALLED" : "BROWSER TAB"],
    ["Protocol", c.protocol==="https:" || c.protocol==="file:", c.protocol || "(none)"],
    ["Origin", true, c.origin]
  ];
  $("diagGrid").innerHTML = rows.map(([k,good,v]) =>
    `<div class="diag"><div class="k">${escapeHtml(k)}</div><div class="v ${good?"good":"bad"}">${escapeHtml(v)}</div></div>`
  ).join("");
}

function escapeHtml(s){
  return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* IndexedDB stores only the browser's directory handle, never OKF content. */
const IDB_NAME="stickshift", STORE_NAME="handles", HKEY="context";
function openDb(){
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(IDB_NAME,1);
    r.onupgradeneeded=()=>{ if(!r.result.objectStoreNames.contains(STORE_NAME)) r.result.createObjectStore(STORE_NAME); };
    r.onsuccess=()=>resolve(r.result);
    r.onerror=()=>reject(r.error);
  });
}
async function idbSet(value){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,"readwrite");
    tx.objectStore(STORE_NAME).put(value,HKEY);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>reject(tx.error);
  });
}
async function idbGet(){
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE_NAME,"readonly");
    const rq=tx.objectStore(STORE_NAME).get(HKEY);
    rq.onsuccess=()=>resolve(rq.result);
    rq.onerror=()=>reject(rq.error);
  });
}

async function queryPermission(handle, write=true){
  if(!handle || typeof handle.queryPermission!=="function") return "prompt";
  try{return await handle.queryPermission({mode:write?"readwrite":"read"});}catch{return "prompt";}
}
async function requestPermission(handle, write=true){
  if(!handle || typeof handle.requestPermission!=="function") return false;
  try{return (await handle.requestPermission({mode:write?"readwrite":"read"}))==="granted";}catch{return false;}
}

function setEngaged(handle){
  const contextChanged=ROOT!==handle;
  ROOT=handle||null;
  ROOT_NAME=handle?.name||"";
  const path=$("ctxPath");
  const buildButton=$("btnBuild");
  if(contextChanged){
    FILES.clear();
    ACTIVE_PATH="";
    EDIT_MODE=false;
    EXPANDED_DIRS.clear();
  }
  if(ROOT){
    $("gate").classList.add("engaged");
    $("gearVal").textContent="1";
    path.textContent=ROOT_NAME;
    path.classList.remove("none");
    if(buildButton) buildButton.disabled=false;
    $("ctxMeter").textContent="Ready. Start a chat with context or tap the receiver to route a StickShift packet.";
  }else{
    $("gate").classList.remove("engaged");
    $("gearVal").textContent="N";
    path.textContent="— no context engaged —";
    path.classList.add("none");
    if(buildButton) buildButton.disabled=true;
    $("ctxMeter").textContent="";
  }
}
function requireRoot(){
  if(ROOT) return true;
  log("No context engaged — tap Select context first.","er");
  return false;
}

async function switchContext(){
  if(typeof window.showDirectoryPicker!=="function"){
    log("Directory picker is unavailable in this runtime.","er");
    showView("diagnostics");
    return false;
  }
  try{
    const handle=await window.showDirectoryPicker({mode:"readwrite"});
    let state=await queryPermission(handle,true);
    if(state!=="granted"){
      if(!(await requestPermission(handle,true))){
        log("Read/write permission was not granted.","er");
        return false;
      }
    }
    setEngaged(handle);
    try{ await idbSet(handle); }catch(e){ log("Context handle could not be persisted: "+e.message,"amb"); }
    log(`Context engaged: ${handle.name}. Explorer remains unloaded until opened.`,"ok");
    return true;
  }catch(e){
    if(e?.name!=="AbortError") log("Select context failed: "+(e?.message||e),"er");
    return false;
  }
}

/* On boot, only re-use a saved handle when permission is already granted.
   Never call requestPermission() without a fresh operator gesture. */
async function reconnectSavedContext(request=false){
  try{
    const handle=await idbGet();
    if(!handle){
      log("No saved context handle found.","info");
      return false;
    }
    let state=await queryPermission(handle,true);
    if(state!=="granted" && request) state=(await requestPermission(handle,true))?"granted":"denied";
    if(state!=="granted"){
      log(`Saved context found (${handle.name||"folder"}), but permission needs a tap to reconnect.`,"amb");
      return false;
    }
    setEngaged(handle);
    log(`Reconnected context: ${handle.name}. Explorer remains unloaded until opened.`,"ok");
    return true;
  }catch(e){
    log("Saved context could not be restored: "+(e?.message||e),"amb");
    return false;
  }
}
