let EXPLORER_EXPANDED_ROOT=null;

async function refreshFiles(){
  if(!ROOT){
    FILES.clear();renderFileList();return;
  }
  try{
    FILES=await walkMarkdown({includeSystem:true});
    expandActiveAncestors();
    renderFileList();
    if(ACTIVE_PATH && FILES.has(ACTIVE_PATH)) renderActiveFile();
    else if(ACTIVE_PATH){ACTIVE_PATH="";EDIT_MODE=false;renderActiveFile();}
  }catch(e){log("File refresh failed: "+(e?.message||e),"er");}
}
function explorerVisiblePaths(){
  return [...FILES.keys()].sort((a,b)=>a.localeCompare(b));
}
function isGeneratedIndexPath(path){
  return String(path||"").split("/").pop().toLowerCase()==="index.md";
}
function explorerReadOnlyPath(path){
  const clean=String(path||"");
  return isGeneratedIndexPath(clean)||clean===DIST_DIR||clean.startsWith(DIST_DIR+"/");
}
function buildExplorerTree(paths){
  const root={folders:new Map(),files:[]};
  for(const path of paths){
    const parts=path.split("/").filter(Boolean);
    const file=parts.pop();
    let node=root;
    let prefix="";
    for(const folder of parts){
      prefix=prefix?prefix+"/"+folder:folder;
      if(!node.folders.has(folder)) node.folders.set(folder,{path:prefix,folders:new Map(),files:[]});
      node=node.folders.get(folder);
    }
    node.files.push({name:file,path});
  }
  return root;
}
function expandExplorerTree(tree){
  function rec(node){
    for(const folder of node.folders.values()){
      EXPANDED_DIRS.add(folder.path);
      rec(folder);
    }
  }
  rec(tree);
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
  if(!ROOT){el.innerHTML='<div class="file-row empty-row">Engage a context to browse files.</div>';return;}
  const paths=explorerVisiblePaths();
  if(!paths.length){el.innerHTML='<div class="file-row empty-row">No Markdown files found.</div>';return;}

  expandActiveAncestors();
  const tree=buildExplorerTree(paths);
  if(EXPLORER_EXPANDED_ROOT!==ROOT){
    EXPANDED_DIRS.clear();
    expandExplorerTree(tree);
    expandActiveAncestors();
    EXPLORER_EXPANDED_ROOT=ROOT;
  }
  const rows=[];
  function renderNode(node,depth){
    for(const [name,folder] of [...node.folders.entries()].sort(([a],[b])=>a.localeCompare(b))){
      const expanded=EXPANDED_DIRS.has(folder.path);
      const system=folder.path===DIST_DIR||folder.path.startsWith(DIST_DIR+"/");
      rows.push(`<div class="file-row folder-row${system?" system":""}" data-folder="${escapeHtml(folder.path)}" role="button" tabindex="0" aria-expanded="${expanded}" style="--depth:${depth}"><span class="tree-caret" aria-hidden="true">${expanded?"▾":"▸"}</span><span class="tree-name">${escapeHtml(name)}</span></div>`);
      if(expanded) renderNode(folder,depth+1);
    }
    for(const file of node.files.sort((a,b)=>a.name.localeCompare(b.name))){
      const generated=isGeneratedIndexPath(file.path);
      const system=generated||file.path.startsWith(DIST_DIR+"/");
      const label=generated?`${file.name} · generated map`:file.name;
      rows.push(`<div class="file-row file-node${file.path===ACTIVE_PATH?" active":""}${system?" system":""}" data-path="${escapeHtml(file.path)}" role="button" tabindex="0" style="--depth:${depth}"${generated?' title="Generated discovery map — read only"':""}><span class="tree-spacer" aria-hidden="true"></span><span class="tree-name">${escapeHtml(label)}</span></div>`);
    }
  }
  renderNode(tree,0);
  el.innerHTML=rows.join("");
}
function toggleExplorerFolder(path){
  if(EXPANDED_DIRS.has(path)) EXPANDED_DIRS.delete(path);
  else EXPANDED_DIRS.add(path);
  renderFileList();
}
function renderActiveFile(){
  $("editorPath").textContent=ACTIVE_PATH||"No file selected";
  $("btnEdit").disabled=!ACTIVE_PATH||explorerReadOnlyPath(ACTIVE_PATH);
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
