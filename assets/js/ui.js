/* Events */
$("btnSwitch").addEventListener("click",switchContext);
$("btnReconnect").addEventListener("click",()=>reconnectSavedContext(true));
$("btnRefreshDiag").addEventListener("click",()=>{renderRuntime();log("Runtime diagnostics refreshed.","info");});
$("btnCopySkill").addEventListener("click",async()=>{
  const skill=$("stickshift-skill")?.textContent?.trim()||"";
  if(!skill){log("StickShift Operator skill is unavailable.","er");return;}
  const copied=await writeClip(skill);
  const btn=$("btnCopySkill");
  if(copied){
    log("Embedded StickShift Operator skill copied to clipboard.","ok");
    btn.textContent="Operator skill copied";
    setTimeout(()=>{btn.textContent="Copy embedded Operator skill";},1800);
  }else{
    log("Clipboard copy was blocked. Try again from the installed HTTPS app.","amb");
  }
});
$("pastePanel").addEventListener("click",readClipboardAndRoute);
$("pastePanel").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();readClipboardAndRoute();}});
$("pastePanel").addEventListener("paste",e=>{
  const text=(e.clipboardData||window.clipboardData)?.getData("text/plain")||"";
  if(text){e.preventDefault();routePacket(text);}
});
$("btnManualPaste").addEventListener("click",()=>openManualPaste());
$("btnPasteCancel").addEventListener("click",closeManualPaste);
$("btnPasteRoute").addEventListener("click",async()=>{const text=$("manualPacket").value;closeManualPaste();await routePacket(text);});
$("pasteModal").addEventListener("click",e=>{if(e.target===$("pasteModal")) closeManualPaste();});
$("btnBuild").addEventListener("click",doBuild);
$("btnCopy").addEventListener("click",async()=>{
  const text=$("bundleOut").value;
  if(!text) return;
  const ok=await writeClip(text);
  if(ok&&text.length>CLIPBOARD_PORTABLE_CHARS){
    setPasteState("success","Large context copied",largePasteGuidance(`${DIST_DIR}/StickShift-context.md`));
    log("Large bundle copied. Use Android native long-press Paste rather than Gboard clipboard history.","amb");
  }else{
    log(ok?"Bundle copied to clipboard.":"Clipboard write blocked.",ok?"ok":"amb");
  }
});
$("btnIndex").addEventListener("click",async()=>{
  if(!requireRoot()) return;
  const button=$("btnIndex");
  const idleLabel="Regenerate indexes";
  const started=performance.now();
  button.disabled=true;
  button.textContent="Regenerating…";
  $("writeMeter").textContent="Scanning workspace…";
  log("Manual index regeneration started.","info");

  if(typeof setIndexProgressHandler==="function"){
    setIndexProgressHandler(progress=>{
      if(progress.stage==="scan"){
        $("writeMeter").textContent=`Scanning… ${progress.directories} folder${progress.directories===1?"":"s"} · ${progress.concepts} concept${progress.concepts===1?"":"s"}`;
      }else if(progress.stage==="write"){
        $("writeMeter").textContent=`Writing maps… ${progress.processed}/${progress.total} folders · ${progress.updated} updated · ${progress.unchanged} unchanged`;
      }else if(progress.stage==="aggregate"){
        $("writeMeter").textContent="Maps current · rebuilding aggregate cache…";
      }
    });
  }

  try{
    const n=await generateIndexes();
    const elapsed=performance.now()-started;
    const stats=typeof LAST_INDEX_REGEN_STATS!=="undefined"?LAST_INDEX_REGEN_STATS:null;
    const detail=stats
      ?`${stats.updated} updated · ${stats.unchanged} unchanged${stats.removed?` · ${stats.removed} removed`:""}`
      :"generation complete";
    const status=`Indexes current · ${n} map file${n===1?"":"s"} · ${detail} · ${fmtMs(elapsed)} · ${stampNow()}`;
    $("writeMeter").textContent=status;
    log(`Indexes regenerated: ${n} qualifying map file(s) · ${detail} · ${fmtMs(elapsed)} total.`,"ok");
    invalidateGeneratedExplorerFiles();
    if(!$("viewExplorer").hidden) await refreshFiles({reloadLoaded:true});
    button.textContent="Indexes current";
    setTimeout(()=>{button.textContent=idleLabel;button.disabled=!ROOT;},1400);
  }catch(e){
    const elapsed=performance.now()-started;
    $("writeMeter").textContent=`Index regeneration failed · ${fmtMs(elapsed)} · ${e?.message||e}`;
    log("Index generation failed: "+(e?.message||e),"er");
    button.textContent=idleLabel;
    button.disabled=!ROOT;
  }finally{
    if(typeof setIndexProgressHandler==="function") setIndexProgressHandler(null);
  }
});
document.querySelector(".tabs").addEventListener("click",e=>{const b=e.target.closest("button[data-view]");if(b)showView(b.dataset.view);});
$("fileList").addEventListener("click",async e=>{
  const folder=e.target.closest("[data-folder]");
  if(folder){await toggleExplorerFolder(folder.dataset.folder);return;}
  const row=e.target.closest("[data-path]");
  if(!row) return;
  await selectExplorerFile(row.dataset.path);
});
$("fileList").addEventListener("keydown",async e=>{
  if(e.key!=="Enter"&&e.key!==" ") return;
  const folder=e.target.closest("[data-folder]");
  const row=e.target.closest("[data-path]");
  if(!folder&&!row) return;
  e.preventDefault();
  if(folder){await toggleExplorerFolder(folder.dataset.folder);return;}
  await selectExplorerFile(row.dataset.path);
});
$("btnRefreshFiles").addEventListener("click",()=>refreshFiles({reloadLoaded:true}));
$("btnEdit").addEventListener("click",()=>{
  if(!ACTIVE_PATH) return;
  EDIT_MODE=!EDIT_MODE;renderActiveFile();
});
$("btnSaveFile").addEventListener("click",saveActiveFile);

window.addEventListener("DOMContentLoaded",async()=>{
  renderRuntime();
  log("StickShift mobile/HTTPS runtime loaded.","info");
  if(!window.isSecureContext) log("Not running in a secure context; use HTTPS for the full folder + clipboard path.","amb");
  if(typeof window.showDirectoryPicker!=="function") log("showDirectoryPicker() is not available in this runtime.","amb");
  await reconnectSavedContext(false);
});
