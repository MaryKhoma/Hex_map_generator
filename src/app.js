import * as HexScale from "./scale.js";
import {defaultConfig,validateConfig,escapeXML,formatNumber} from "./scale.js";
import {mapLayout,plainTitle} from "./legend.js";
import {exportResult,frameRect} from "./export.js";

const $ = id => document.getElementById(id);
const layerNames = {labels:"Подписи",roads:"Дороги",buildings:"Здания",water:"Вода",parks:"Парки",boundaries:"Границы",poi:"Объекты / POI"};
let map,config=defaultConfig(),data=null,scale,allFeatures=[],features=[],baseLayers=[],labelLayers=[],activeGroup=null,popup;
let regions=[],city,loaded=false,exporting=false,worker,requestId=0,parsed=false,fileName="",columns=null,pendingCamera=null,pendingGroup=undefined,cityLoadId=0;
let previewMessage=null,layoutWarning='';
const fmt=value=>formatNumber(value,config.decimals),tick=fmt;
const error=message=>{$("error-text").textContent=message;$("error").hidden=false;};
const clearError=()=>{$("error").hidden=true;};
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function getJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
function belongs(layer) {
  const source = layer["source-layer"] || "", id = layer.id;
  return {labels:layer.type === "symbol", roads:source === "roads" || /road|highway|railway|transit/.test(id),
    buildings:source === "buildings", water:source === "water", parks:source === "landuse" || source === "landcover",
    boundaries:source === "boundaries", poi:source === "pois"};
}
function layerVisible(layer) {
  const categories = belongs(layer);
  return Object.keys(layerNames).every(key => !categories[key] || config.basemap_visibility[key] !== false);
}
function updateBase() {
  if(!loaded)return;
  for (const layer of baseLayers) map.setLayoutProperty(layer.id, "visibility", layerVisible(layer) ? "visible" : "none");
}
function scaledTextSize(size, factor) {
  const multiply = value => typeof value === "number" ? value * factor : ["*",value,factor];
  if (Array.isArray(size) && size[0] === "interpolate") {
    return size.map((value,i) => i >= 4 && i % 2 === 0 ? multiply(value) : value);
  }
  if (Array.isArray(size) && size[0] === "step") {
    return size.map((value,i) => i >= 2 && i % 2 === 0 ? multiply(value) : value);
  }
  return multiply(size);
}
function updateLabels() {
  if(!loaded)return;
  for (const layer of labelLayers) {
    map.setLayoutProperty(layer.id,"text-size",scaledTextSize(layer.size,config.label_size_scale));
    map.setPaintProperty(layer.id,"text-color",config.label_text_color);
    map.setPaintProperty(layer.id,"text-halo-color",config.label_halo_enabled ? config.label_halo_color : "rgba(0,0,0,0)");
    map.setPaintProperty(layer.id,"text-halo-width",config.label_halo_enabled ? layer.haloWidth : 0);
  }
}
function fit() {
  const [w,s,e,n] = config.bounds;
  const frame=frameRect(map,config),container=map.getContainer();
  map.fitBounds([[w,s],[e,n]], {padding:{top:frame.y+30,bottom:container.clientHeight-frame.y-frame.height+30,left:frame.x+30,right:container.clientWidth-frame.x-frame.width+30}, maxZoom:14, duration:600});
}
function updatePreview() {
  const layout=mapLayout(config,data&&coverageValid()?scale:null,features);
  $("map-overlay").innerHTML=layout.svg;
  layoutWarning=layout.warning;
  $("layout-message").hidden=!layoutWarning;$("layout-message").textContent=layoutWarning;
  document.title=plainTitle(config.title)||'Гексагональная карта';
  updateExportButtons();
}
function update() {
  if(!data||!loaded)return;
  if(!coverageValid()){
    features=[];map.getSource("hexes").setData({type:"FeatureCollection",features:[]});
    const suggestion=regions.find(r=>config.bounds[0]>=r.bounds[0]&&config.bounds[1]>=r.bounds[1]&&config.bounds[2]<=r.bounds[2]&&config.bounds[3]<=r.bounds[3]);
    error("Данные выходят за покрытие выбранной подложки."+(suggestion?` Выберите «${suggestion.name}».`:" Выберите подложку подходящей территории."));
    updatePreview();$("status").textContent="Территория CSV не соответствует подложке";updateExportButtons();return;
  }
  features = activeGroup === null ? allFeatures : data.features.filter(f => f.properties.group === activeGroup);
  const values = (config.scale_scope === "global" ? data.features : features).map(f => f.properties.value);
  restrictPalettes(values);
  applyPalette(values);
  scale = HexScale.createScale(values, config);
  map.getSource("hexes").setData({type:"FeatureCollection",features});
  map.setPaintProperty("hex-fill", "fill-color", scale.expression);
  map.setPaintProperty("hex-fill", "fill-opacity", config.opacity);
  map.setPaintProperty("hex-outline", "line-opacity", config.outline ? Math.min(1,config.opacity+.1) : 0);
  $("count").textContent = features.length.toLocaleString("ru-RU");
  const actual = features.map(f => f.properties.value).filter(v => v !== null);
  $("range").textContent = actual.length ? `${fmt(actual.reduce((a,b)=>Math.min(a,b)))} … ${fmt(actual.reduce((a,b)=>Math.max(a,b)))}` : "Нет данных";
  $("bin-row").hidden = $("custom-bins-row").hidden = config.scale_mode !== "discrete";
  $("bins").disabled = scale.customBins;
  $("bin-edges-message").hidden = !scale.binWarning;
  $("bin-edges-message").textContent = scale.binWarning ? `${scale.binWarning} Сейчас показаны автоматические интервалы; исправьте границы и нажмите «Применить».` : "";
  $("continuous").classList.toggle("active", config.scale_mode === "continuous");
  $("discrete").classList.toggle("active", config.scale_mode === "discrete");
  $("opacity-label").textContent = `${Math.round(config.opacity*100)}%`;
  $("symmetric").disabled = scale.customBins || !(scale.negative && scale.positive);
  $("negative-palette").hidden = $("negative-label").hidden = !scale.negative;
  $("positive-palette").hidden = $("positive-label").hidden = !scale.positive;
  $("negative-label").textContent = scale.hasZero ? "Отрицательные: от минимума к нулю" : "Цвета от минимума к максимуму";
  $("positive-label").textContent = scale.hasZero ? "Положительные: от нуля к максимуму" : "Цвета от минимума к максимуму";
  $("zero-label").textContent = scale.hasZero ? "Точка 0" : (scale.negative ? "Цвет максимума" : "Цвет минимума");
  $("zero_color").setAttribute("aria-label",$("zero-label").textContent);
  $("zero_color").closest(".colors").hidden = scale.empty || (scale.constant && !scale.hasZero);
  $("bin-row").querySelector("label").textContent = scale.negative && scale.positive ? "Интервалов на каждой стороне нуля" : "Число интервалов";
  popup?.remove();
  updateFrame();updateExportButtons();
}
function restrictPalettes(values) {
  const mixed = HexScale.mixedSigns(values);
  for (const name of Object.keys(HexScale.sequentialPalettes)) {
    const option = $("palette").querySelector(`option[value="${name}"]`);
    option.disabled = mixed;
  }
  $("palette").querySelector('option[value="custom"]').textContent = mixed ? "Своя расходящаяся" : "Своя палитра";
  const replaced = mixed && (!!HexScale.sequentialPalettes[config.palette_name]
    || (config.palette_name === "custom" && config.custom_palette_kind === "sequential"));
  if (replaced) {config.palette_name = "classic"; config.bin_colors=[]; $("palette").value = "classic";}
  $("palette-note").hidden = !mixed;
  $("palette-note").textContent = replaced
    ? "Есть значения обоих знаков: выбрана расходящаяся сине-красная палитра."
    : "Для значений обоих знаков доступны только расходящиеся палитры с точкой 0.";
}
function setPaletteColors(palette) {
  config.negative_palette = [...palette.negative]; config.positive_palette = [...palette.positive];
  config.negative_color = palette.negative[0]; config.positive_color = palette.positive[palette.positive.length-1];
  config.zero_color = palette.zero; $("zero_color").value = config.zero_color;
  const preset=HexScale.presetBins[config.palette_name];
  if(preset&&JSON.stringify(config.bin_edges)===JSON.stringify(preset.edges))config.bin_colors=config.reverse_palette?[...preset.colors].reverse():[...preset.colors];
  renderPaletteControls();
}
function applyPalette(values) {
  const palette = HexScale.paletteForValues(config.palette_name,values,config.reverse_palette);
  if (!palette) return;
  if (palette.zero === config.zero_color && JSON.stringify(palette.negative) === JSON.stringify(config.negative_palette)
      && JSON.stringify(palette.positive) === JSON.stringify(config.positive_palette)) return;
  setPaletteColors(palette);
}
function useCustomPalette() {
  if (HexScale.sequentialPalettes[config.palette_name]) config.custom_palette_kind = "sequential";
  else if (HexScale.palettes[config.palette_name]) config.custom_palette_kind = "diverging";
  config.bin_colors=[];
  config.palette_name = "custom"; $("palette").value = "custom";
  config.reverse_palette = false; $("reverse-palette").checked = false;
}
function renderPaletteControls() {
  for (const side of ["negative", "positive"]) {
    const colors = config[`${side}_palette`], row = $(`${side}-palette`);
    row.replaceChildren();
    colors.forEach((color,i) => {
      const input = document.createElement("input"); input.type = "color"; input.value = color;
      input.setAttribute("aria-label", `${side === "negative" ? "Отрицательные" : "Положительные"}: цвет ${i+1}`);
      input.oninput = () => {
        colors[i] = input.value;
        config[`${side}_color`] = side === "negative" ? colors[0] : colors[colors.length-1];
        useCustomPalette(); update();
      };
      row.append(input);
    });
    for (const [label,delta] of [["+",1],["−",-1]]) {
      const button = document.createElement("button"); button.textContent = label;
      button.title = delta > 0 ? "Добавить цвет" : "Удалить последний цвет";
      button.disabled = delta > 0 ? colors.length >= 8 : colors.length <= 1;
      button.onclick = () => {
        if (delta > 0) {
          if (side === "negative") colors.push(HexScale.mix(colors[colors.length-1],config.zero_color,.5));
          else colors.splice(colors.length-1,0,HexScale.mix(colors.length > 1 ? colors[colors.length-2] : config.zero_color,colors[colors.length-1],.5));
        } else colors.pop();
        config[`${side}_color`] = side === "negative" ? colors[0] : colors[colors.length-1];
        useCustomPalette(); renderPaletteControls(); update();
      };
      row.append(button);
    }
  }
}
function setupControls() {
  document.title = plainTitle(config.title);
  $("resolution").textContent = config.resolution ? `уровень ${config.resolution}` : "";
  $("meta").textContent = "Выберите CSV на своём компьютере.";
  $("group").onchange=()=>{activeGroup=$("group").value||null;update();};
  if (!config.palette_name) {
    config.palette_name = Object.keys(HexScale.palettes).find(key => {
      const palette = HexScale.palettes[key];
      return palette.zero === config.zero_color && JSON.stringify(palette.negative) === JSON.stringify(config.negative_palette)
        && JSON.stringify(palette.positive) === JSON.stringify(config.positive_palette);
    }) || "custom";
  }
  $("palette").value = config.palette_name;
  renderPaletteControls();
  $("palette").onchange = () => {
    if ($("palette").value === "custom" && config.palette_name !== "custom") {
      config.custom_palette_kind = HexScale.sequentialPalettes[config.palette_name] ? "sequential" : "diverging";
    }
    config.palette_name = $("palette").value;
    const preset=HexScale.presetBins[config.palette_name];
    if(preset){config.scale_mode="discrete";config.bin_edges=[...preset.edges];config.bin_colors=config.reverse_palette?[...preset.colors].reverse():[...preset.colors];$("bin-edges").value=preset.edges.join("; ");}
    else config.bin_colors=[];
    update();
  };
  $("reverse-palette").checked = !!config.reverse_palette;
  $("reverse-palette").onchange = () => {
    config.reverse_palette = $("reverse-palette").checked;
    if (config.palette_name === "custom" && scale) {
      setPaletteColors(HexScale.reverseColors({negative:config.negative_palette,zero:config.zero_color,positive:config.positive_palette},scale.negative,scale.positive));
    }
    update();
  };
  $("scope").value = config.scale_scope;
  $("scope").onchange = () => {config.scale_scope = $("scope").value; update();};
  $("bin-edges").value = (config.bin_edges || []).map(v=>String(v).replace(".",",")).join("; ");
  $("apply-bin-edges").onclick = () => {
    try {
      const edges = HexScale.parseBinEdges($("bin-edges").value);
      const values = (config.scale_scope === "global" ? (data?.features||[]) : features).map(f=>f.properties.value);
      const message = HexScale.binEdgesError(edges,values);
      if (message) throw new Error(message);
      config.bin_edges = edges; config.bin_colors=[]; update();
    } catch(e) {
      $("bin-edges-message").hidden = false;
      $("bin-edges-message").textContent = `${e.message} Новые границы не применены.`;
    }
  };
  for (const mode of ["continuous", "discrete"]) $(mode).onclick = () => {config.scale_mode = mode; update();};
  for (const key of ["zero_color","opacity","bins","decimals"]) {
    $(key).value = config[key]; $(key).oninput = () => {
      if (!$(key).checkValidity() || $(key).value === "") return;
      config[key] = ["opacity","bins","decimals"].includes(key) ? Number($(key).value) : $(key).value;
      if (key === "zero_color") useCustomPalette();
      update();
    };
  }
  for (const [id,key] of [["symmetric","symmetric"],["outline","outline"],["show-legend","show_legend"],["hover","hover"]]) {
    $(id).checked = config[key]; $(id).onchange = () => {config[key] = $(id).checked; update();};
  }
  for (const [id,key] of [["export-title","title"],["export-subtitle","subtitle"],["legend-title","legend_title"],["unit","unit"]]) {
    $(id).value = config[key]; $(id).oninput = () => {
      config[key] = $(id).value;
      updatePreview();
    };
  }
  for (const [key,name] of Object.entries(layerNames)) {
    const label = document.createElement("label"); label.className = "check";
    const input = document.createElement("input"); input.type = "checkbox"; input.id = `layer-${key}`;
    input.checked = config.basemap_visibility[key] !== false;
    input.onchange = () => {config.basemap_visibility[key] = input.checked; updateBase();};
    label.append(input, document.createTextNode(name)); $("layers").append(label);
  }
  $("label-size").value = Math.round(config.label_size_scale*100);
  $("label-size").oninput = () => {
    if (!$("label-size").checkValidity() || $("label-size").value === "") return;
    config.label_size_scale = Number($("label-size").value)/100; updateLabels();
  };
  for (const key of ["label_text_color","label_halo_color"]) {
    $(key).value = config[key];
    $(key).oninput = () => {config[key] = $(key).value; updateLabels();};
  }
  $("label-no-halo").checked = !config.label_halo_enabled;
  $("label_halo_color").disabled = !config.label_halo_enabled;
  $("label-no-halo").onchange = () => {
    config.label_halo_enabled = !$("label-no-halo").checked;
    $("label_halo_color").disabled = !config.label_halo_enabled;
    updateLabels();
  };
  for (const key of ["legend_title_size","legend_text_size"]) {
    $(key).value = config[key];
    $(key).oninput = () => {
      if (!$(key).checkValidity() || $(key).value === "") return;
      config[key] = Number($(key).value); updatePreview();
    };
  }
  $("share-filename").value = config.share_filename || "map_share.html";
  $("share-filename").oninput = () => {config.share_filename = $("share-filename").value;};
  $("share-html").onclick = ()=>runExport("html");
  $("fit").onclick = ()=>{if(data)fit();else fitCity();};
  $("png").onclick = () => runExport("png"); $("svg").onclick = () => runExport("svg");
  $("save-settings").onclick=()=>{
    const center=map.getCenter();
    const saved={version:1,city:city.id,columns,activeGroup,config,csv:{encoding:$("csv-encoding").value,decimal:$("csv-decimal").value},camera:{center:[center.lng,center.lat],zoom:map.getZoom()}};
    downloadBlob(new Blob([JSON.stringify(saved,null,2)],{type:"application/json"}),"hex_map_settings.json");
  };
  $("load-settings").onchange=loadSettings;
  for(const key of ["export_width","export_height"]){$(key).value=config[key];$(key).oninput=()=>{if($(key).checkValidity()&&$(key).value){config[key]=Number($(key).value);updateFrame();}};}
  $("html-all-groups").checked=config.html_all_groups;
  $("html-all-groups").onchange=()=>{config.html_all_groups=$("html-all-groups").checked;};
}
function setupHover() {
  popup = new maplibregl.Popup({closeButton:false, closeOnClick:false, maxWidth:"330px"});
  map.on("mousemove", "hex-fill", event => {
    if (!config.hover || exporting || !event.features.length) return;
    map.getCanvas().style.cursor = "pointer";
    const props = event.features[0].properties;
    let details = props.details || {};
    if (typeof details === "string") {try {details = JSON.parse(details);} catch {details = {};}}
    let html = `<div>${escapeXML(props.group)}</div><div class="popup-value">${escapeXML(fmt(props.value))}${props.value !== null ? " " + escapeXML(config.unit) : ""}</div><div class="popup-id">${escapeXML(props.hex_id)}</div>`;
    let groupValues = props.group_values || [];
    if (typeof groupValues === "string") {try {groupValues = JSON.parse(groupValues);} catch {groupValues = [];}}
    for (const item of groupValues) html += `<div class="popup-extra">${escapeXML(item.group)}: ${escapeXML(fmt(item.value))}</div>`;
    for (const [key,val] of Object.entries(details)) html += `<div class="popup-extra">${escapeXML(key)}: ${escapeXML(val ?? "—")}</div>`;
    popup.setLngLat(event.lngLat).setHTML(html).addTo(map);
  });
  map.on("mouseleave", "hex-fill", () => {map.getCanvas().style.cursor = ""; popup.remove();});
}

function selectedColumns(){return {hex:$("hex-column").value,value:$("value-column").value,group:$("group-column").value||null,hover:[...$("hover-columns").selectedOptions].map(option=>option.value)};}
function refreshGroups(){
  $("group").replaceChildren();
  const all=document.createElement('option');all.value='';all.textContent='Все';$("group").append(all);
  for(const name of config.groups||[]){const option=document.createElement('option');option.value=name;option.textContent=name==='Все'?'Все (группа)':name;$("group").append(option);}
  if(!(config.groups||[]).includes(activeGroup))activeGroup=null;
  $("group").value=activeGroup??'';$("group").disabled=!data;
}
function showColumns(message){
  previewMessage=message;
  const fields=message.fields;
  for(const id of ['hex-column','value-column','group-column','hover-columns']){
    const select=$(id);select.replaceChildren();
    if(id==='group-column'){const option=document.createElement('option');option.value='';option.textContent='Без фильтра';select.append(option);}
    for(const field of fields){const option=document.createElement('option');option.value=field;option.textContent=field;select.append(option);}
  }
  const match=names=>fields.find(name=>names.includes(name.trim().toLowerCase()));
  $("hex-column").value=fields.includes(columns?.hex)?columns.hex:match(['hex_id','h3','h3_id','cell'])||fields[0];
  $("value-column").value=fields.includes(columns?.value)?columns.value:match(['value','значение'])||fields.find(name=>name!==$("hex-column").value)||fields[0];
  $("group-column").value=fields.includes(columns?.group)?columns.group:match(['group','indicator','группа','показатель','class'])||'';
  for(const option of $("hover-columns").options)option.selected=(columns?.hover||[]).includes(option.value);
  const table=document.createElement('table'),head=document.createElement('tr');
  for(const field of fields){const th=document.createElement('th');th.textContent=field;head.append(th);}table.append(head);
  for(const row of message.preview){const tr=document.createElement('tr');for(const field of fields){const td=document.createElement('td');td.textContent=String(row[field]??'').slice(0,180);tr.append(td);}table.append(tr);}
  $("csv-preview").replaceChildren(table);$("columns-panel").hidden=false;
}
function parseCsv(){
  const file=$("csv-file").files[0];if(!file)return;
  clearError();parsed=false;previewMessage=null;datasetReady=false;updateExportButtons();fileName=file.name;
  $("build-data").disabled=true;$("columns-panel").hidden=true;$("status").textContent='Чтение CSV…';
  worker?.terminate();worker=new Worker(new URL('./data.worker.js',import.meta.url));
  worker.onerror=()=>{error('Не удалось запустить обработку CSV. Откройте сайт через HTTP(S) и проверьте доступ к файлам vendor.');$("status").textContent='Ошибка чтения CSV';};
  worker.onmessage=event=>{
    const message=event.data;if(message.id!==requestId)return;
    if(message.type==='progress'){$("status").textContent=message.message;return;}
    if(message.type==='error'){error(message.message);$("status").textContent='Данные не загружены';$("build-data").disabled=!parsed;return;}
    if(message.type==='parsed'){
      parsed=true;showColumns(message);$("build-data").disabled=false;
      $("status").textContent=`${message.count.toLocaleString('ru-RU')} строк · проверьте колонки и нажмите «Показать данные»`;return;
    }
    if(message.type==='built'){
      data=message.data;allFeatures=HexScale.allFeatures(data.features);datasetReady=true;
      Object.assign(config,{bounds:message.bounds,groups:message.groups,resolution:message.resolution,rows:message.rows,hover_columns:message.hover_columns});
      if(pendingGroup!==undefined){activeGroup=pendingGroup;pendingGroup=undefined;}
      refreshGroups();$("resolution").textContent=`уровень ${message.resolution}`;
      $("meta").textContent=`${fileName} · ${message.rows.toLocaleString('ru-RU')} строк · ${message.groups.length} групп`;
      $("build-data").disabled=false;clearError();update();
      if(coverageValid()){
        if(pendingCamera){map.jumpTo(pendingCamera);pendingCamera=null;}else fit();
        $("status").textContent='Данные загружены · настройте карту и скачайте результат';
      }
    }
  };
  worker.postMessage({id:++requestId,action:'parse',file,encoding:$("csv-encoding").value});
}
function buildData(){
  if(!parsed||!worker)return;
  clearError();columns=selectedColumns();$("build-data").disabled=true;datasetReady=false;updateExportButtons();
  $("status").textContent='Проверка данных и расчёт H3…';
  worker.postMessage({id:++requestId,action:'build',columns,decimal:$("csv-decimal").value});
}
function coverageValid(){
  if(!data||!city||!config.bounds)return false;
  const [w,s,e,n]=config.bounds,[cw,cs,ce,cn]=city.bounds;
  return w>=cw&&s>=cs&&e<=ce&&n<=cn;
}
function updateExportButtons(){
  const disabled=!loaded||!datasetReady||!data||!coverageValid()||!!scale?.binWarning||!!layoutWarning||exporting;
  for(const id of ['png','svg','share-html'])$(id).disabled=disabled;
}
function updateFrame(){
  if(!map)return;
  const frame=frameRect(map,config);Object.assign($("export-frame").style,{left:`${frame.x}px`,top:`${frame.y}px`,width:`${frame.width}px`,height:`${frame.height}px`});
  updatePreview();
}
function fitCity(){map.fitBounds([[city.bounds[0],city.bounds[1]],[city.bounds[2],city.bounds[3]]],{padding:35,maxZoom:11,duration:0});}
function makeStyle(){
  const flavor=basemaps.namedFlavor('light');
  baseLayers=basemaps.layers('basemap',{...flavor,background:'#f2f3ef',earth:'#f2f3ef',water:'#cfdee4',city_label_halo:'#ffffff',subplace_label_halo:'#ffffff'},{lang:'ru'});
  labelLayers=baseLayers.filter(layer=>layer.layout?.['text-field']&&layer.id!=='roads_shields').map(layer=>({id:layer.id,size:structuredClone(layer.layout['text-size']??16),haloWidth:structuredClone(layer.paint?.['text-halo-width']??0)}));
  const root=new URL('../',import.meta.url);
  const asset=path=>new URL('assets/'+path,root).href.replaceAll('%7B','{').replaceAll('%7D','}');
  return {version:8,glyphs:asset('fonts/{fontstack}/{range}.pbf'),sprite:asset('sprites/light'),sources:{basemap:{type:'vector',url:'pmtiles://'+new URL(city.url,root).href,attribution:'© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> · Protomaps · ESA WorldCover'}},layers:baseLayers};
}
function mapReady(){
  loaded=true;
  if(map.getSource("hexes")){update();return;}
  map.addSource('hexes',{type:'geojson',data:{type:'FeatureCollection',features:[]},maxzoom:15});
  const firstLabel=baseLayers.find(layer=>layer.type==='symbol')?.id;
  map.addLayer({id:'hex-fill',type:'fill',source:'hexes',paint:{'fill-color':'#dddddd','fill-opacity':config.opacity}},firstLabel);
  map.addLayer({id:'hex-outline',type:'line',source:'hexes',paint:{'line-color':'#ffffff','line-width':.6}},firstLabel);
  updateBase();updateLabels();update();updateExportButtons();updateFrame();
}
async function changeCity(id,move=true){
  const next=regions.find(region=>region.id===id);if(!next)throw new Error('Неизвестная территория.');
  if(city?.id===id&&loaded)return;
  city=next;loaded=false;clearError();updateExportButtons();$("city").disabled=true;$("status").textContent='Загрузка подложки…';
  const generation=++cityLoadId;
  map.once('style.load',()=>{if(generation!==cityLoadId)return;mapReady();$("city").disabled=false;if(pendingCamera){map.jumpTo(pendingCamera);if(datasetReady)pendingCamera=null;}else if(move)fitCity();if(!data)$("status").textContent='Подложка готова · выберите CSV';});
  map.setStyle(makeStyle(),{diff:false});
}
function syncControls(){
  for(const key of ['zero_color','opacity','bins','decimals','label_text_color','label_halo_color','legend_title_size','legend_text_size','export_width','export_height'])$(key).value=config[key];
  for(const [id,key]of [['symmetric','symmetric'],['outline','outline'],['show-legend','show_legend'],['hover','hover'],['reverse-palette','reverse_palette'],['html-all-groups','html_all_groups']])$(id).checked=config[key];
  for(const [id,key]of [['export-title','title'],['export-subtitle','subtitle'],['legend-title','legend_title'],['unit','unit'],['share-filename','share_filename']])$(id).value=config[key];
  document.title=plainTitle(config.title)||'Гексагональная карта';
  $("scope").value=config.scale_scope;$("palette").value=config.palette_name;$("label-size").value=Math.round(config.label_size_scale*100);
  $("label-no-halo").checked=!config.label_halo_enabled;$("label_halo_color").disabled=!config.label_halo_enabled;
  $("bin-edges").value=config.bin_edges.map(v=>String(v).replace('.',',')).join('; ');
  for(const key of Object.keys(layerNames))$("layer-"+key).checked=config.basemap_visibility[key];
  renderPaletteControls();refreshGroups();updateBase();updateLabels();update();updateFrame();
}
async function loadSettings(){
  const file=$("load-settings").files[0];if(!file)return;
  try{
    if(file.size>1024*1024)throw new Error('Файл настроек больше 1 МБ.');
    const saved=JSON.parse(await file.text());
    if(saved.version!==undefined&&saved.version!==1)throw new Error('Эта версия файла настроек не поддерживается.');
    const checked=validateConfig(saved.config||saved);
    if(saved.city&&!regions.some(region=>region.id===saved.city))throw new Error('Подложка из файла настроек не найдена в каталоге.');
    let camera=null;
    if(saved.camera){const v=saved.camera;if(!Array.isArray(v.center)||v.center.length!==2||v.center.some(n=>!Number.isFinite(n))||Math.abs(v.center[0])>180||Math.abs(v.center[1])>85||!Number.isFinite(v.zoom)||v.zoom<0||v.zoom>20)throw new Error('Некорректное положение карты в настройках.');camera={center:v.center,zoom:v.zoom};}
    if(saved.activeGroup!==undefined&&saved.activeGroup!==null&&typeof saved.activeGroup!=="string")throw new Error("Некорректная выбранная группа.");
    if(saved.columns&&(typeof saved.columns!=="object"||typeof saved.columns.hex!=="string"||typeof saved.columns.value!=="string"||!Array.isArray(saved.columns.hover)||saved.columns.hover.some(v=>typeof v!=="string")))throw new Error("Некорректные колонки в настройках.");
    if(saved.csv&&(!['utf-8','windows-1251'].includes(saved.csv.encoding)||!['.',','].includes(saved.csv.decimal)))throw new Error("Некорректный формат CSV в настройках.");
    const reread=saved.csv&&saved.csv.encoding!==$("csv-encoding").value;
    const metadata=Object.fromEntries(['bounds','groups','resolution','rows','hover_columns'].filter(k=>config[k]!==undefined).map(k=>[k,config[k]]));
    config=Object.assign(checked,metadata);columns=saved.columns||columns;pendingCamera=camera;
    if(saved.csv){$("csv-encoding").value=saved.csv.encoding;$("csv-decimal").value=saved.csv.decimal;}
    if(previewMessage&&saved.columns){showColumns(previewMessage);datasetReady=false;}
    pendingGroup=saved.activeGroup??null;if(data&&datasetReady){activeGroup=pendingGroup;pendingGroup=undefined;}
    if(saved.city&&saved.city!==city.id){$("city").value=saved.city;await changeCity(saved.city,!camera);}
    syncControls();
    if(camera&&loaded){map.jumpTo(camera);if(datasetReady)pendingCamera=null;}
    clearError();$("status").textContent=parsed?'Настройки открыты · проверьте колонки и нажмите «Показать данные»':'Настройки открыты · выберите CSV';
    if(reread&&$("csv-file").files[0])parseCsv();
  }catch(e){error('Не удалось открыть настройки: '+e.message);}
  finally{$("load-settings").value='';}
}
async function runExport(kind){
  if(!data||exporting||scale?.binWarning||layoutWarning||!coverageValid())return;
  clearError();exporting=true;updateExportButtons();popup?.remove();
  $("sidebar").inert=true;$("map-area").style.pointerEvents='none';$("status").textContent='Подготовка '+kind.toUpperCase()+'…';
  try{
    const result=await exportResult(kind,{map,config:validateConfig(config),data,features,activeGroup,baseLayers,frame:frameRect(map,config)});
    const name=(config.share_filename.trim()||'hex_map.html').replace(/[\\/:*?"<>|]/g,'_').replace(/\.html?$/i,'');
    downloadBlob(result,`${name}.${kind}`);$("status").textContent='Файл '+kind.toUpperCase()+' сохранён';
  }catch(e){error(e.message);$("status").textContent='Не удалось выполнить экспорт';}
  finally{exporting=false;$("sidebar").inert=false;$("map-area").style.pointerEvents='';updateExportButtons();}
}
let datasetReady=false;
async function main(){
  if(location.protocol==='file:')throw new Error('Откройте редактор по адресу GitHub Pages или через локальный HTTP-сервер. Двойным кликом открывается скачанный HTML для коллег.');
  if(!window.maplibregl||!window.pmtiles||!window.basemaps)throw new Error('Не загрузились библиотеки из папки vendor. Проверьте состав опубликованной папки.');
  const catalog=await getJSON(new URL('../regions.json',import.meta.url));
  if(!Array.isArray(catalog)||!catalog.length)throw new Error('Каталог подложек пуст.');
  for(const region of catalog){
    if(typeof region.id!=='string'||typeof region.name!=='string'||typeof region.url!=='string'||!Array.isArray(region.bounds)||region.bounds.length!==4||region.bounds.some(v=>!Number.isFinite(v)))throw new Error('Неверная запись в regions.json.');
    const url=new URL(region.url,new URL('../',import.meta.url));if(!['https:','http:'].includes(url.protocol))throw new Error('Неверный адрес PMTiles.');
  }
  regions=catalog;city=regions[0];
  for(const region of regions){const option=document.createElement('option');option.value=region.id;option.textContent=region.name;$("city").append(option);}
  const protocol=new pmtiles.Protocol();maplibregl.addProtocol('pmtiles',protocol.tile);
  map=new maplibregl.Map({container:'map',style:makeStyle(),center:city.center,zoom:city.zoom||10,renderWorldCopies:false,pitch:0,maxPitch:0,maxCanvasSize:[16384,16384],dragRotate:false,touchPitch:false,canvasContextAttributes:{preserveDrawingBuffer:false,antialias:true},attributionControl:false});
  map.touchZoomRotate.disableRotation();map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');map.addControl(new maplibregl.ScaleControl({unit:'metric'}),'bottom-right');
  setupControls();refreshGroups();updateExportButtons();
  $("csv-file").onchange=parseCsv;$("csv-encoding").onchange=parseCsv;$("build-data").onclick=buildData;$("close-error").onclick=clearError;
  for(const id of ['hex-column','value-column','group-column','hover-columns','csv-decimal'])$(id).onchange=()=>{if(parsed){datasetReady=false;updateExportButtons();$("status").textContent='Колонки изменены · нажмите «Показать данные»';}};
  $("city").onchange=()=>changeCity($("city").value).catch(e=>error(e.message));
  map.on('error',event=>{const text=event.error?.message||'Ошибка загрузки карты';error('Не загрузился ресурс подложки: '+text);});
  map.once('load',()=>{mapReady();$("status").textContent='Выберите CSV на компьютере';});
  map.on('resize',updateFrame);setupHover();
}
document.addEventListener('DOMContentLoaded',()=>main().catch(e=>{error(e.message);$("status").textContent='Ошибка запуска';}));
