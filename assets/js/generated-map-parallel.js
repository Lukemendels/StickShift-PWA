/* Generated map reads are parallelized by discovery depth so Drive-backed
   workspaces pay one filesystem round per map layer instead of one per file. */
readGeneratedIndexGraph = async function(){
  const started=performance.now();
  let frontier=["index.md"];
  const seen=new Set();
  const records=[];
  let readRounds=0;

  while(frontier.length){
    const batch=[...new Set(frontier.filter(path=>!seen.has(path)))];
    frontier=[];
    if(!batch.length) continue;
    batch.forEach(path=>seen.add(path));
    readRounds++;

    const results=await Promise.all(batch.map(async path=>{
      try{return {path,content:await readFile(path),error:null};}
      catch(error){return {path,content:"",error};}
    }));

    for(const result of results){
      const {path,content,error}=result;
      if(error){
        return {
          ok:false,
          reason:`generated map missing ${path}`,
          mapReadMs:performance.now()-started,
          indexFiles:records.length,
          readRounds
        };
      }

      const fm=parseFrontmatter(content);
      if(String(fm.stickshift_index_schema||"")!==GENERATED_INDEX_SCHEMA){
        return {
          ok:false,
          reason:`legacy generated map at ${path}`,
          mapReadMs:performance.now()-started,
          indexFiles:records.length+1,
          readRounds
        };
      }

      const gated=path!=="index.md" &&
        String(fm.discovery||"").toLowerCase()==="gated" &&
        String(fm.discovery_scope||"").toLowerCase()==="folder";
      records.push({path,content,gated});
      if(!gated) frontier.push(...indexSubdirectoryPaths(path,content));
    }
  }

  return {
    ok:true,
    records,
    mapReadMs:performance.now()-started,
    indexFiles:records.length,
    readRounds
  };
};

/* One-file compiled discovery cache.
   The cache is derived state, hidden from Explorer, and invalidated before any
   map-relevant concept write. The selected OKF workspace remains authoritative. */
const AGGREGATE_MAP_PATH=`${DIST_DIR}/.StickShift-map-cache.md`;
const AGGREGATE_MAP_SCHEMA="1";
let AGGREGATE_MAP_DIRTY=false;
let AGGREGATE_MAP_MEMORY=null;
let AGGREGATE_MAP_PRIME=null;

async function readFileAtRoot(root,path){
  const fh=await getFileHandleFrom(root,path,false);
  return (await fh.getFile()).text();
}
function aggregateMapBody(records){
  let body="",mapCount=0,gatedCount=0;
  for(const record of records){
    if(record.gated){
      const gatedRoot=contextDir(record.path);
      body+=gatedMapAnchor(record.path,gatedRoot);
      gatedCount++;
    }else{
      body+=bundleAnchor(record.path,record.content,"map");
    }
    mapCount++;
  }
  return {body,mapCount,gatedCount};
}
function aggregateCacheText(body,mapCount,gatedCount){
  return `---\nstickshift_map_cache_schema: "${AGGREGATE_MAP_SCHEMA}"\nokf_version: "${OKF_VERSION}"\nmap_count: "${mapCount}"\ngated_count: "${gatedCount}"\ngenerated: "${new Date().toISOString()}"\n---\n\n${body}`;
}
function parseAggregateCache(text){
  const fm=parseFrontmatter(text);
  if(String(fm.stickshift_map_cache_schema||"")!==AGGREGATE_MAP_SCHEMA) return null;
  if(String(fm.okf_version||"")!==OKF_VERSION) return null;
  const normalized=String(text||"").replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  const match=normalized.match(/^---\n[\s\S]*?\n---\n\n([\s\S]*)$/);
  if(!match) return null;
  const mapCount=parseInt(fm.map_count,10);
  const gatedCount=parseInt(fm.gated_count,10);
  if(!Number.isFinite(mapCount)||mapCount<1||!Number.isFinite(gatedCount)||gatedCount<0) return null;
  return {body:match[1],mapCount,gatedCount};
}
function setAggregateMemory(root,parsed,source){
  AGGREGATE_MAP_MEMORY=parsed?{root,...parsed,source}:null;
  return AGGREGATE_MAP_MEMORY;
}
async function loadAggregateMap(root=ROOT,{source="aggregate-file"}={}){
  if(!root||AGGREGATE_MAP_DIRTY) return null;
  if(AGGREGATE_MAP_MEMORY?.root===root) return AGGREGATE_MAP_MEMORY;
  try{
    const parsed=parseAggregateCache(await readFileAtRoot(root,AGGREGATE_MAP_PATH));
    return setAggregateMemory(root,parsed,source);
  }catch{return null;}
}
function primeAggregateMap(root=ROOT){
  if(!root||AGGREGATE_MAP_DIRTY) return Promise.resolve(null);
  if(AGGREGATE_MAP_MEMORY?.root===root) return Promise.resolve(AGGREGATE_MAP_MEMORY);
  if(AGGREGATE_MAP_PRIME?.root===root) return AGGREGATE_MAP_PRIME.promise;
  const started=performance.now();
  const promise=loadAggregateMap(root,{source:"aggregate-memory"}).then(result=>{
    if(result) log(`Aggregate map primed: ${result.mapCount} maps in ${fmtMs(performance.now()-started)}.`,"info");
    return result;
  });
  AGGREGATE_MAP_PRIME={root,promise};
  promise.finally(()=>{if(AGGREGATE_MAP_PRIME?.promise===promise) AGGREGATE_MAP_PRIME=null;});
  return promise;
}
async function invalidateAggregateMap(){
  AGGREGATE_MAP_DIRTY=true;
  AGGREGATE_MAP_MEMORY=null;
  AGGREGATE_MAP_PRIME=null;
  try{
    await baseWriteFile(AGGREGATE_MAP_PATH,"<!-- STICKSHIFT MAP CACHE INVALID -->\n");
  }catch(error){
    if(error?.name!=="NotFoundError") log(`Aggregate map invalidation warning: ${error?.message||error}`,"amb");
  }
}
async function rebuildAggregateMap(){
  const started=performance.now();
  const graph=await readGeneratedIndexGraph();
  if(!graph.ok) throw new Error(`Aggregate map rebuild failed: ${graph.reason}`);
  const rendered=aggregateMapBody(graph.records);
  const text=aggregateCacheText(rendered.body,rendered.mapCount,rendered.gatedCount);
  await baseWriteFile(AGGREGATE_MAP_PATH,text);
  AGGREGATE_MAP_DIRTY=false;
  setAggregateMemory(ROOT,{body:rendered.body,mapCount:rendered.mapCount,gatedCount:rendered.gatedCount},"aggregate-memory");
  const elapsed=performance.now()-started;
  log(`Aggregate map rebuilt: ${rendered.mapCount} maps · ${fmtMs(elapsed)}.`,"ok");
  return {elapsed,...rendered};
}

const baseWriteFile=writeFile;
writeFile=async function(path,content){
  const clean=String(path||"").replace(/\\/g,"/").replace(/^\/+/,"");
  const parts=clean.split("/").filter(Boolean);
  const leaf=parts.at(-1)||"";
  const mapRelevant=isConcept(leaf)&&!parts.some(part=>isSystemDir(part));
  if(mapRelevant&&!AGGREGATE_MAP_DIRTY) await invalidateAggregateMap();
  return baseWriteFile(path,content);
};

/* Full index regeneration is optimized separately from incremental writes:
   - scan directory siblings concurrently by depth;
   - read concept bodies concurrently per folder;
   - skip index writes when generated contents are unchanged;
   - expose progress without changing the deterministic index format. */
let INDEX_PROGRESS_HANDLER=null;
let LAST_INDEX_REGEN_STATS=null;

function setIndexProgressHandler(handler){
  INDEX_PROGRESS_HANDLER=typeof handler==="function"?handler:null;
}
function reportIndexProgress(stage,detail={}){
  try{INDEX_PROGRESS_HANDLER?.({stage,...detail});}catch{}
}
async function mapWithLimit(items,limit,worker){
  if(!items.length) return [];
  const out=new Array(items.length);
  let next=0;
  async function run(){
    while(true){
      const i=next++;
      if(i>=items.length) return;
      out[i]=await worker(items[i],i);
    }
  }
  const workers=Math.min(Math.max(1,limit),items.length);
  await Promise.all(Array.from({length:workers},()=>run()));
  return out;
}
async function scanIndexTreeParallel(){
  const started=performance.now();
  const root={dir:"",name:"",handle:ROOT,concepts:[],children:[],qualifyingChildren:[],qualifies:true};
  let frontier=[root];
  let directories=0,concepts=0,rounds=0;

  while(frontier.length){
    const batch=frontier;
    frontier=[];
    rounds++;

    await mapWithLimit(batch,6,async node=>{
      const foundConcepts=[];
      const foundChildren=[];
      for await(const [entryName,h] of node.handle.entries()){
        if(entryName.startsWith(".")||isSystemDir(entryName)) continue;
        if(h.kind==="directory"){
          const childDir=node.dir?node.dir+"/"+entryName:entryName;
          foundChildren.push({
            dir:childDir,
            name:entryName,
            handle:h,
            concepts:[],
            children:[],
            qualifyingChildren:[],
            qualifies:false
          });
        }else if(isConcept(entryName)){
          foundConcepts.push(entryName);
        }
      }
      foundConcepts.sort();
      foundChildren.sort((a,b)=>a.name.localeCompare(b.name));
      node.concepts=foundConcepts;
      node.children=foundChildren;
      directories++;
      concepts+=foundConcepts.length;
      reportIndexProgress("scan",{directories,concepts,round:rounds});
    });

    for(const node of batch) frontier.push(...node.children);
  }

  function finalize(node){
    for(const child of node.children) finalize(child);
    node.qualifyingChildren=node.children.filter(child=>child.qualifies);
    node.qualifies=node.dir===""||node.concepts.length>0||node.qualifyingChildren.length>0;
  }
  finalize(root);

  return {root,directories,concepts,rounds,scanMs:performance.now()-started};
}
async function readNodeConceptEntries(node){
  return Promise.all(node.concepts.map(async name=>{
    const fh=await node.handle.getFileHandle(name,false);
    return [name,await (await fh.getFile()).text()];
  }));
}
async function readNodeIndex(node){
  try{
    const fh=await node.handle.getFileHandle("index.md",false);
    return await (await fh.getFile()).text();
  }catch(error){
    if(error?.name==="NotFoundError") return null;
    throw error;
  }
}
async function writeNodeIndex(node,text){
  const fh=await node.handle.getFileHandle("index.md",{create:true});
  const writer=await fh.createWritable();
  await writer.write(text);
  await writer.close();
}
async function removeNodeIndex(node){
  try{
    await node.handle.removeEntry("index.md");
    return true;
  }catch(error){
    if(error?.name==="NotFoundError") return false;
    throw error;
  }
}
async function generateIndexesOptimized(){
  if(!requireRoot()) return 0;
  const scan=await scanIndexTreeParallel();
  const nodes=[];
  (function collect(node){
    nodes.push(node);
    for(const child of node.children) collect(child);
  })(scan.root);

  const qualifying=nodes.filter(node=>node.qualifies);
  const started=performance.now();
  let processed=0,updated=0,unchanged=0,removed=0;

  reportIndexProgress("write",{
    processed,total:nodes.length,updated,unchanged,removed,
    maps:qualifying.length
  });

  await mapWithLimit(nodes,4,async node=>{
    if(!node.qualifies){
      if(node.dir&&await removeNodeIndex(node)) removed++;
    }else{
      const entries=await readNodeConceptEntries(node);
      const rendered=renderGeneratedIndex(
        node.dir,
        entries,
        node.qualifyingChildren.map(child=>child.name)
      );
      const existing=await readNodeIndex(node);
      if(existing===rendered.text){
        unchanged++;
      }else{
        await writeNodeIndex(node,rendered.text);
        updated++;
      }
    }
    processed++;
    reportIndexProgress("write",{
      processed,total:nodes.length,updated,unchanged,removed,
      maps:qualifying.length
    });
  });

  LAST_INDEX_REGEN_STATS={
    maps:qualifying.length,
    directories:scan.directories,
    concepts:scan.concepts,
    scanRounds:scan.rounds,
    scanMs:scan.scanMs,
    writeMs:performance.now()-started,
    updated,unchanged,removed
  };
  return qualifying.length;
}

generateIndexes=generateIndexesOptimized;
const baseGenerateIndexes=generateIndexes;
generateIndexes=async function(){
  if(!AGGREGATE_MAP_DIRTY) await invalidateAggregateMap();
  const count=await baseGenerateIndexes();
  reportIndexProgress("aggregate",{maps:count,stats:LAST_INDEX_REGEN_STATS});
  const aggregate=await rebuildAggregateMap();
  if(LAST_INDEX_REGEN_STATS) LAST_INDEX_REGEN_STATS.aggregateMs=aggregate.elapsed;
  reportIndexProgress("complete",{maps:count,stats:LAST_INDEX_REGEN_STATS});
  return count;
};

const baseUpdateIndexesForWrites=updateIndexesForWrites;
updateIndexesForWrites=async function(writes){
  const result=await baseUpdateIndexesForWrites(writes);
  if(result.mode==="none"&&!AGGREGATE_MAP_DIRTY) return result;
  const aggregate=await rebuildAggregateMap();
  return {...result,aggregateMs:aggregate.elapsed};
};

const baseBuildIndexBundle=buildIndexBundle;
buildIndexBundle=async function(){
  if(!requireRoot()) return null;
  const started=performance.now();
  let cached=AGGREGATE_MAP_MEMORY?.root===ROOT?AGGREGATE_MAP_MEMORY:null;
  if(!cached&&AGGREGATE_MAP_PRIME?.root===ROOT) cached=await AGGREGATE_MAP_PRIME.promise;
  if(!cached) cached=await loadAggregateMap(ROOT);
  if(cached&&!AGGREGATE_MAP_DIRTY){
    const text=bundleHeader("index",0,cached.mapCount,0)+cached.body;
    return {
      text,f:0,m:cached.mapCount,s:0,chars:text.length,gated:cached.gatedCount,
      indexReadMode:cached.source||"aggregate-file",indexFiles:1,
      mapReadMs:performance.now()-started,readRounds:cached.source==="aggregate-memory"?0:1,
      fallbackReason:""
    };
  }
  return baseBuildIndexBundle();
};

const baseSetEngaged=setEngaged;
setEngaged=function(handle){
  baseSetEngaged(handle);
  AGGREGATE_MAP_DIRTY=false;
  AGGREGATE_MAP_MEMORY=null;
  AGGREGATE_MAP_PRIME=null;
  if(handle) primeAggregateMap(handle);
};
