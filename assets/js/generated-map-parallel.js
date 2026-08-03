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
