const CLIPBOARD_SAFE_CHARS = 18000;

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
function resetPasteSoon(){
  setTimeout(()=>setPasteState("","Tap to read clipboard","On HTTPS, one tap reads and routes a CONTEXT_REQUEST, VBA_WRITE, or HTML_OPEN packet. Long-press paste and hardware-keyboard paste still work."),3200);
}
function openManualPaste(prefill=""){
  $("manualPacket").value=prefill;
  $("pasteModal").classList.add("open");
  setTimeout(()=>$('manualPacket').focus(),50);
}
function closeManualPaste(){$("pasteModal").classList.remove("open");}
function fmtMs(ms){return `${Math.max(0,Math.round(ms))} ms`;}

async function deliverContextBundle(r){
  const path=`${DIST_DIR}/StickShift-context.md`;
  const safe=r.chars<=CLIPBOARD_SAFE_CHARS;
  $("bundleOut").value=r.text;
  $("btnCopy").disabled=!safe;

  let copied=false,copyMs=0,distMs=0;
  if(safe){
    const copyStart=performance.now();
    copied=await writeClip(r.text);
    copyMs=performance.now()-copyStart;

    if(copied){
      $("bundleMeter").textContent=`${r.f+r.m+r.s} concepts · ${r.chars.toLocaleString()} chars · copied · saving -dist backup…`;
      setPasteState("success","Context copied",`Copied to clipboard. Saving a backup to ${path}.`);
    }else{
      $("bundleMeter").textContent=`${r.f+r.m+r.s} concepts · ${r.chars.toLocaleString()} chars · clipboard unavailable · saving to -dist…`;
      setPasteState("","Clipboard copy unavailable",`Saving to ${path}; you can use that file or tap Copy again.`);
    }

    const distStart=performance.now();
    await writeFile(path,r.text);
    distMs=performance.now()-distStart;
    $("bundleMeter").textContent=`${r.f+r.m+r.s} concepts · ${r.chars.toLocaleString()} chars · ${copied?"clipboard copied · ":""}backup saved to ${path}`;
    if(!copied) setPasteState("success","Context saved to -dist",`Clipboard copy was unavailable. Use ${path} as the context packet, or tap Copy again.`);
  }else{
    const distStart=performance.now();
    await writeFile(path,r.text);
    distMs=performance.now()-distStart;
    $("bundleMeter").textContent=`${r.f+r.m+r.s} concepts · ${r.chars.toLocaleString()} chars · overflow · ${path}`;
    setPasteState("success","Context exceeds clipboard-safe size",`Saved to ${path}. Use that file as the context packet.`);
  }

  return {safe,copied,overflow:!safe,copyMs,distMs};
}

async function readClipboardAndRoute(){
  const startedAt=performance.now();
  setPasteState("active","Reading clipboard…","StickShift will only act on a recognized packet.");
  if(navigator.clipboard?.readText && window.isSecureContext){
    try{
      const readStart=performance.now();
      const text=(await navigator.clipboard.readText()).trim();
      const clipboardReadMs=performance.now()-readStart;
      if(!text){openManualPaste();setPasteState("","Clipboard was empty","Paste the packet manually.");return;}
      await routePacket(text,{startedAt,clipboardReadMs});
      return;
    }catch(e){
      log("Direct clipboard read unavailable: "+(e?.message||e),"amb");
    }
  }
  openManualPaste();
  setPasteState("","Manual paste needed","Long-press in the sheet and paste the packet.");
}

async function routePacket(text,timing={}){
  text=String(text||"").trim();
  if(!text){setPasteState("error","No packet found","Paste or copy a StickShift packet first.");resetPasteSoon();return;}
  if(text.includes("<VBA_WRITE>")){
    if(!requireRoot()){setPasteState("error","Context not engaged","Switch context first.");resetPasteSoon();return;}
    const writeStartedAt=Number.isFinite(timing.startedAt)?timing.startedAt:performance.now();
    const parseStart=performance.now();
    const env=parseWriteEnvelope(text);
    const parseMs=performance.now()-parseStart;
    if(env.error){setPasteState("error","Write parse error",env.error);log(env.error,"er");resetPasteSoon();return;}

    let r;
    try{
      r=await applyWrite(env);
    }catch(e){
      setPasteState("error","Write failed",e?.message||String(e));
      log("Write failed: "+(e?.message||e),"er");
      resetPasteSoon();return;
    }

    const ackMs=performance.now()-writeStartedAt;
    $("writeMeter").textContent=`${r.written} written · finishing maintenance…`;
    setPasteState("success",`Written ${r.written} file${r.written===1?"":"s"}`,`File write complete in ${fmtMs(ackMs)}. Finishing audit + affected indexes…`);
    log(`VBA_WRITE files written: ${r.written} written, ${r.skipped} skipped · acknowledged in ${fmtMs(ackMs)}.`,"ok");

    // Yield one frame so the operator sees the durable-write acknowledgment before maintenance continues.
    await new Promise(resolve=>requestAnimationFrame(resolve));

    try{
      const auditMs=await appendWriteAudit(r.writes);
      const indexStart=performance.now();
      const indexResult=await updateIndexesForWrites(r.writes);
      const indexMs=performance.now()-indexStart;
      const totalMs=performance.now()-writeStartedAt;
      const readPart=Number.isFinite(timing.clipboardReadMs)?`read ${fmtMs(timing.clipboardReadMs)} · `:"";
      const wt=r.timing||{};
      log(`Write timing: ${readPart}parse ${fmtMs(parseMs)} · primary ${fmtMs(wt.totalMs||0)} (exists ${fmtMs(wt.existsMs||0)} · files ${fmtMs(wt.fileWriteMs||0)}) · ack ${fmtMs(ackMs)} · audit ${fmtMs(auditMs)} · indexes ${fmtMs(indexMs)} (${indexResult.mode}) · refresh deferred · total ${fmtMs(totalMs)}.`,"info");
      $("writeMeter").textContent=`${r.written} written · ${fmtMs(ackMs)} ack · ${fmtMs(totalMs)} settled`;
      setPasteState("success",`Written ${r.written} file${r.written===1?"":"s"}`,`Maintenance complete: ${indexResult.count} affected index${indexResult.count===1?"":"es"} updated.`);
      log(`VBA_WRITE maintenance complete: ${indexResult.count} index${indexResult.count===1?"":"es"} updated (${indexResult.mode}).`,"ok");
    }catch(e){
      const totalMs=performance.now()-writeStartedAt;
      $("writeMeter").textContent=`${r.written} written · ${fmtMs(ackMs)} ack · maintenance incomplete`;
      setPasteState("error","File written; maintenance incomplete",e?.message||String(e));
      log(`File write succeeded in ${fmtMs(ackMs)}, but maintenance failed after ${fmtMs(totalMs)}: ${e?.message||e}`,"er");
    }
    resetPasteSoon();return;
  }
  if(text.includes("<CONTEXT_REQUEST>")){
    if(!requireRoot()){setPasteState("error","Context not engaged","Switch context first.");resetPasteSoon();return;}
    try{
      const req=parseContextRequest(text);
      const buildStart=performance.now();
      const r=await buildBundleFromRequest(req);
      const buildMs=performance.now()-buildStart;
      const delivery=await deliverContextBundle(r);
      const totalMs=timing.startedAt?performance.now()-timing.startedAt:buildMs+delivery.copyMs+delivery.distMs;
      const readPart=Number.isFinite(timing.clipboardReadMs)?`read ${fmtMs(timing.clipboardReadMs)} · `:"";
      const copyPart=delivery.safe?`clip ${fmtMs(delivery.copyMs)} · `:"clip skipped · ";
      log(`Context timing: ${readPart}build ${fmtMs(buildMs)} · ${copyPart}-dist ${fmtMs(delivery.distMs)} · total ${fmtMs(totalMs)}.`,"info");
      log(`CONTEXT_REQUEST built: ${r.f+r.m+r.s} concepts.`,"ok");
      if(!delivery.overflow) resetPasteSoon();
    }catch(e){
      setPasteState("error","Build failed",e?.message||String(e));log("Build failed: "+(e?.message||e),"er");resetPasteSoon();
    }
    return;
  }
  if(text.includes("<HTML_OPEN>")){
    setPasteState("success","HTML_OPEN recognized","Tool launching remains a deliberate approval step; this mobile runtime test does not auto-open a tool from clipboard.");
    log("HTML_OPEN packet recognized; no tool was opened automatically.","amb");
    resetPasteSoon();return;
  }
  setPasteState("error","Unrecognized packet","Expected CONTEXT_REQUEST, VBA_WRITE, or HTML_OPEN.");
  log("Clipboard ignored: no supported StickShift packet detected.","amb");
  resetPasteSoon();
}

async function doBuild(){
  if(!requireRoot()) return;
  try{
    const buildStart=performance.now();
    const r=await buildIndexBundle();
    const buildMs=performance.now()-buildStart;
    const delivery=await deliverContextBundle(r);
    log(`Index timing: build ${fmtMs(buildMs)} · ${delivery.safe?`clip ${fmtMs(delivery.copyMs)}`:"clip skipped"} · -dist ${fmtMs(delivery.distMs)}.`,"info");
    log(`Index bundle built${delivery.copied?" and copied":delivery.overflow?" to -dist overflow":""}.`,"ok");
  }catch(e){log("Bundle build failed: "+(e?.message||e),"er");}
}

async function refreshFiles(){
  if(!ROOT){
    FILES.clear();renderFileList();return;
  }
  try{
    FILES=await walkMarkdown({includeSystem:true});
    renderFileList();
    if(ACTIVE_PATH && FILES.has(ACTIVE_PATH)) renderActiveFile();
    else if(ACTIVE_PATH){ACTIVE_PATH="";renderActiveFile();}
  }catch(e){log("File refresh failed: "+(e?.message||e),"er");}
}
function renderFileList(){
  const el=$("fileList");
  if(!ROOT){el.innerHTML='<div class="file-row">Engage a context to browse files.</div>';return;}
  const paths=[...FILES.keys()].sort();
  if(!paths.length){el.innerHTML='<div class="file-row">No Markdown files found.</div>';return;}
  el.innerHTML=paths.map(p=>`<div class="file-row${p===ACTIVE_PATH?" active":""}${p.startsWith(DIST_DIR+"/")?" system":""}" data-path="${escapeHtml(p)}">${escapeHtml(p)}</div>`).join("");
}
function renderActiveFile(){
  $("editorPath").textContent=ACTIVE_PATH||"No file selected";
  $("btnEdit").disabled=!ACTIVE_PATH||ACTIVE_PATH.startsWith(DIST_DIR+"/");
  if(!ACTIVE_PATH||!FILES.has(ACTIVE_PATH)){
    $("editorBody").innerHTML='<div class="preview">Select a Markdown file.</div>';
    $("btnSaveFile").hidden=true;EDIT_MODE=false;return;
  }
  if(EDIT_MODE){
    $("editorBody").innerHTML='<textarea id="fileEditor"></textarea>';
    $("fileEditor").value=FILES.get(ACTIVE_PATH);
    $("btnSaveFile").hidden=false;$("btnEdit").textContent="Cancel";
  }else{
    $("editorBody").innerHTML='<div class="preview"></div>';
    $("editorBody").firstElementChild.textContent=FILES.get(ACTIVE_PATH);
    $("btnSaveFile").hidden=true;$("btnEdit").textContent="Edit";
  }
}
async function saveActiveFile(){
  if(!ACTIVE_PATH||!EDIT_MODE) return;
  try{
    const text=$("fileEditor").value;
    await writeFile(ACTIVE_PATH,text);
    log(`Saved ${ACTIVE_PATH}.`,"ok");
    EDIT_MODE=false;
    await generateIndexes();
    await refreshFiles();
    renderActiveFile();
  }catch(e){log("File save failed: "+(e?.message||e),"er");}
}

function showView(view){
  for(const name of ["console","explorer","diagnostics"]){
    $("view"+name[0].toUpperCase()+name.slice(1)).hidden=name!==view;
  }
  document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("on",b.dataset.view===view));
  if(view==="explorer") refreshFiles();
  if(view==="diagnostics") renderDiagnostics();
}
