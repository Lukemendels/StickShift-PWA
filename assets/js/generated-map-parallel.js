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

const baseGenerateIndexes=generateIndexes;
generateIndexes=async function(){
  if(!AGGREGATE_MAP_DIRTY) await invalidateAggregateMap();
  const count=await baseGenerateIndexes();
  await rebuildAggregateMap();
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
