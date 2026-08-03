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
  try{
    const n=await generateIndexes();
    log(`Indexes regenerated: ${n} qualifying map file(s). Empty directory links removed.`,"ok");
    await refreshFiles();
  }catch(e){log("Index generation failed: "+(e?.message||e),"er");}
});
document.querySelector(".tabs").addEventListener("click",e=>{const b=e.target.closest("button[data-view]");if(b)showView(b.dataset.view);});
$("fileList").addEventListener("click",e=>{
  const folder=e.target.closest("[data-folder]");
  if(folder){toggleExplorerFolder(folder.dataset.folder);return;}
  const row=e.target.closest("[data-path]");
  if(!row) return;
  ACTIVE_PATH=row.dataset.path;EDIT_MODE=false;expandActiveAncestors();renderFileList();renderActiveFile();
});
$("fileList").addEventListener("keydown",e=>{
  if(e.key!=="Enter"&&e.key!==" ") return;
  const folder=e.target.closest("[data-folder]");
  const row=e.target.closest("[data-path]");
  if(!folder&&!row) return;
  e.preventDefault();
  if(folder){toggleExplorerFolder(folder.dataset.folder);return;}
  ACTIVE_PATH=row.dataset.path;EDIT_MODE=false;expandActiveAncestors();renderFileList();renderActiveFile();
});
$("btnRefreshFiles").addEventListener("click",refreshFiles);
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
