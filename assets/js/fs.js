async function getDirHandleFrom(root,path,create=false){
  let dir=root;
  for(const part of String(path||"").split("/").filter(Boolean)){
    dir=await dir.getDirectoryHandle(part,{create});
  }
  return dir;
}
async function getDirHandle(path,create=false){return getDirHandleFrom(ROOT,path,create);}
async function getFileHandleFrom(root,path,create=false){
  const parts=String(path||"").split("/").filter(Boolean);
  let dir=root;
  for(let i=0;i<parts.length-1;i++) dir=await dir.getDirectoryHandle(parts[i],{create});
  return dir.getFileHandle(parts[parts.length-1],{create});
}
async function getFileHandle(path,create=false){return getFileHandleFrom(ROOT,path,create);}
async function readFile(path){
  const fh=await getFileHandle(path,false);
  return (await fh.getFile()).text();
}
async function writeFileAtRoot(root,path,content){
  const fh=await getFileHandleFrom(root,path,true);
  const w=await fh.createWritable();
  await w.write(String(content??""));
  await w.close();
}
async function writeFile(path,content){return writeFileAtRoot(ROOT,path,content);}
async function removeFile(path){
  const parts=String(path||"").split("/").filter(Boolean);
  const name=parts.pop();
  if(!name) return false;
  const dir=await getDirHandle(parts.join("/"),false);
  try{await dir.removeEntry(name);return true;}catch(e){
    if(e?.name==="NotFoundError") return false;
    throw e;
  }
}
async function appendFile(path,content,initial=""){
  const fh=await getFileHandle(path,true);
  const f=await fh.getFile();
  const w=await fh.createWritable({keepExistingData:true});
  if(f.size===0 && initial){
    await w.write(String(initial)+String(content??""));
  }else{
    await w.seek(f.size);
    await w.write(String(content??""));
  }
  await w.close();
}
async function fileExists(path){
  try{await getFileHandle(path,false);return true;}catch{return false;}
}

async function walkMarkdownPaths({includeSystem=false}={}){
  const paths=[];
  async function rec(dir,prefix){
    for await(const [name,h] of dir.entries()){
      if(name.startsWith(".")) continue;
      if(h.kind==="directory"){
        if(!includeSystem && isSystemDir(name)) continue;
        await rec(h,prefix?prefix+"/"+name:name);
      }else if(name.toLowerCase().endsWith(".md")){
        paths.push(prefix?prefix+"/"+name:name);
      }
    }
  }
  await rec(ROOT,"");
  return paths;
}

async function walkMarkdown({includeSystem=false}={}){
  const map=new Map();
  async function rec(dir,prefix){
    for await(const [name,h] of dir.entries()){
      if(name.startsWith(".")) continue;
      if(h.kind==="directory"){
        if(!includeSystem && isSystemDir(name)) continue;
        await rec(h,prefix?prefix+"/"+name:name);
      }else if(name.toLowerCase().endsWith(".md")){
        const rel=prefix?prefix+"/"+name:name;
        map.set(rel,await (await h.getFile()).text());
      }
    }
  }
  await rec(ROOT,"");
  return map;
}

function parseFrontmatter(content){
  const out={};
  const lines=String(content||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
  if(lines[0]?.trim()!=="---") return out;
  for(let i=1;i<lines.length;i++){
    const s=lines[i].trim();
    if(s==="---") break;
    const c=s.indexOf(":");
    if(c>0){
      const k=s.slice(0,c).trim().toLowerCase();
      let v=s.slice(c+1).trim();
      if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'"))) v=v.slice(1,-1);
      out[k]=v;
    }
  }
  return out;
}
function entryLine(name,content){
  const fm=parseFrontmatter(content);
  return `* [${fm.title||name.replace(/\.md$/i,"")}](${name})${fm.description?" - "+fm.description:""}`;
}

const GENERATED_INDEX_SCHEMA = "2";

function isFolderGated(conceptEntries){
  return conceptEntries.some(([,content])=>{
    const fm=parseFrontmatter(content);
    return String(fm.discovery||"").toLowerCase()==="gated" &&
      String(fm.discovery_scope||"").toLowerCase()==="folder";
  });
}
function generatedIndexFrontmatter(gated=false){
  let out=`---\nokf_version: "${OKF_VERSION}"\nstickshift_index_schema: "${GENERATED_INDEX_SCHEMA}"\n`;
  if(gated) out+="discovery: gated\ndiscovery_scope: folder\n";
  return out+="---\n\n";
}
async function readConceptEntries(dirPath,names){
  return Promise.all(names.map(async name=>{
    const path=dirPath?dirPath+"/"+name:name;
    return [name,await readFile(path)];
  }));
}
function renderGeneratedIndex(dirPath,conceptEntries,childNames){
  const gated=!!dirPath&&isFolderGated(conceptEntries);
  let out=generatedIndexFrontmatter(gated);
  for(const [name,content] of conceptEntries) out+=entryLine(name,content)+"\n";
  if(conceptEntries.length) out+="\n";
  if(childNames.length){
    out+="# Subdirectories\n";
    for(const name of childNames) out+=`* [${name}](${name}/index.md)\n`;
    out+="\n";
  }
  return {text:out,gated};
}

async function scanIndexTree(dir,prefix="",name=""){
  const concepts=[];
  const children=[];
  for await(const [entryName,h] of dir.entries()){
    if(entryName.startsWith(".")||isSystemDir(entryName)) continue;
    if(h.kind==="directory"){
      const childPrefix=prefix?prefix+"/"+entryName:entryName;
      children.push(await scanIndexTree(h,childPrefix,entryName));
    }else if(isConcept(entryName)){
      concepts.push(entryName);
    }
  }
  concepts.sort();
  children.sort((a,b)=>a.name.localeCompare(b.name));
  const qualifyingChildren=children.filter(child=>child.qualifies);
  const qualifies=prefix===""||concepts.length>0||qualifyingChildren.length>0;
  return {dir:prefix,name,concepts,children,qualifyingChildren,qualifies};
}

async function generateIndexes(){
  if(!requireRoot()) return 0;
  const tree=await scanIndexTree(ROOT);
  let count=0;

  async function writeNode(node){
    for(const child of node.children) await writeNode(child);

    const indexPath=node.dir?node.dir+"/index.md":"index.md";
    if(!node.qualifies){
      if(node.dir&&await fileExists(indexPath)) await removeFile(indexPath);
      return;
    }

    const conceptEntries=await readConceptEntries(node.dir,node.concepts);
    const rendered=renderGeneratedIndex(node.dir,conceptEntries,node.qualifyingChildren.map(child=>child.name));
    await writeFile(indexPath,rendered.text);
    count++;
  }

  await writeNode(tree);
  return count;
}

function indexEntryTarget(line){
  const m=String(line||"").match(/^\* \[[^\]]*\]\(([^)]+)\)(?: - .*)?$/);
  return m?m[1]:"";
}

async function rebuildDirectoryIndex(dirPath){
  const dir=await getDirHandle(dirPath,false);
  const concepts=[];
  const childCandidates=[];
  for await(const [name,h] of dir.entries()){
    if(name.startsWith(".")||isSystemDir(name)) continue;
    if(h.kind==="directory") childCandidates.push(name);
    else if(isConcept(name)) concepts.push(name);
  }
  concepts.sort();
  childCandidates.sort();
  const childChecks=await Promise.all(childCandidates.map(async name=>[
    name,
    await fileExists((dirPath?dirPath+"/":"")+name+"/index.md")
  ]));
  const childNames=childChecks.filter(([,exists])=>exists).map(([name])=>name);
  const conceptEntries=await readConceptEntries(dirPath,concepts);
  const rendered=renderGeneratedIndex(dirPath,conceptEntries,childNames);
  await writeFile(dirPath?dirPath+"/index.md":"index.md",rendered.text);
  return true;
}

async function updateIndexesForWrites(writes){
  if(!requireRoot()) return {count:0,mode:"none"};
  const dirs=new Set();

  for(const write of writes||[]){
    const rel=String(write.rel||"").replace(/\\/g,"/").replace(/^\/+/,"");
    const parts=rel.split("/").filter(Boolean);
    const name=parts.pop();
    if(!name||!isConcept(name)) continue;
    if(parts.some(part=>part.startsWith(".")||isSystemDir(part))) continue;
    dirs.add(parts.join("/"));
  }

  if(!dirs.size) return {count:0,mode:"none"};

  const indexPaths=[...dirs].map(dirPath=>dirPath?dirPath+"/index.md":"index.md");
  const available=await Promise.all(indexPaths.map(fileExists));
  if(available.some(ok=>!ok)) return {count:await generateIndexes(),mode:"full"};

  const rebuilt=await Promise.all([...dirs].map(rebuildDirectoryIndex));
  return {count:rebuilt.filter(Boolean).length,mode:"patch"};
}

function bundleAnchor(path,content,selected){
  return `<!-- OKF:BEGIN concept=${path} layer=${selected} -->\n${content}${content.endsWith("\n")?"":"\n"}<!-- OKF:END concept=${path} -->\n\n`;
}
function bundleHeader(mode,f,m,s){
  return `<!-- OKF-CONTEXT-BUNDLE\nmode: ${mode}\nokf_version: ${OKF_VERSION}\nassembled: ${new Date().toISOString()}\nconcepts: ${f+m+s} (${f} foundation, ${m} map, ${s} selected)\n-->\n\n`;
}
function normalizeContextPath(path){
  const clean=String(path||"").replace(/\\/g,"/").replace(/^\/+/,"");
  const parts=clean.split("/");
  if(!clean||!clean.toLowerCase().endsWith(".md")) return "";
  if(parts.some(p=>!p||p==="."||p===".."||p.startsWith("."))) return "";
  if(isSystemDir(parts[0])) return "";
  return clean;
}
function contextDir(path){
  const parts=String(path||"").replace(/\\/g,"/").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}
function displayFolderName(path){
  const slug=String(path||"").split("/").filter(Boolean).pop()||"Secsitive Context";
  return slug.split(/[-_]+/).filter(Boolean).map(word=>word.charAt(0).toUpperCase()+word.slice(1)).join(" ");
}
function collectGatedDiscoveryRoots(files){
  const candidates=[];
  for(const [path,content] of files){
    const leaf=path.split("/").pop();
    if(!isConcept(leaf)) continue;
    const fm=parseFrontmatter(content);
    if(String(fm.discovery||"").toLowerCase()!=="gated") continue;
    if(String(fm.discovery_scope||"").toLowerCase()!=="folder") continue;
    const dir=contextDir(path);
    if(dir) candidates.push(dir);
  }
  const ordered=[...new Set(candidates)].sort((a,b)=>{
    const depth=a.split("/").length-b.split("/").length;
    return depth||a.localeCompare(b);
  });
  return ordered.filter(path=>!ordered.some(other=>other!==path&&path.startsWith(other+"/")));
}
function gatedRootForIndex(indexPath,gatedRoots){
  if(indexPath==="index.md") return "";
  const dir=contextDir(indexPath);
  return gatedRoots.find(root=>dir===root||dir.startsWith(root+"/"))||"";
}
function gatedMapAnchor(indexPath,gatedRoot){
  const title=displayFolderName(gatedRoot);
  return `<!-- OKF:BEGIN concept=${indexPath} layer=map discovery=gated -->\n# ${title}\n\n> Gated discovery: this folder exists, but its generated map is withheld from automatic workspace orientation.\n\nRequest \`${gatedRoot}/index.md\` explicitly when the user's request is in this domain or when this personal context could materially change the safety, applicability, or quality of the answer.\n<!-- OKF:END concept=${indexPath} -->\n\n`;
}
function embeddedOperatorSkill(){
  return document.getElementById("stickshift-skill")?.textContent?.trim()||"";
}
function resolveIndexTarget(indexPath,target){
  const clean=String(target||"").replace(/\\/g,"/");
  if(!clean||clean.startsWith("/")) return "";
  const parts=(contextDir(indexPath)?contextDir(indexPath)+"/":"")+clean;
  const resolved=[];
  for(const part of parts.split("/")){
    if(!part||part===".") continue;
    if(part===".."){if(!resolved.length) return "";resolved.pop();continue;}
    if(part.startsWith(".")) return "";
    resolved.push(part);
  }
  if(resolved.at(-1)?.toLowerCase()!=="index.md") return "";
  if(isSystemDir(resolved[0])) return "";
  return resolved.join("/");
}
function indexSubdirectoryPaths(indexPath,content){
  const lines=String(content||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
  const subAt=lines.findIndex(line=>line.trim()==="# Subdirectories");
  if(subAt<0) return [];
  const out=[];
  for(const line of lines.slice(subAt+1)){
    const target=indexEntryTarget(line);
    if(!target||!target.toLowerCase().endsWith("/index.md")) continue;
    const resolved=resolveIndexTarget(indexPath,target);
    if(resolved) out.push(resolved);
  }
  return [...new Set(out)];
}
async function readGeneratedIndexGraph(){
  const started=performance.now();
  const queue=["index.md"];
  const seen=new Set();
  const records=[];
  while(queue.length){
    const path=queue.shift();
    if(seen.has(path)) continue;
    seen.add(path);
    let content;
    try{content=await readFile(path);}catch(e){
      return {ok:false,reason:`generated map missing ${path}`,mapReadMs:performance.now()-started,indexFiles:records.length};
    }
    const fm=parseFrontmatter(content);
    if(String(fm.stickshift_index_schema||"")!==GENERATED_INDEX_SCHEMA){
      return {ok:false,reason:`legacy generated map at ${path}`,mapReadMs:performance.now()-started,indexFiles:records.length+1};
    }
    const gated=path!=="index.md" &&
      String(fm.discovery||"").toLowerCase()==="gated" &&
      String(fm.discovery_scope||"").toLowerCase()==="folder";
    records.push({path,content,gated});
    if(!gated) queue.push(...indexSubdirectoryPaths(path,content));
  }
  return {ok:true,records,mapReadMs:performance.now()-started,indexFiles:records.length};
}
async function buildIndexBundleLegacy(fallbackReason=""){
  const started=performance.now();
  const files=await walkMarkdown({includeSystem:false});
  const indexes=[...files.keys()]
    .filter(path=>path.split("/").pop().toLowerCase()==="index.md")
    .sort((a,b)=>a==="index.md"?-1:b==="index.md"?1:a.localeCompare(b));
  const gatedRoots=collectGatedDiscoveryRoots(files);
  let body="",mapCount=0,gatedCount=0;

  for(const path of indexes){
    const gatedRoot=gatedRootForIndex(path,gatedRoots);
    if(gatedRoot){
      if(path===gatedRoot+"/index.md"){
        body+=gatedMapAnchor(path,gatedRoot);
        mapCount++;
        gatedCount++;
      }
      continue;
    }
    body+=bundleAnchor(path,files.get(path),"map");
    mapCount++;
  }

  const text=bundleHeader("index",0,mapCount,0)+body;
  return {
    text,f:0,m:mapCount,s:0,chars:text.length,gated:gatedCount,
    indexReadMode:"legacy-scan",indexFiles:indexes.length,
    mapReadMs:performance.now()-started,fallbackReason
  };
}
async function buildIndexBundle(){
  if(!requireRoot()) return null;
  const graph=await readGeneratedIndexGraph();
  if(!graph.ok) return buildIndexBundleLegacy(graph.reason);

  let body="",mapCount=0,gatedCount=0;
  for(const record of graph.records){
    if(record.gated){
      const gatedRoot=contextDir(record.path);
      body+=gatedMapAnchor(record.path,gatedRoot);
      gatedCount++;
    }else{
      body+=bundleAnchor(record.path,record.content,"map");
    }
    mapCount++;
  }
  const text=bundleHeader("index",0,mapCount,0)+body;
  return {
    text,f:0,m:mapCount,s:0,chars:text.length,gated:gatedCount,
    indexReadMode:"generated-map",indexFiles:graph.indexFiles,mapReadMs:graph.mapReadMs,
    fallbackReason:""
  };
}
async function buildSessionBootstrap(){
  const indexBundle=await buildIndexBundle();
  if(!indexBundle) return null;
  const skill=embeddedOperatorSkill();
  if(!skill) throw new Error("Embedded StickShift Operator skill is unavailable.");
  const prefix=`<!-- STICKSHIFT-SESSION-BOOTSTRAP\ncontains: operator-skill + map-only-index\n-->\n\n<!-- STICKSHIFT:BEGIN operator-skill -->\n${skill}\n<!-- STICKSHIFT:END operator-skill -->\n\n`;
  const text=prefix+indexBundle.text;
  return {...indexBundle,text,chars:text.length,bootstrap:true};
}
async function buildBundleFromRequest(req){
  if(req.mode==="index") return buildIndexBundle();
  if(req.mode==="all"){
    const files=await walkMarkdown({includeSystem:false});
    let body="",f=0,m=0,s=0;
    for(const p of [...files.keys()].filter(p=>p.split("/").pop().toLowerCase()!=="log.md").sort()){
      const layer=p.startsWith(FOUNDATION_DIR+"/")?"foundation":p.endsWith("/index.md")||p==="index.md"?"map":"selected";
      body+=bundleAnchor(p,files.get(p),layer);
      layer==="foundation"?f++:layer==="map"?m++:s++;
    }
    const text=bundleHeader("all",f,m,s)+body;
    return {text,f,m,s,chars:text.length};
  }

  const requested=[...new Set(req.seeds.map(normalizeContextPath).filter(Boolean))];
  const entries=(await Promise.all(requested.map(async p=>{
    try{return [p,await readFile(p)];}catch{return null;}
  }))).filter(Boolean);
  let body="",f=0,m=0,s=0;
  for(const [p,content] of entries){
    const layer=p.startsWith(FOUNDATION_DIR+"/")?"foundation":p.endsWith("/index.md")||p==="index.md"?"map":"selected";
    body+=bundleAnchor(p,content,layer);
    layer==="foundation"?f++:layer==="map"?m++:s++;
  }
  const text=bundleHeader("bundle",f,m,s)+body;
  return {text,f,m,s,chars:text.length};
}

function parseContextRequest(text){
  const req={mode:"index",depth:1,direction:"outbound",via:"",seeds:[]};
  const m=String(text||"").match(/<CONTEXT_REQUEST>([\s\S]*?)<\/CONTEXT_REQUEST>/i);
  if(!m) return req;
  let inInclude=false;
  for(const raw of m[1].replace(/\r/g,"").split("\n")){
    const line=raw.trim();
    if(line.startsWith("mode:")){req.mode=line.slice(5).trim();inInclude=false;}
    else if(line.startsWith("depth:")){req.depth=parseInt(line.slice(6),10)||0;inInclude=false;}
    else if(line.startsWith("direction:")){req.direction=line.slice(10).trim();inInclude=false;}
    else if(line.startsWith("via:")){req.via=line.slice(4).trim();inInclude=false;}
    else if(line==="include:"){inInclude=true;}
    else if(inInclude&&line.startsWith("- ")){req.seeds.push(line.slice(2).trim());}
  }
  return req;
}
