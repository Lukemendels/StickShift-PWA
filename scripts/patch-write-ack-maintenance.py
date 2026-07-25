from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


def replace_between(text: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    try:
        start = text.index(start_marker)
        end = text.index(end_marker, start)
    except ValueError as exc:
        raise SystemExit(f"{label}: anchor not found") from exc
    return text[:start] + replacement + text[end:]


fs_path = Path("assets/js/fs.js")
fs = fs_path.read_text(encoding="utf-8")

fs = replace_once(
    fs,
    '''async function writeFile(path,content){
  const fh=await getFileHandle(path,true);
  const w=await fh.createWritable();
  await w.write(String(content??""));
  await w.close();
}
async function fileExists(path){''',
    '''async function writeFile(path,content){
  const fh=await getFileHandle(path,true);
  const w=await fh.createWritable();
  await w.write(String(content??""));
  await w.close();
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
async function fileExists(path){''',
    "appendFile helper",
)

new_incremental = '''function indexEntryTarget(line){
  const m=String(line||"").match(/^\\* \\[[^\\]]*\\]\\(([^)]+)\\)(?: - .*)?$/);
  return m?m[1]:"";
}

async function patchIndexForWrites(dirPath,writes){
  const indexPath=dirPath?dirPath+"/index.md":"index.md";
  if(!await fileExists(indexPath)) return false;

  const current=await readFile(indexPath);
  const lines=String(current||"").replace(/\\r\\n/g,"\\n").replace(/\\r/g,"\\n").split("\\n");
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

  let out=dirPath===""?`---\nokf_version: "${OKF_VERSION}"\n---\n\n`:"";
  if(conceptLines.length) out+=conceptLines.join("\\n")+"\\n\\n";
  if(subAt>=0){
    const subSection=lines.slice(subAt).join("\\n").trimEnd();
    if(subSection) out+=subSection+"\\n";
  }

  await writeFile(indexPath,out);
  return true;
}

async function updateIndexesForWrites(writes){
  if(!requireRoot()) return {count:0,mode:"none"};
  const grouped=new Map();

  for(const write of writes||[]){
    const rel=String(write.rel||"").replace(/\\\\/g,"/").replace(/^\\/+/,"");
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

'''
fs = replace_between(fs, "async function generateIndexForDir(dirPath){", "function bundleAnchor", new_incremental, "incremental index functions")
fs_path.write_text(fs, encoding="utf-8")

packets_path = Path("assets/js/packets.js")
packets = packets_path.read_text(encoding="utf-8")

new_apply = '''async function applyWrite(env){
  const applyStart=performance.now();
  const timing={existsMs:0,fileWriteMs:0,totalMs:0};
  let written=0,skipped=0;
  const writes=[];
  for(const item of env.files){
    const rel=String(item.rel||"").replace(/\\\\/g,"/").replace(/^\\/+/,"");
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
  const logLines=writes.map(write=>`- ${stampNow()}  ${write.existed?"edit":"new"}  ${write.rel}\\n`).join("");
  await appendFile("log.md",logLines,"# Log\\n\\n");
  return performance.now()-started;
}

'''
packets = replace_between(packets, "async function applyWrite(env){", "async function writeClip", new_apply, "primary write functions")

new_write_branch = '''  if(text.includes("<VBA_WRITE>")){
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
'''
packets = replace_between(packets, '  if(text.includes("<VBA_WRITE>")){', '  if(text.includes("<CONTEXT_REQUEST>")){', new_write_branch, "write packet branch")
packets_path.write_text(packets, encoding="utf-8")

index_path = Path("index.html")
index = index_path.read_text(encoding="utf-8")
index = replace_once(index, '<script src="./assets/js/fs.js?v=6"></script>', '<script src="./assets/js/fs.js?v=7"></script>', "index fs version")
index = replace_once(index, '<script src="./assets/js/packets.js?v=6"></script>', '<script src="./assets/js/packets.js?v=7"></script>', "index packets version")
index_path.write_text(index, encoding="utf-8")

sw_path = Path("sw.js")
sw = sw_path.read_text(encoding="utf-8")
sw = replace_once(sw, 'const CACHE_NAME = "stickshift-pwa-v6";', 'const CACHE_NAME = "stickshift-pwa-v7";', "sw cache version")
sw = replace_once(sw, '  "./assets/js/fs.js?v=6",', '  "./assets/js/fs.js?v=7",', "sw fs version")
sw = replace_once(sw, '  "./assets/js/packets.js?v=6",', '  "./assets/js/packets.js?v=7",', "sw packets version")
sw_path.write_text(sw, encoding="utf-8")

print("Patched immediate write acknowledgment, append-only audit, index-entry patching, and v7 assets.")
