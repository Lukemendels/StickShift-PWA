const EXPLORER_DIRS=new Map();
const EXPLORER_LOADING_DIRS=new Set();
let EXPLORER_ROOT=null;

function explorerJoin(dir,name){return dir?dir+"/"+name:name;}
function isGeneratedIndexPath(path){
  return String(path||"").split("/").pop().toLowerCase()==="index.md";
}
function explorerReadOnlyPath(path){
  const clean=String(path||"");
  return isGeneratedIndexPath(clean)||clean===DIST_DIR||clean.startsWith(DIST_DIR+"/");
}
function resetExplorerState(){
  EXPLORER_DIRS.clear();
  EXPLORER_LOADING_DIRS.clear();
  FILES.clear();
  ACTIVE_PATH="";
  EDIT_MODE=false;
  EXPANDED_DIRS.clear();
  EXPLORER_ROOT=ROOT;
}
async function loadExplorerDirectory(path=""){
  if(!ROOT) return null;
  const dir=path?await getDirHandle(path,false):ROOT;
  const folders=[],files=[];
  for await(const [name,h] of dir.entries()){
    if(name.startsWith(".")) continue;
    const rel=explorerJoin(path,name);
    if(h.kind==="directory"){
      folders.push({name,path:rel});
    }else if(name.toLowerCase().endsWith(".md")){
      files.push({name,path:rel});
      if(!FILES.has(rel)) FILES.set(rel,null);
    }
  }
  folders.sort((a,b)=>a.name.localeCompare(b.name));
  files.sort((a,b)=>a.name.localeCompare(b.name));
  EXPLORER_DIRS.set(path,{folders,files});
  return EXPLORER_DIRS.get(path);
}
async function refreshFiles({reloadLoaded=false}={}){
  if(!ROOT){
    resetExplorerState();
    renderFileList();
    renderActiveFile();
    return;
  }
  const rootChanged=EXPLORER_ROOT!==ROOT;
  if(rootChanged) resetExplorerState();

  try{
    const previouslyLoaded=reloadLoaded?[...EXPLORER_DIRS.keys()]:[];
    if(rootChanged||!EXPLORER_DIRS.has("")){
      $("fileList").innerHTML='<div class="file-row empty-row">Loading workspace…</div>';
      await loadExplorerDirectory("");
    }else if(reloadLoaded){
      const paths=previouslyLoaded.length?previouslyLoaded:[""];
      EXPLORER_DIRS.clear();
      FILES.clear();
      await Promise.all(paths.map(async path=>{
        try{await loadExplorerDirectory(path);}catch(e){
          if(path==="") throw e;
          EXPANDED_DIRS.delete(path);
        }
      }));
      if(!EXPLORER_DIRS.has("")) await loadExplorerDirectory("");
    }
    renderFileList();
    if(ACTIVE_PATH){
      if(FILES.has(ACTIVE_PATH)) renderActiveFile();
      else{ACTIVE_PATH="";EDIT_MODE=false;renderActiveFile();}
    }
  }catch(e){
    $("fileList").innerHTML='<div class="file-row empty-row">Workspace load failed.</div>';
    log("File refresh failed: "+(e?.message||e),"er");
  }
}
function invalidateGeneratedExplorerFiles(){
  for(const path of FILES.keys()){
    if(isGeneratedIndexPath(path)) FILES.set(path,null);
  }
}
function expandActiveAncestors(){
  if(!ACTIVE_PATH) return;
  const parts=ACTIVE_PATH.split("/").filter(Boolean);
  parts.pop();
  let current="";
  for(const part of parts){
    current=current?current+"/"+part:part;
    EXPANDED_DIRS.add(current);
  }
}
function renderFileList(){
  const el=$("fileList");
  if(!ROOT){
    el.innerHTML='<div class="file-row empty-row">Engage a context to browse files.</div>';
    return;
  }
  const root=EXPLORER_DIRS.get("");
  if(!root){
    el.innerHTML='<div class="file-row empty-row">Loading workspace…</div>';
    return;
  }

  const rows=[];
  function renderDirectory(path,depth){
    const record=EXPLORER_DIRS.get(path);
    if(!record){
      rows.push(`<div class="file-row empty-row" style="--depth:${depth}">Loading folder…</div>`);
      return;
    }

    for(const folder of record.folders){
      const expanded=EXPANDED_DIRS.has(folder.path);
      const loading=EXPLORER_LOADING_DIRS.has(folder.path);
      const system=folder.path===DIST_DIR||folder.path.startsWith(DIST_DIR+"/");
      rows.push(`<div class="file-row folder-row${system?" system":""}" data-folder="${escapeHtml(folder.path)}" role="button" tabindex="0" aria-expanded="${expanded}" style="--depth:${depth}"><span class="tree-caret" aria-hidden="true">${expanded?"▾":"▸"}</span><span class="tree-name">${escapeHtml(folder.name)}${loading?" · loading…":""}</span></div>`);
      if(expanded){
        if(EXPLORER_DIRS.has(folder.path)) renderDirectory(folder.path,depth+1);
        else rows.push(`<div class="file-row empty-row" style="--depth:${depth+1}">Loading folder…</div>`);
      }
    }

    for(const file of record.files){
      const generated=isGeneratedIndexPath(file.path);
      const system=generated||file.path.startsWith(DIST_DIR+"/");
      const label=generated?`${file.name} · generated map`:file.name;
      rows.push(`<div class="file-row file-node${file.path===ACTIVE_PATH?" active":""}${system?" system":""}" data-path="${escapeHtml(file.path)}" role="button" tabindex="0" style="--depth:${depth}"${generated?' title="Generated discovery map — read only"':""}><span class="tree-spacer" aria-hidden="true"></span><span class="tree-name">${escapeHtml(label)}</span></div>`);
    }
  }

  renderDirectory("",0);
  if(!rows.length) rows.push('<div class="file-row empty-row">No Markdown files or folders found.</div>');
  el.innerHTML=rows.join("");
}
async function toggleExplorerFolder(path){
  if(EXPANDED_DIRS.has(path)){
    EXPANDED_DIRS.delete(path);
    renderFileList();
    return;
  }
  EXPANDED_DIRS.add(path);
  if(EXPLORER_DIRS.has(path)){
    renderFileList();
    return;
  }

  EXPLORER_LOADING_DIRS.add(path);
  renderFileList();
  try{
    await loadExplorerDirectory(path);
  }catch(e){
    EXPANDED_DIRS.delete(path);
    log(`Folder load failed (${path}): ${e?.message||e}`,"er");
  }finally{
    EXPLORER_LOADING_DIRS.delete(path);
    renderFileList();
  }
}
function renderActiveFile(){
  $("editorPath").textContent=ACTIVE_PATH||"No file selected";
  $("btnEdit").disabled=!ACTIVE_PATH||explorerReadOnlyPath(ACTIVE_PATH);
  if(!ACTIVE_PATH||!FILES.has(ACTIVE_PATH)){
    $("editorBody").innerHTML='<div class="preview">Select a Markdown file.</div>';
    $("btnSaveFile").hidden=true;EDIT_MODE=false;return;
  }

  const content=FILES.get(ACTIVE_PATH);
  if(content===null){
    $("editorBody").innerHTML='<div class="preview">Loading file…</div>';
    $("btnSaveFile").hidden=true;
    return;
  }

  if(EDIT_MODE){
    $("editorBody").innerHTML='<textarea id="fileEditor"></textarea>';
    $("fileEditor").value=content;
    $("btnSaveFile").hidden=false;$("btnEdit").textContent="Cancel";
  }else{
    $("editorBody").innerHTML='<div class="preview"></div>';
    $("editorBody").firstElementChild.textContent=content;
    $("btnSaveFile").hidden=true;$("btnEdit").textContent="Edit";
  }
}
async function selectExplorerFile(path){
  ACTIVE_PATH=path;
  EDIT_MODE=false;
  expandActiveAncestors();
  renderFileList();
  renderActiveFile();
  if(FILES.get(path)!==null) return;

  try{
    const content=await readFile(path);
    FILES.set(path,content);
    if(ACTIVE_PATH===path) renderActiveFile();
  }catch(e){
    if(ACTIVE_PATH===path){
      $("editorBody").innerHTML='<div class="preview">File load failed.</div>';
    }
    log(`File load failed (${path}): ${e?.message||e}`,"er");
  }
}
async function saveActiveFile(){
  if(!ACTIVE_PATH||!EDIT_MODE) return;
  try{
    const text=$("fileEditor").value;
    const path=ACTIVE_PATH;
    await writeFile(path,text);
    FILES.set(path,text);
    log(`Saved ${path}.`,"ok");
    EDIT_MODE=false;

    await updateIndexesForWrites([{rel:path,content:text,existed:true}]);
    invalidateGeneratedExplorerFiles();
    await refreshFiles({reloadLoaded:true});
    ACTIVE_PATH=path;
    if(FILES.has(path)) FILES.set(path,text);
    expandActiveAncestors();
    renderFileList();
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
