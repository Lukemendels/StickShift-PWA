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
async function generateIndexes(){
  if(!requireRoot()) return 0;
  const dirs=[];
  async function rec(dir,prefix){
    const files=[],subs=[];
    for await(const [name,h] of dir.entries()){
      if(name.startsWith(".")||isSystemDir(name)) continue;
      if(h.kind==="directory"){subs.push(name);await rec(h,prefix?prefix+"/"+name:name);}
      else if(name.toLowerCase().endsWith(".md")) files.push(name);
    }
    dirs.push({dir:prefix,files,subs});
  }
  await rec(ROOT,"");
  let count=0;
  for(const d of dirs){
    const concepts=d.files.filter(isConcept).sort();
    if(!concepts.length&&!d.subs.length) continue;
    let out=d.dir===""?`---\nokf_version: "${OKF_VERSION}"\n---\n\n`:"";
    for(const name of concepts){
      const path=d.dir?d.dir+"/"+name:name;
      out+=entryLine(name,await readFile(path))+"\n";
    }
    if(concepts.length) out+="\n";
    if(d.subs.length){
      out+="# Subdirectories\n";
      for(const s of d.subs.sort()) out+=`* [${s}](${s}/index.md)\n`;
      out+="\n";
    }
    await writeFile(d.dir?d.dir+"/index.md":"index.md",out);
    count++;
  }
  await refreshFiles();
  return count;
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
async function buildIndexBundle(){
  if(!requireRoot()) return null;
  const paths=await walkMarkdownPaths({includeSystem:false});
  const foundation=paths.filter(p=>p.startsWith(FOUNDATION_DIR+"/")&&!RESERVED.has(p.split("/").pop().toLowerCase())).sort();
  const indexes=paths.filter(p=>p.split("/").pop().toLowerCase()==="index.md").sort((a,b)=>a==="index.md"?-1:b==="index.md"?1:a.localeCompare(b));
  const wanted=[...foundation,...indexes];
  const entries=await Promise.all(wanted.map(async p=>[p,await readFile(p)]));
  const contents=new Map(entries);
  let body="";
  for(const p of foundation) body+=bundleAnchor(p,contents.get(p),"foundation");
  for(const p of indexes) body+=bundleAnchor(p,contents.get(p),"map");
  const text=bundleHeader("index",foundation.length,indexes.length,0)+body;
  return {text,f:foundation.length,m:indexes.length,s:0,chars:text.length};
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
