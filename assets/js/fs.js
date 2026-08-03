async function getDirHandle(path,create=false){
  let dir=ROOT;
  for(const part of String(path||"").split("/").filter(Boolean)){
    dir=await dir.getDirectoryHandle(part,{create});
  }
  return dir;
}
async function getFileHandle(path,create=false){
  const parts=String(path||"").split("/").filter(Boolean);
  let dir=ROOT;
  for(let i=0;i<parts.length-1;i++) dir=await dir.getDirectoryHandle(parts[i],{create});
  return dir.getFileHandle(parts[parts.length-1],{create});
}
async function readFile(path){
  const fh=await getFileHandle(path,false);
  return (await fh.getFile()).text();
}
async function writeFile(path,content){
  const fh=await getFileHandle(path,true);
  const w=await fh.createWritable();
  await w.write(String(content??""));
  await w.close();
}
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

    let out=node.dir===""?`---\nokf_version: "${OKF_VERSION}"\n---\n\n`:"";
    for(const conceptName of node.concepts){
      const path=node.dir?node.dir+"/"+conceptName:conceptName;
      out+=entryLine(conceptName,await readFile(path))+"\n";
    }
    if(node.concepts.length) out+="\n";
    if(node.qualifyingChildren.length){
      out+="# Subdirectories\n";
      for(const child of node.qualifyingChildren) out+=`* [${child.name}](${child.name}/index.md)\n`;
      out+="\n";
    }
    await writeFile(indexPath,out);
    count++;
  }

  await writeNode(tree);
  return count;
}

function indexEntryTarget(line){
  const m=String(line||"").match(/^\* \[[^\]]*\]\(([^)]+)\)(?: - .*)?$/);
  return m?m[1]:"";
}

async function patchIndexForWrites(dirPath,writes){
  const indexPath=dirPath?dirPath+"/index.md":"index.md";
  if(!await fileExists(indexPath)) return false;

  const current=await readFile(indexPath);
  const lines=String(current||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n").split("\n");
  const subAt=lines.findIndex(line=>line.trim()==="# Subdirectories");
  const conceptEnd=subAt>=0?subAt:lines.length;
  const entries=new Map();

  for(let i=0;i<conceptEnd;i++){
    const target=indexEntryTarget(lines[i]);
    if(target && target.toLowerCase().endsWith(".md") && target.toLowerCase()!=="index.md") entries.set(target,lines[i]);
  }

  for(const write of writes){
    const name=write.rel.split("/").pop();
    entries.set(name,entryLine(name,write.content));
  }

  const conceptLines=[...entries.entries()]
    .sort(([a],[b])=>a.localeCompare(b))
    .map(([,line])=>line);

  let out=dirPath===""?`---
okf_version: "${OKF_VERSION}"
---

`:"";
  if(conceptLines.length) out+=conceptLines.join("\n")+"\n\n";
  if(subAt>=0){
    const subSection=lines.slice(subAt).join("\n").trimEnd();
    if(subSection) out+=subSection+"\n";
  }

  await writeFile(indexPath,out);
  return true;
}

async function updateIndexesForWrites(writes){
  if(!requireRoot()) return {count:0,mode:"none"};
  const grouped=new Map();

  for(const write of writes||[]){
    const rel=String(write.rel||"").replace(/\\/g,"/").replace(/^\/+/,"");
    const parts=rel.split("/").filter(Boolean);
    const name=parts.pop();
    if(!name||!isConcept(name)) continue;
    if(parts.some(part=>part.startsWith(".")||isSystemDir(part))) continue;
    const dirPath=parts.join("/");
    if(!grouped.has(dirPath)) grouped.set(dirPath,[]);
    grouped.get(dirPath).push({...write,rel});
  }

  if(!grouped.size) return {count:0,mode:"none"};

  const indexPaths=[...grouped.keys()].map(dirPath=>dirPath?dirPath+"/index.md":"index.md");
  const available=await Promise.all(indexPaths.map(fileExists));
  if(available.some(ok=>!ok)){
    return {count:await generateIndexes(),mode:"full"};
  }

  const patched=await Promise.all([...grouped.entries()].map(([dirPath,items])=>patchIndexForWrites(dirPath,items)));
  return {count:patched.filter(Boolean).length,mode:"patch"};
}

function bundleAnchor(path,content,layer){
  return `<!-- OKF:BEGIN concept=${path} layer=${layer} -->\n${content}${content.endsWith("\n")?"":"\n"}<!-- OKF:END concept=${path} -->\n\n`;
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
  const slug=String(path||"").split("/").filter(Boolean).pop()||"Sensitive Context";
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
async function buildIndexBundle(){
  if(!requireRoot()) return null;
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
  return {text,f:0,m:mapCount,s:0,chars:text.length,gated:gatedCount};
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
