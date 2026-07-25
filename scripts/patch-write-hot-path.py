from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 match, found {count}")
    return text.replace(old, new, 1)


fs_path = Path("assets/js/fs.js")
fs = fs_path.read_text(encoding="utf-8")
fs = replace_once(
    fs,
    "  await refreshFiles();\n  return count;\n}\n\nfunction bundleAnchor",
    "  return count;\n}\n\nasync function generateIndexForDir(dirPath){\n  const dir=await getDirHandle(dirPath,false);\n  const files=[],subs=[];\n  for await(const [name,h] of dir.entries()){\n    if(name.startsWith(\".\")||isSystemDir(name)) continue;\n    if(h.kind===\"directory\") subs.push(name);\n    else if(name.toLowerCase().endsWith(\".md\")) files.push(name);\n  }\n\n  const concepts=files.filter(isConcept).sort();\n  if(!concepts.length&&!subs.length) return 0;\n\n  let out=dirPath===\"\"?`---\\nokf_version: \"${OKF_VERSION}\"\\n---\\n\\n`:\"\";\n  const entries=await Promise.all(concepts.map(async name=>{\n    const path=dirPath?dirPath+\"/\"+name:name;\n    return [name,await readFile(path)];\n  }));\n  for(const [name,content] of entries) out+=entryLine(name,content)+\"\\n\";\n  if(concepts.length) out+=\"\\n\";\n  if(subs.length){\n    out+=\"# Subdirectories\\n\";\n    for(const s of subs.sort()) out+=`* [${s}](${s}/index.md)\\n`;\n    out+=\"\\n\";\n  }\n  await writeFile(dirPath?dirPath+\"/index.md\":\"index.md\",out);\n  return 1;\n}\n\nasync function generateIndexesForPaths(paths){\n  if(!requireRoot()) return 0;\n  const dirs=new Set([\"\"]);\n  for(const raw of paths||[]){\n    const rel=String(raw||\"\").replace(/\\\\/g,\"/\").replace(/^\\/+/,\"\");\n    const parts=rel.split(\"/\").filter(Boolean);\n    parts.pop();\n    let current=\"\";\n    for(const part of parts){\n      if(part.startsWith(\".\")||isSystemDir(part)) break;\n      current=current?current+\"/\"+part:part;\n      dirs.add(current);\n    }\n  }\n  const counts=await Promise.all([...dirs].map(generateIndexForDir));\n  return counts.reduce((sum,n)=>sum+n,0);\n}\n\nfunction bundleAnchor",
    "fs incremental index insertion",
)
fs_path.write_text(fs, encoding="utf-8")

packets_path = Path("assets/js/packets.js")
packets = packets_path.read_text(encoding="utf-8")
packets = replace_once(
    packets,
    '  let written=0,skipped=0,logLines="";\n',
    '  let written=0,skipped=0,logLines="";\n  const writtenPaths=[];\n',
    "applyWrite path list",
)
packets = replace_once(
    packets,
    '    written++;\n    logLines+=`- ${stampNow()}  ${existed?"edit":"new"}  ${rel}\\n`;\n',
    '    written++;\n    writtenPaths.push(rel);\n    logLines+=`- ${stampNow()}  ${existed?"edit":"new"}  ${rel}\\n`;\n',
    "applyWrite path record",
)
packets = replace_once(
    packets,
    '  return {written,skipped,timing};\n',
    '  return {written,skipped,timing,paths:writtenPaths};\n',
    "applyWrite path return",
)
packets = replace_once(
    packets,
    '      const n=await generateIndexes();\n',
    '      const n=await generateIndexesForPaths(r.paths);\n',
    "packet incremental indexes",
)
packets = replace_once(
    packets,
    '`Indexes regenerated: ${n}.`',
    '`Affected indexes regenerated: ${n}.`',
    "packet status copy",
)
packets = replace_once(
    packets,
    '      const refreshStart=performance.now();\n      await refreshFiles();\n      const refreshMs=performance.now()-refreshStart;\n',
    '      // Explorer refresh is deferred until Explorer is actually opened.\n',
    "packet remove eager refresh",
)
packets = replace_once(
    packets,
    ' · refresh ${fmtMs(refreshMs)} · total ',
    ' · refresh deferred · total ',
    "packet telemetry refresh label",
)
packets_path.write_text(packets, encoding="utf-8")

index_path = Path("index.html")
index = index_path.read_text(encoding="utf-8")
index = replace_once(index, '<script src="./assets/js/fs.js"></script>', '<script src="./assets/js/fs.js?v=6"></script>', "index fs version")
index = replace_once(index, '<script src="./assets/js/packets.js?v=5"></script>', '<script src="./assets/js/packets.js?v=6"></script>', "index packets version")
index_path.write_text(index, encoding="utf-8")

sw_path = Path("sw.js")
sw = sw_path.read_text(encoding="utf-8")
sw = replace_once(sw, 'const CACHE_NAME = "stickshift-pwa-v5";', 'const CACHE_NAME = "stickshift-pwa-v6";', "sw cache version")
sw = replace_once(sw, '  "./assets/js/fs.js",', '  "./assets/js/fs.js?v=6",', "sw fs version")
sw = replace_once(sw, '  "./assets/js/packets.js?v=5",', '  "./assets/js/packets.js?v=6",', "sw packets version")
sw_path.write_text(sw, encoding="utf-8")

print("Patched incremental write indexing and deferred Explorer refresh.")
