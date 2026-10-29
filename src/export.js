import {escapeXML,formatNumber,allFeatures} from './scale.js';
import {mapLayout,mapDimensions,plainTitle} from './legend.js';

function frameRect(map,config){
  const ratio=config.export_width/config.export_height;
  const w=map.getContainer().clientWidth,h=map.getContainer().clientHeight;
  const availableWidth=Math.max(1,w-48),availableHeight=Math.max(1,h-48);
  const height=Math.min(availableHeight,availableWidth/ratio),width=height*ratio;
  return {x:(w-width)/2,y:(h-height)/2,width,height};
}
function waitForMap(map,timeout=45000){
  return new Promise((resolve,reject)=>{
    const errors=[];
    const fail=e=>errors.push(e.error?.message||'Ошибка подложки');
    const timer=setTimeout(()=>{cleanup();reject(new Error('Подложка не успела загрузиться. Дождитесь её появления на карте и повторите экспорт.'));},timeout);
    function cleanup(){clearTimeout(timer);map.off('idle',done);map.off('error',fail);}
    function done(){cleanup();if(errors.length)reject(new Error('Ошибка загрузки подложки при экспорте: '+errors[0]));else resolve();}
    map.on('error',fail);map.once('idle',done);map.triggerRepaint();
  });
}
function visibleFeatures(data,bounds){
  return data.features.filter(f=>{
    const ring=f.geometry.coordinates[0];let w=Infinity,s=Infinity,e=-Infinity,n=-Infinity;
    for(const [lon,lat]of ring){w=Math.min(w,lon);s=Math.min(s,lat);e=Math.max(e,lon);n=Math.max(n,lat);}
    return e>=bounds[0]&&w<=bounds[2]&&n>=bounds[1]&&s<=bounds[3];
  });
}
function composeSVG(config,layout,mapContent){
  const {width,height}=layout;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${config.export_width}" height="${config.export_height}" viewBox="0 0 ${width} ${height}"><defs><clipPath id="crop"><rect width="${width}" height="${height}"/></clipPath></defs><rect width="100%" height="100%" fill="#fbfcf8"/><g clip-path="url(#crop)">${mapContent}${layout.svg}</g></svg>`;
}
async function svgToPNG(svg,width,height){
  const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
  try{
    const img=new Image();img.src=url;await img.decode();
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');if(!context)throw new Error('Не удалось создать PNG.');context.drawImage(img,0,0,width,height);
    return await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Не удалось сохранить PNG.')),'image/png'));
  }finally{URL.revokeObjectURL(url);}
}
async function localText(path){const response=await fetch(new URL(path,import.meta.url));if(!response.ok)throw new Error(`Не удалось прочитать ${path}: ${response.status}`);return response.text();}
function inlineScript(source){return source.replace(/^\s*\/\/# sourceMappingURL=.*$/gm,'').replace(/<\/script/gi,'<\\/script');}
function asClassic(source){return source.replace(/^import .*?;\s*$/gm,'').replace(/^export \{[^}]*\};?\s*$/gm,'');}
async function offlineHTML(payload){
  const [mapJS,h3JS,mapCSS,scaleJS,legendJS,viewerJS]=await Promise.all(['../vendor/maplibre-gl.js','../vendor/h3-js.js','../vendor/maplibre-gl.css','./scale.js','./legend.js','./viewer.js'].map(localText));
  const json=JSON.stringify(payload).replace(/</g,'\\u003c').replace(/&/g,'\\u0026');
  const code=inlineScript([asClassic(scaleJS),asClassic(legendJS),asClassic(viewerJS)].join('\n'));
  return new Blob([`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeXML(plainTitle(payload.config.title)||'Гексагональная карта')}</title><style>${mapCSS}</style><style>
*{box-sizing:border-box}html,body{height:100%;margin:0;font:14px Arial,sans-serif;color:#25332f;background:#eef0e9}body{display:flex}aside{order:2;width:230px;flex-shrink:0;padding:24px 20px;background:#fbfcf8;border-left:1px solid #e1e5dc;overflow:auto}h2{font-size:14px;letter-spacing:2px;margin:0 0 24px}p{line-height:1.6;color:#758077}select,button{font:inherit;padding:9px;border:1px solid #dbe1d9;border-radius:5px;background:white;color:#25332f;width:100%}button{cursor:pointer;margin-top:14px}#group-row{display:block;margin-bottom:12px}#group{margin-top:8px}#map-area{position:relative;flex:1;min-width:0;order:1}#map-sheet{position:absolute}#map{height:100%;width:100%}#map-overlay{position:absolute;inset:0;pointer-events:none}#map-overlay>svg{display:block;width:100%;height:100%}[hidden]{display:none!important}.maplibregl-popup-content{font:13px/1.6 Arial,sans-serif}.maplibregl-popup-content strong{font-size:22px}#viewer-error{background:#fff5ed;color:#853f20;padding:12px;line-height:1.5;margin-top:16px}small{font-size:11px;color:#78847e}a{color:inherit}@media(max-width:620px){body{flex-direction:column}#map-area{height:65%;flex:none}aside{width:100%;height:35%;border-left:0;border-top:1px solid #e1e5dc;padding:16px}h2{margin-bottom:12px}}
</style></head><body><aside><h2>HEX MAP</h2><label id="group-row">Группа <select id="group"></select></label><button id="fit">Показать область</button><p><small>Автономная карта. Подложка — снимок: при увеличении новые детали не появляются.</small></p><p><small>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Protomaps · ESA WorldCover</small></p><div id="viewer-error" role="alert" hidden></div></aside><main id="map-area"><div id="map-sheet"><div id="map"></div><div id="map-overlay" aria-label="Заголовок и легенда карты"></div></div></main><script id="payload" type="application/json">${json}</script><script>${inlineScript(mapJS)}</script><script>${inlineScript(h3JS)}</script><script>${code}\nstartViewer(JSON.parse(document.getElementById('payload').textContent));</script></body></html>`],{type:'text/html;charset=utf-8'});
}
async function exportResult(kind,{map,config,data,features,activeGroup,baseLayers,frame}){
  const {createScale}=await import('./scale.js');
  const values=(config.scale_scope==='global'?data.features:features).map(f=>f.properties.value);
  const scale=createScale(values,config);if(scale.binWarning)throw new Error(scale.binWarning);
  const layout=mapLayout(config,scale,features);if(layout.warning)throw new Error(layout.warning);
  const d=mapDimensions(config),nw=map.unproject([frame.x,frame.y]),se=map.unproject([frame.x+frame.width,frame.y+frame.height]);
  const bounds=[nw.lng,se.lat,se.lng,nw.lat];
  const container=document.createElement('div');Object.assign(container.style,{position:'fixed',left:'-100000px',top:'0',width:`${d.width}px`,height:`${d.height}px`,pointerEvents:'none'});document.body.append(container);
  const exportMap=new maplibregl.Map({container,style:map.getStyle(),center:map.getCenter(),zoom:map.getZoom(),pixelRatio:d.pixelRatio,maxCanvasSize:[16384,16384],renderWorldCopies:false,pitch:0,maxPitch:0,interactive:false,attributionControl:false,canvasContextAttributes:{preserveDrawingBuffer:true,antialias:true}});
  try{
    exportMap.fitBounds([[bounds[0],bounds[1]],[bounds[2],bounds[3]]],{padding:0,duration:0});await waitForMap(exportMap);
    if(exportMap.getCanvas().width<config.export_width-4)throw new Error('Видеоустройство ограничило размер карты. Уменьшите ширину/высоту экспорта.');
    let content;
    if(kind==='png'){
      content=`<image width="${d.width}" height="${d.height}" href="${exportMap.getCanvas().toDataURL('image/png')}"/>`;
    }else{
      for(const id of ['hex-fill','hex-outline'])exportMap.setLayoutProperty(id,'visibility','none');
      for(const layer of baseLayers)if(layer.type==='symbol')exportMap.setLayoutProperty(layer.id,'visibility','none');
      await waitForMap(exportMap);const base=exportMap.getCanvas().toDataURL(kind==='html'?'image/webp':'image/png',.88);
      for(const layer of baseLayers){const original=map.getLayoutProperty(layer.id,'visibility')||'visible';exportMap.setLayoutProperty(layer.id,'visibility',layer.type==='symbol'&&original!=='none'?'visible':'none');}
      await waitForMap(exportMap);const labels=exportMap.getCanvas().toDataURL('image/png');
      const actual=exportMap.getBounds(),imageBounds=[actual.getWest(),actual.getSouth(),actual.getEast(),actual.getNorth()];
      if(kind==='html'){
        let included=visibleFeatures(data,imageBounds);if(!config.html_all_groups&&activeGroup!==null)included=included.filter(f=>f.properties.group===activeGroup);
        if(!included.length)throw new Error('В рамке экспорта нет гексов. Переместите карту.');
        const groups=[...new Set(included.map(f=>f.properties.group))],cells=[],index=new Map();
        const rows=included.map(f=>{const p=f.properties;if(!index.has(p.hex_id)){index.set(p.hex_id,cells.length);cells.push(p.hex_id);}return [index.get(p.hex_id),p.value,groups.indexOf(p.group),p.details];});
        const domain=features=>{const finite=features.map(f=>f.properties.value).filter(v=>typeof v==='number'&&Number.isFinite(v));return finite.length?[finite.reduce((a,b)=>Math.min(a,b)),finite.reduce((a,b)=>Math.max(a,b)),...(finite.includes(0)?[0]:[])]:[];};
        const globalValues=domain(data.features),all=allFeatures(data.features);
        const byGroup=new Map(groups.map(group=>[group,[]]));
        for(const feature of data.features)byGroup.get(feature.properties.group)?.push(feature);
        const domains={all:domain(all),groups:Object.fromEntries(groups.map(group=>[group,domain(byGroup.get(group))]))};
        const missing=list=>list.filter(f=>f.properties.value===null).length;
        const legendCounts={all:missing(all),groups:Object.fromEntries(groups.map(group=>[group,missing(byGroup.get(group))]))};
        return offlineHTML({version:1,config,activeGroup,groups,cells,rows,globalValues,domains,legendCounts,bounds:imageBounds,background:base,labels});
      }
      const paths=features.map(f=>{
        const points=f.geometry.coordinates[0].map(c=>exportMap.project(c));
        if(points.every(p=>p.x<0)||points.every(p=>p.x>d.width)||points.every(p=>p.y<0)||points.every(p=>p.y>d.height))return '';
        const path=points.map((p,i)=>`${i?'L':'M'}${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(' ')+' Z';
        return `<path data-hex-id="${escapeXML(f.properties.hex_id)}" d="${path}" fill="${scale.color(f.properties.value)}" fill-opacity="${config.opacity}" stroke="white" stroke-width=".6" stroke-opacity="${config.outline?Math.min(1,config.opacity+.1):0}"><title>${escapeXML(f.properties.hex_id)}: ${escapeXML(formatNumber(f.properties.value,config.decimals))}</title></path>`;
      }).join('');
      content=`<image width="${d.width}" height="${d.height}" href="${base}"/><g>${paths}</g><image width="${d.width}" height="${d.height}" href="${labels}"/>`;
    }
    const svg=composeSVG(config,layout,content);
    return kind==='png'?svgToPNG(svg,config.export_width,config.export_height):new Blob([svg],{type:'image/svg+xml;charset=utf-8'});
  }finally{exportMap.remove();container.remove();}
}
export {frameRect,exportResult};
