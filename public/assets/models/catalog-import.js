// Read-only XLSX extraction. No macros, formulas, links, or workbook instructions are executed.
const unescapeXml=s=>s.replace(/&#x([a-f0-9]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(+n)).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const texts=xml=>[...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m=>unescapeXml(m[1])).join('');
export async function readCatalogWorkbook(buffer,inflate=async bytes=>new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())){
  if(buffer.byteLength>10*1024*1024)throw new Error('Choose a workbook under 10 MB.');
  const bytes=new Uint8Array(buffer),view=new DataView(buffer);let end=bytes.length-22;
  while(end>=Math.max(0,bytes.length-65557)&&view.getUint32(end,true)!==0x06054b50)end--;
  if(end<0||view.getUint32(end,true)!==0x06054b50)throw new Error('Invalid XLSX file.');
  const count=view.getUint16(end+10,true);if(count>500)throw new Error('Workbook has too many ZIP entries.');
  let pos=view.getUint32(end+16,true),total=0;const files={};
  for(let i=0;i<count;i++){
    if(view.getUint32(pos,true)!==0x02014b50)throw new Error('Invalid XLSX directory.');
    const method=view.getUint16(pos+10,true),compressed=view.getUint32(pos+20,true),size=view.getUint32(pos+24,true),nl=view.getUint16(pos+28,true),el=view.getUint16(pos+30,true),cl=view.getUint16(pos+32,true),off=view.getUint32(pos+42,true),name=new TextDecoder().decode(bytes.slice(pos+46,pos+46+nl));
    total+=size;if(total>40*1024*1024||size>20*1024*1024)throw new Error('Workbook expands beyond the import limit.');
    if(name==='xl/sharedStrings.xml'||/^xl\/worksheets\/sheet\d+\.xml$/.test(name)){
      const start=off+30+view.getUint16(off+26,true)+view.getUint16(off+28,true),part=bytes.slice(start,start+compressed);
      const result=method===0?part:method===8?await inflate(part):null;if(!result||result.length!==size)throw new Error('Unsupported or invalid workbook compression.');files[name]=new TextDecoder().decode(result);
    }pos+=46+nl+el+cl;
  }
  const strings=[...(files['xl/sharedStrings.xml']||'').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m=>texts(m[1]));
  for(const [name,xml]of Object.entries(files)){
    if(!name.startsWith('xl/worksheets/'))continue;
    const data=[...xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map(row=>{
      const cells={};for(const c of row[2].replace(/<c\b[^>]*\/>/g,'').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)){
        const ref=c[1].match(/r="([A-Z]+)\d+"/)?.[1],v=c[2].match(/<v\b[^>]*>([\s\S]*?)<\/v>/)?.[1];
        if(ref)cells[ref]=/t="s"/.test(c[1])?strings[Number(v)]||'':/t="inlineStr"/.test(c[1])?texts(c[2]):unescapeXml(v||'');
      }return {row:Number(row[1].match(/r="(\d+)"/)?.[1]),cells};
    });
    const hi=data.findIndex(r=>Object.values(r.cells).includes('Display Name')&&Object.values(r.cells).includes('Customer'));if(hi<0)continue;
    const header=data[hi].cells,col=label=>Object.keys(header).find(k=>header[k]===label),display=col('Display Name'),customer=col('Customer');
    const rows=data.slice(hi+1).filter(r=>Object.values(r.cells).some(v=>v.trim())).map(r=>{if(!r.cells[display]?.trim())throw new Error('Missing Display Name on row '+r.row);return {displayName:r.cells[display].trim(),customer:r.cells[customer]?.trim()||'',sourceRow:r.row};});
    if(!rows.length)throw new Error('Workbook has no catalog entries.');return rows;
  }throw new Error('No sheet contains Customer and Display Name headers.');
}
