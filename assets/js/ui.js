/* Events */
$("btnSwitch").addEventListener("click",switchContext);
$("btnReconnect").addEventListener("click",()=>reconnectSavedContext(true));
$("btnRefreshDiag").addEventListener("click",()=>{renderRuntime();log("Runtime diagnostics refreshed.","info");});
$("btnCopySkill").addEventListener("click",async()=>{
  const skill=$("stickshift-skill")?.textContent?.trim()||"";
  if(!skill){log("StickShift AI skill is unavailable.","er");return;}
  const copied=await writeClip(skill);
  const btn=$("btnCopySkill");
  if(copied){
    log("StickShift AI skill copied to clipboard.","ok");
    btn.textContent="Skill copied";
    setTimeout(()=>{btn.textContent="Copy AI skill";},1800);
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
  const ok=await writeClip(text);
  log(ok?"Bundle copied to clipboard.":"Clipboard write blocked.","ok");
});
$("btnIndex").addEventListener("click",async()=>{
  if(!requireRoot()) return;
  try{const n=await generateIndexes();log(`Index regenerated: ${n} file(s).`,"ok");}catch(e){log("Index generation failed: "+(e?.message||e),"er");}
});
document.querySelector(".tabs").addEventListener("click",e=>{const b=e.target.closest("button[data-view]");if(b)showView(b.dataset.view);});
$("fileList").addEventListener("click",e=>{
  const row=e.target.closest("[data-path]");
  if(!row) return;
  ACTIVE_PATH=row.dataset.path;EDIT_MODE=false;renderFileList();renderActiveFile();
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
