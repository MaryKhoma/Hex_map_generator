import {createScale,allFeatures,choosePalette,escapeXML,formatNumber} from './scale.js';
import {mapLayout,plainTitle} from './legend.js';

/* The offline viewer uses one raster background and one label overlay for every group. */
function startViewer(payload){
  const config=payload.config,format=v=>formatNumber(v,config.decimals);
  const $=id=>document.getElementById(id);
  const geometry=payload.cells.map(cell=>({type:'Polygon',coordinates:[h3.cellToBoundary(cell,true)]}));
  const data={type:'FeatureCollection',features:payload.rows.map((row,i)=>({type:'Feature',id:i,geometry:geometry[row[0]],properties:{hex_id:payload.cells[row[0]],value:row[1],group:payload.groups[row[2]],details:row[3]||{}}}))};
  const all=allFeatures(data.features);let active=payload.activeGroup,features=[],popup;
  if(!payload.groups.includes(active))active=null;
  document.title=plainTitle(config.title)||'Гексагональная карта';
  const blank=document.createElement('option');blank.value='';blank.textContent='Все';$('group').append(blank);
  for(const group of payload.groups){const option=document.createElement('option');option.value=group;option.textContent=group==='Все'?'Все (группа)':group;$('group').append(option);}
  $('group').value=active??'';$('group-row').hidden=payload.groups.length<2;
  function sizeSheet(){
    const container=$('map-area'),ratio=config.export_width/config.export_height;
    const width=Math.min(Math.max(1,container.clientWidth-48),Math.max(1,container.clientHeight-48)*ratio),height=width/ratio;
    Object.assign($('map-sheet').style,{width:`${width}px`,height:`${height}px`,left:`${(container.clientWidth-width)/2}px`,top:`${(container.clientHeight-height)/2}px`});
  }
  sizeSheet();
  const imageCoordinates=[[payload.bounds[0],payload.bounds[3]],[payload.bounds[2],payload.bounds[3]],[payload.bounds[2],payload.bounds[1]],[payload.bounds[0],payload.bounds[1]]];
  const map=new maplibregl.Map({container:'map',style:{version:8,sources:{background:{type:'image',url:payload.background,coordinates:imageCoordinates},labels:{type:'image',url:payload.labels,coordinates:imageCoordinates}},layers:[{id:'background',type:'raster',source:'background',paint:{'raster-fade-duration':0}},{id:'labels',type:'raster',source:'labels',paint:{'raster-fade-duration':0}}]},center:[(payload.bounds[0]+payload.bounds[2])/2,(payload.bounds[1]+payload.bounds[3])/2],zoom:10,maxZoom:19,renderWorldCopies:false,maxPitch:0,pitch:0,dragRotate:false,touchPitch:false,attributionControl:false});
  map.touchZoomRotate.disableRotation();map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
  function fit(){map.fitBounds([[payload.bounds[0],payload.bounds[1]],[payload.bounds[2],payload.bounds[3]]],{padding:0,duration:0});}
  function update(){
    features=active===null?all:data.features.filter(f=>f.properties.group===active);
    const options=structuredClone(config);
    const values=config.scale_scope==='global'?payload.globalValues:(active===null?payload.domains.all:payload.domains.groups[active]);
    choosePalette(options,values);
    const scale=createScale(values,options);
    map.getSource('hexes').setData({type:'FeatureCollection',features});
    map.setPaintProperty('hexes-fill','fill-color',scale.expression);
    const missing=active===null?payload.legendCounts.all:payload.legendCounts.groups[active];
    const layout=mapLayout(options,scale,features,missing);
    $('map-overlay').innerHTML=layout.svg;
    $('viewer-error').hidden=!layout.warning;$('viewer-error').textContent=layout.warning;
    popup?.remove();
  }
  map.on('load',()=>{
    map.addSource('hexes',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
    map.addLayer({id:'hexes-fill',type:'fill',source:'hexes',paint:{'fill-color':'#dddddd','fill-opacity':config.opacity}},'labels');
    map.addLayer({id:'hexes-outline',type:'line',source:'hexes',paint:{'line-color':'white','line-width':.6,'line-opacity':config.outline?Math.min(1,config.opacity+.1):0}},'labels');
    popup=new maplibregl.Popup({closeButton:false,closeOnClick:false});
    map.on('mousemove','hexes-fill',event=>{
      if(!config.hover||!event.features?.length)return;
      const p=event.features[0].properties;let details=p.details||{};
      if(typeof details==='string'){try{details=JSON.parse(details);}catch{details={};}}
      let text=`<div>${escapeXML(p.group)}</div><strong>${escapeXML(format(p.value))}${p.value!==null&&config.unit?' '+escapeXML(config.unit):''}</strong><div>${escapeXML(p.hex_id)}</div>`;
      let values=p.group_values||[];if(typeof values==='string'){try{values=JSON.parse(values);}catch{values=[];}}
      for(const item of values)text+=`<div>${escapeXML(item.group)}: ${escapeXML(format(item.value))}</div>`;
      for(const [key,value]of Object.entries(details))text+=`<div>${escapeXML(key)}: ${escapeXML(value)}</div>`;
      map.getCanvas().style.cursor='pointer';popup.setLngLat(event.lngLat).setHTML(text).addTo(map);
    });
    map.on('mouseleave','hexes-fill',()=>{map.getCanvas().style.cursor='';popup.remove();});
    $('group').onchange=()=>{active=$('group').value||null;update();};$('fit').onclick=fit;
    update();fit();
  });
  window.addEventListener('resize',()=>{
    const previous=map.getContainer().clientWidth,zoom=map.getZoom();
    sizeSheet();map.resize();
    const current=map.getContainer().clientWidth;
    if(previous>0&&current>0)map.jumpTo({zoom:zoom+Math.log2(current/previous)});
  });
  map.on('error',()=>{$('viewer-error').hidden=false;$('viewer-error').textContent='Браузеру не удалось отрисовать карту. Проверьте поддержку WebGL.';});
}
export {startViewer};
