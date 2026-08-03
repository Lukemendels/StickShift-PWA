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
    if(!requireRoot()){setPasteState("error","Context not engaged","Select context first.");resetPasteSoon();return;}
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
    if(!requireRoot()){setPasteState("error","Context not engaged","Select context first.");resetPasteSoon();return;}
    try{
      const req=parseContextRequest(text);
      const buildStart=performance.now();
      const r=await buildBundleFromRequest(req);
      const buildMs=performance.now()-buildStart;
      const delivery=await deliverContextBundle(r);
      const ackMs=timing.startedAt?performance.now()-timing.startedAt:buildMs+delivery.copyMs+(delivery.distMs||0);
      const readPart=Number.isFinite(timing.clipboardReadMs)?`read ${fmtMs(timing.clipboardReadMs)} · `:"";
      const mapPart=r.indexReadMode?`map ${fmtMs(r.mapReadMs||0)} (${r.indexReadMode}, ${r.indexFiles||0} files) · `:"";
      const copyPart=delivery.copied?`clip ${fmtMs(delivery.copyMs)} · `:"clip unavailable · ";
      log(`Context timing: ${readPart}${mapPart}build ${fmtMs(buildMs)} · ${copyPart}foreground ack ${fmtMs(ackMs)} · -dist background #${delivery.distJob.sequence}.`,"info");
      if(r.fallbackReason) log(`Generated-map fast path unavailable: ${r.fallbackReason}. Used legacy corpus scan.`,"amb");
      log(`CONTEXT_REQUEST built: ${r.f+r.m+r.s} concepts${r.gated?` · ${r.gated} gated map${r.gated===1?"":"s"}`:""}.`,"ok");
      resetPasteSoon(900);
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
  const button=$("btnBuild");
  const idleLabel="Start chat with context";
  button.disabled=true;
  button.textContent="Building bootstrap…";
  try{
    const buildStart=performance.now();
    const r=await buildSessionBootstrap();
    const buildMs=performance.now()-buildStart;
    const delivery=await deliverContextBundle(r);
    const ackMs=performance.now()-buildStart;
    const copyPart=delivery.copied?`clip ${fmtMs(delivery.copyMs)}`:"clip unavailable";
    log(`Bootstrap timing: map ${fmtMs(r.mapReadMs||0)} (${r.indexReadMode||"unknown"}, ${r.indexFiles||0} files) · assemble+delivery ${fmtMs(buildMs)} · ${copyPart} · foreground ack ${fmtMs(ackMs)} · -dist background #${delivery.distJob.sequence}.`,"info");
    if(r.fallbackReason) log(`Generated-map fast path unavailable: ${r.fallbackReason}. Used legacy corpus scan.`,"amb");
    log(`Session bootstrap built: ${r.m} maps${r.gated?` · ${r.gated} gated`:""} · operator skill included.`,"ok");
    button.textContent=delivery.copied?"Bootstrap copied":"Bootstrap saved";
    button.disabled=!ROOT;
    resetPasteSoon(900);
    setTimeout(()=>{button.textContent=idleLabel;button.disabled=!ROOT;},1200);
  }catch(e){
    log("Bootstrap build failed: "+(e?.message||e),"er");
    button.textContent=idleLabel;
    button.disabled=!ROOT;
  }
}

