const CLIPBOARD_PORTABLE_CHARS = 20000;
let DIST_WRITE_CHAIN=Promise.resolve();
let DIST_WRITE_SEQUENCE=0;

function scheduleDistWrite(text,{label="Context bundle"}={}){
  const root=ROOT;
  const rootName=ROOT_NAME||root?.name||"context";
  const path=`${DIST_DIR}/StickShift-context.md`;
  const sequence=++DIST_WRITE_SEQUENCE;
  const queuedAt=performance.now();
  log(`-dist fallback #${sequence} queued for ${rootName}: ${label}.`,"info");

  const promise=DIST_WRITE_CHAIN.catch(()=>{}).then(async()=>{
    const writeStart=performance.now();
    await writeFileAtRoot(root,path,text);
    const writeMs=performance.now()-writeStart;
    const totalMs=performance.now()-queuedAt;
    log(`-dist fallback #${sequence} settled: ${path} · write ${fmtMs(writeMs)} · queued-to-settled ${fmtMs(totalMs)}.`,"ok");
    return {path,writeMs,totalMs,sequence};
  }).catch(error=>{
    const totalMs=performance.now()-queuedAt;
    log(`-dist fallback #${sequence} failed after ${fmtMs(totalMs)}: ${error?.message||error}`,"er");
    throw error;
  });

  DIST_WRITE_CHAIN=promise.catch(()=>{});
  return {path,sequence,promise};
}

function parseWriteEnvelope(text){
  const m=String(text||"").match(/<VBA_WRITE>([\s\S]*?)<\/VBA_WRITE>/i);
  if(!m) return {error:"No <VBA_WRITE> block found."};
  const body=m[1].replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  const files=[];
  let pos=0;
  while(true){
    const a=body.indexOf("### FILE:",pos);
    if(a<0) break;
    const nl=body.indexOf("\n",a);
    if(nl<0) break;
    const rel=body.slice(a+"### FILE:".length,nl).trim().replace(/^\/+/,"");
    const end=body.indexOf("### END FILE",nl);
    if(end<0) break;
    let content=body.slice(nl+1,end);
    if(content.endsWith("\n")) content=content.slice(0,-1);
    if(rel) files.push({rel,content});
    pos=end+"### END FILE".length;
  }
  return files.length?{files}:{error:"No valid ### FILE: blocks found."};
}
async function applyWrite(env){
  const applyStart=performance.now();
  const timing={existsMs:0,fileWriteMs:0,totalMs:0};
  let written=0,skipped=0;
  const writes=[];
  for(const item of env.files){
    const rel=String(item.rel||"").replace(/\\/g,"/").replace(/^\/+/,"");
    const leaf=rel.split("/").pop().toLowerCase();
    if(!rel||RESERVED.has(leaf)){skipped++;continue;}

    let stageStart=performance.now();
    const existed=await fileExists(rel);
    timing.existsMs+=performance.now()-stageStart;

    stageStart=performance.now();
    await writeFile(rel,item.content);
    timing.fileWriteMs+=performance.now()-stageStart;

    written++;
    writes.push({rel,content:item.content,existed});
  }
  timing.totalMs=performance.now()-applyStart;
  return {written,skipped,timing,writes};
}

async function appendWriteAudit(writes){
  if(!writes?.length) return 0;
  const started=performance.now();
  const logLines=writes.map(write=>`- ${stampNow()}  ${write.existed?"edit":"new"}  ${write.rel}\n`).join("");
  await appendFile("log.md",logLines,"# Log\n\n");
  return performance.now()-started;
}

async function writeClip(text){
  if(navigator.clipboard?.writeText && window.isSecureContext){
    try{await navigator.clipboard.writeText(String(text||""));return true;}catch{}
  }
  try{
    const ta=document.createElement("textarea");
    ta.value=String(text||"");
    ta.readOnly=true;
    ta.style.cssText="position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta);ta.focus();ta.select();
    const ok=document.execCommand("copy");
    ta.remove();
    return !!ok;
  }catch{return false;}
}

function setPasteState(type,title,detail){
  const p=$("pastePanel");
  p.className="paste"+(type?" "+type:"");
  $("pasteStatus").textContent=type==="success"?"PACKET COMPLETE":type==="error"?"ACTION NEEDED":type==="active"?"READING CLIPBOARD":"MOBILE PASTE RECEIVER";
  $("pasteTitle").textContent=title;
  $("pasteDetail").textContent=detail;
}
function resetPasteSoon(delay=1200){
  setTimeout(()=>setPasteState("","Tap to read clipboard","On HTTPS, one tap reads and routes a CONTEXT_REQUEST, VBA_WRITE, or HTML_OPEN packet. Long-press paste and hardware-keyboard paste still work."),delay);
}
function openManualPaste(prefill=""){
  $("manualPacket").value=prefill;
  $("pasteModal").classList.add("open");
  setTimeout(()=>$('manualPacket').focus(),50);
}
function closeManualPaste(){$("pasteModal").classList.remove("open");}
function fmtMs(ms){return `${Math.max(0,Math.round(ms))} ms`;}
function largePasteGuidance(path){
  return `Full payload copied. On Android, long-press the destination text field and choose Paste; Gboard clipboard history may truncate near 20,000 characters. The full fallback is settling in the background at ${path}.`;
}

async function deliverContextBundle(r){
  const path=`${DIST_DIR}/StickShift-context.md`;
  const portable=r.chars<=CLIPBOARD_PORTABLE_CHARS;
  $("bundleOut").value=r.text;
  $("btnCopy").disabled=!r.text;

  const copyStart=performance.now();
  const copied=await writeClip(r.text);
  const copyMs=performance.now()-copyStart;
  const distJob=scheduleDistWrite(r.text,{label:r.bootstrap?"session bootstrap":"context bundle"});

  const count=r.f+r.m+r.s;
  const size=`${r.chars.toLocaleString()} chars`;
  const mapped=r.bootstrap?`${count} maps + operator skill`:`${count} concepts`;
  const portability=portable?"plain-text portable":"over 20k; native Paste recommended";

  if(copied){
    $("bundleMeter").textContent=`${mapped} · ${size} · clipboard copied in ${fmtMs(copyMs)} · ${portability} · -dist settling in background`;
    if(portable){
      setPasteState("success",r.bootstrap?"Session bootstrap copied":"Context copied",`Clipboard is ready. Full fallback is settling in the background at ${path}.`);
    }else{
      setPasteState("success",r.bootstrap?"Large session bootstrap copied":"Large context copied",largePasteGuidance(path));
    }
    return {portable,copied:true,large:!portable,copyMs,distJob,distPending:true};
  }

  $("bundleMeter").textContent=`${mapped} · ${size} · clipboard unavailable · waiting for -dist fallback`;
  try{
    const settled=await distJob.promise;
    setPasteState("success","Context saved to -dist",`Clipboard copy was unavailable. Full fallback is ready at ${path}.`);
    return {portable,copied:false,large:!portable,copyMs,distJob,distPending:false,distMs:settled.totalMs};
  }catch(error){
    setPasteState("error","Context delivery failed",`Clipboard copy and ${path} fallback both failed.`);
    throw error;
  }
}

