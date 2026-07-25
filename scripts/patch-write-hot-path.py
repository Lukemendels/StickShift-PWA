from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


fs_path = Path("assets/js/fs.js")
fs = fs_path.read_text(encoding="utf-8")

old_generate_tail = '''    await writeFile(d.dir?d.dir+"/index.md":"index.md",out);\n    count++;\n  }\n  await refreshFiles();\n  return count;\n}\n'''
new_generate_tail = '''    await writeFile(d.dir?d.dir+"/index.md":"index.md",out);\n    count++;\n  }\n  return count;\n}\n\nasync function generateIndexForDir(dirPath){\n  const dir=await getDirHandle(dirPath,false);\n  const files=[],subs=[];\n  for await(const [name,h] of dir.entries()){\n    if(name.startsWith(".")||isSystemDir(name)) continue;\n    if(h.kind==="directory") subs.push(name);\n    else if(name.toLowerCase().endsWith(".md")) files.push(name);\n  }\n\n  const concepts=files.filter(isConcept).sort();\n  if(!concepts.length&&!subs.length) return 0;\n\n  let out=dirPath===""?`---\\nokf_version: "${OKF_VERSION}"\\n---\\n\\n`:"";\n  const entries=await Promise.all(concepts.map(async name=>{\n    const path=dirPath?dirPath+"/"+name:name;\n    return [name,await readFile(path)];\n  }));\n  for(const [name,content] of entries) out+=entryLine(name,content)+"\\n";\n  if(concepts.length) out+="\\n";\n  if(subs.length){\n    out+="# Subdirectories\\n";\n    for(const s of subs.sort()) out+=`* [${s}](${s}/index.md)\\n`;\n    out+="\\n";\n  }\n  await writeFile(dirPath?dirPath+"/index.md":"index.md",out);\n  return 1;\n}\n\nasync function generateIndexesForPaths(paths){\n  if(!requireRoot()) return 0;\n  const dirs=new Set([""]);\n  for(const raw of paths||[]){\n    const rel=String(raw||"").replace(/\\\\/g,"/").replace(/^\\/+/,"");\n    const parts=rel.split("/").filter(Boolean);\n    parts.pop();\n    let current="";\n    for(const part of parts){\n      if(part.startsWith(".")||isSystemDir(part)) break;\n      current=current?current+"/"+part:part;\n      dirs.add(current);\n    }\n  }\n  const counts=await Promise.all([...dirs].map(generateIndexForDir));\n  return counts.reduce((sum,n)=>sum+n,0);\n}\n'''
fs = replace_once(fs, old_generate_tail, new_generate_tail, "fs generateIndexes tail")
fs_path.write_text(fs, encoding="utf-8")

packets_path = Path("assets/js/packets.js")
packets = packets_path.read_text(encoding="utf-8")

packets = replace_once(
    packets,
    '  let written=0,skipped=0,logLines="";\n',
    '  let written=0,skipped=0,logLines="";\n  const writtenPaths=[];\n',
    "applyWrite writtenPaths init",
)
packets = replace_once(
    packets,
    '    written++;\n    logLines+=`- ${stampNow()}  ${existed?"edit":"new"}  ${rel}\\n`;\n',
    '    written++;\n    writtenPaths.push(rel);\n    logLines+=`- ${stampNow()}  ${existed?"edit":"new"}  ${rel}\\n`;\n',
    "applyWrite written path capture",
)
packets = replace_once(
    packets,
    '  return {written,skipped,timing};\n',
    '  return {written,skipped,timing,paths:writtenPaths};\n',
    "applyWrite return paths",
)

old_route = '''      const r=await applyWrite(env);\n      const indexStart=performance.now();\n      const n=await generateIndexes();\n      const indexMs=performance.now()-indexStart;\n\n      $("writeMeter").textContent=`${r.written} written · ${r.skipped} skipped`;\n      setPasteState("success",`Applied ${r.written} file${r.written===1?"":"s"}`,`Indexes regenerated: ${n}.`);\n      log(`VBA_WRITE applied: ${r.written} written, ${r.skipped} skipped.`,"ok");\n\n      const refreshStart=performance.now();\n      await refreshFiles();\n      const refreshMs=performance.now()-refreshStart;\n      const totalMs=performance.now()-writeStartedAt;\n      const readPart=Number.isFinite(timing.clipboardReadMs)?`read ${fmtMs(timing.clipboardReadMs)} · `:"";\n      const wt=r.timing||{};\n      log(`Write timing: ${readPart}parse ${fmtMs(parseMs)} · apply ${fmtMs(wt.totalMs||0)} (exists ${fmtMs(wt.existsMs||0)} · files ${fmtMs(wt.fileWriteMs||0)} · log-read ${fmtMs(wt.logReadMs||0)} · log-write ${fmtMs(wt.logWriteMs||0)}) · indexes ${fmtMs(indexMs)} · refresh ${fmtMs(refreshMs)} · total ${fmtMs(totalMs)}.`,"info");\n      $("writeMeter").textContent=`${r.written} written · ${r.skipped} skipped · ${fmtMs(totalMs)} total`;\n'''
new_route = '''      const r=await applyWrite(env);\n      const indexStart=performance.now();\n      const n=await generateIndexesForPaths(r.paths);\n      const indexMs=performance.now()-indexStart;\n\n      $("writeMeter").textContent=`${r.written} written · ${r.skipped} skipped`;\n      setPasteState("success",`Applied ${r.written} file${r.written===1?"":"s"}`,`Affected indexes regenerated: ${n}.`);\n      log(`VBA_WRITE applied: ${r.written} written, ${r.skipped} skipped.`,"ok");\n\n      // Explorer owns its own refresh when opened; do not reread the corpus on the Console hot path.\n      const totalMs=performance.now()-writeStartedAt;\n      const readPart=Number.isFinite(timing.clipboardReadMs)?`read ${fmtMs(timing.clipboardReadMs)} · `:"";\n      const wt=r.timing||{};\n      log(`Write timing: ${readPart}parse ${fmtMs(parseMs)} · apply ${fmtMs(wt.totalMs||0)} (exists ${fmtMs(wt.existsMs||0)} · files ${fmtMs(wt.fileWriteMs||0)} · log-read ${fmtMs(wt.logReadMs||0)} · log-write ${fmtMs(wt.logWriteMs||0)}) · indexes ${fmtMs(indexMs)} · refresh deferred · total ${fmtMs(totalMs)}.`,"info");\n      $("writeMeter").textContent=`${r.written} written · ${r.skipped} skipped · ${fmtMs(totalMs)} total`;\n'''
packets = replace_once(packets, old_route, new_route, "VBA_WRITE hot path")
packets_path.write_text(packets, encoding="utf-8")

index_path = Path("index.html")
index = index_path.read_text(encoding="utf-8")
index = replace_once(index, '<script src="./assets/js/fs.js"></script>', '<script src="./assets/js/fs.js?v=6"></script>', "index fs asset version")
index = replace_once(index, '<script src="./assets/js/packets.js?v=5"></script>', '<script src="./assets/js/packets.js?v=6"></script>', "index packets asset version")
index_path.write_text(index, encoding="utf-8")

sw_path = Path("sw.js")
sw = sw_path.read_text(encoding="utf-8")
sw = replace_once(sw, 'const CACHE_NAME = "stickshift-pwa-v5";', 'const CACHE_NAME = "stickshift-pwa-v6";', "service worker cache version")
sw = replace_once(sw, '  "./assets/js/fs.js",', '  "./assets/js/fs.js?v=6",', "service worker fs asset version")
sw = replace_once(sw, '  "./assets/js/packets.js?v=5",', '  "./assets/js/packets.js?v=6",', "service worker packets asset version")
sw_path.write_text(sw, encoding="utf-8")

print("Patched incremental write indexes, deferred Explorer refresh, and PWA asset versions.")
