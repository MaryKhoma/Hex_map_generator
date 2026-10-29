import {escapeXML,formatNumber} from "./scale.js";

/* Keep layout units independent of the number of pixels in the output file. */
function mapDimensions(config){
  const width=1200;
  return {width,height:width*config.export_height/config.export_width,pixelRatio:config.export_width/width};
}
function lineBreaks(text){return String(text??'').replace(/<br\s*\/?>/gi,'\n').replace(/\r\n?/g,'\n');}
function plainTitle(text){return lineBreaks(text).replace(/\s+/g,' ').trim();}
function textWidth(text,size,weight=400){
  const context=textWidth.context ||= document.createElement('canvas').getContext('2d');
  context.font=`${weight} ${size}px Arial, sans-serif`;
  return context.measureText(String(text)).width;
}
function wrapText(text,width,size,weight=400){
  const lines=[];
  for(const paragraph of lineBreaks(text).split('\n')){
    let line='';
    for(const word of paragraph.trim().split(/\s+/).filter(Boolean)){
      const next=line?`${line} ${word}`:word;
      if(line&&textWidth(next,size,weight)>width){lines.push(line);line='';}
      if(textWidth(word,size,weight)>width){
        if(line){lines.push(line);line='';}
        for(const character of word){if(line&&textWidth(line+character,size,weight)>width){lines.push(line);line='';}line+=character;}
      }else line=line?`${line} ${word}`:word;
    }
    lines.push(line);
  }
  return lines;
}
function legendContent(config,scale,features,maxWidth,missingCount){
const tick=v=>formatNumber(v,config.decimals);
function legendRows() {
  if (scale.empty) return [];
  if (scale.constant) return [{color:scale.color(scale.min), label:tick(scale.min)}];
  return [];
}
function legendTextWidth(text, size=config.legend_text_size, weight=400) {
  return Math.max(...lineBreaks(text).split('\n').map(line=>textWidth(line,size,weight)));
}
function discreteLegendWidth() {
  const boundaries = [...scale.bins.map(b => b.lo), scale.bins[scale.bins.length - 1].hi];
  return Math.ceil(34 + Math.max(...boundaries.map(value => legendTextWidth(tick(value)))));
}
function discreteLegendMetrics() {
  const step = Math.ceil(config.legend_text_size * 1.7), top = Math.ceil(config.legend_text_size * .75);
  return {step,top,height:scale.bins.length * step + top * 2};
}
function discreteLegendSVG(width=discreteLegendWidth()) {
  const {step,top,height} = discreteLegendMetrics();
  const boundaries = [...scale.bins.map(b => b.lo), scale.bins[scale.bins.length - 1].hi].reverse();
  const segments = [...scale.bins].reverse().map((b,i) => `<rect x="0" y="${top+i*step}" width="18" height="${step}" fill="${b.color}"/>`).join("");
  const ticks = boundaries.map((value,i) => `<path d="M18 ${top+i*step}h6" stroke="#78847e" stroke-width="0.6"/><text x="32" y="${top+i*step}" dominant-baseline="middle" font-size="${config.legend_text_size}" fill="#25332f">${escapeXML(tick(value))}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="max-width:100%;display:block" font-family="Arial, sans-serif">${segments}${ticks}</svg>`;
}
function specialRows() {
  const rows = [];
  const missing = missingCount ?? features.filter(f => f.properties.value === null).length;
  if (missing) rows.push({color:config.missing_color,label:`Нет данных · ${missing}`});
  return rows;
}
function legendTitle() { return config.legend_title + (config.unit ? (config.legend_title ? `, ${config.unit}` : config.unit) : ""); }
function legendLines(text,width,size,weight=400) {
  return text ? wrapText(text,width,size,weight) : [];
}
function content(maxWidth) {
  const size = config.legend_text_size, titleSize = config.legend_title_size;
  const lineHeight = Math.ceil(size * 1.4), titleHeight = Math.ceil(titleSize * 1.3);
  const continuous = !scale.empty && !scale.constant && config.scale_mode === "continuous";
  const discrete = !scale.empty && !scale.constant && config.scale_mode === "discrete";
  const rows = legendRows().concat(specialRows());
  const width = Math.min(maxWidth,Math.ceil(Math.max(1,
    legendTextWidth(legendTitle(),titleSize,600),
    ...rows.map(row=>legendTextWidth(row.label)+26),
    discrete ? discreteLegendWidth() : 0,
    continuous ? Math.max(220,legendTextWidth(tick(scale.min))+legendTextWidth(tick(scale.max))+(scale.negative && scale.max>0 ? legendTextWidth(tick(0)) : 0)+60) : 0
  )));
  let y = 0, svg = "";
  for (const line of legendLines(legendTitle(),width,titleSize,600)) {
    svg += `<text x="0" y="${y+titleSize}" font-size="${titleSize}" font-weight="600">${escapeXML(line)}</text>`;
    y += titleHeight;
  }
  if (y) y += 12;
  if (continuous) {
    const ticksY = y+14+size;
    svg += `<defs><linearGradient id="legend-ramp">${scale.stops.map(([v,c])=>`<stop offset="${(v-scale.min)/(scale.max-scale.min)*100}%" stop-color="${c}"/>`).join("")}</linearGradient></defs><rect x="0" y="${y}" width="${width}" height="11" rx="2" fill="url(#legend-ramp)"/><text x="0" y="${ticksY}" font-size="${size}">${escapeXML(tick(scale.min))}</text><text x="${width}" y="${ticksY}" text-anchor="end" font-size="${size}">${escapeXML(tick(scale.max))}</text>`;
    if (scale.negative && scale.max > 0) svg += `<text x="${-scale.min/(scale.max-scale.min)*width}" y="${ticksY}" text-anchor="middle" font-size="${size}">${escapeXML(tick(0))}</text>`;
    y = ticksY+10;
  } else if (discrete) {
    svg += `<g transform="translate(0,${y})">${discreteLegendSVG(width)}</g>`;
    y += discreteLegendMetrics().height+10;
  }
  for (const row of rows) {
    svg += `<rect x="0" y="${y+Math.max(0,(size-10)/2)}" width="17" height="10" rx="2" fill="${row.color}" stroke="#000" stroke-opacity=".08"/>`;
    for (const line of legendLines(row.label,width-26,size)) {
      svg += `<text x="26" y="${y+size}" font-size="${size}">${escapeXML(line)}</text>`;
      y += lineHeight;
    }
    y += 3;
  }
  return {width,height:Math.ceil(y),svg};
}

return content(maxWidth);
}
function legendSVG(config,scale,features,maxWidth){const c=legendContent(config,scale,features,maxWidth);return `<svg xmlns="http://www.w3.org/2000/svg" width="${c.width}" height="${c.height}" viewBox="0 0 ${c.width} ${c.height}" font-family="Arial, sans-serif" fill="#25332f" style="display:block">${c.svg}</svg>`;}
/* One SVG layout is used by the editor, image exports and the offline viewer. */
function mapLayout(config,scale,features=[],missingCount){
  const {width,height}=mapDimensions(config);
  const margin=20,padding=16,available=width-2*(margin+padding);
  const title=config.title.trim()?wrapText(config.title,available,30,600):[];
  const subtitle=config.subtitle.trim()?wrapText(config.subtitle,available,16):[];
  let svg='',headerBottom=margin;
  if(title.length||subtitle.length){
    const panelWidth=Math.ceil(Math.max(1,...title.map(line=>textWidth(line,30,600)),...subtitle.map(line=>textWidth(line,16))))+padding*2;
    const panelHeight=padding*2+title.length*38+subtitle.length*24+(title.length&&subtitle.length?6:0);
    svg+=`<g transform="translate(${margin},${margin})"><rect width="${panelWidth}" height="${panelHeight}" rx="9" fill="white" fill-opacity=".97" stroke="#e0e5de"/>`;
    let y=padding;
    for(const line of title){svg+=`<text x="${padding}" y="${y+30}" font-size="30" font-weight="600">${escapeXML(line)}</text>`;y+=38;}
    if(title.length&&subtitle.length)y+=6;
    for(const line of subtitle){svg+=`<text x="${padding}" y="${y+16}" font-size="16" fill="#758077">${escapeXML(line)}</text>`;y+=24;}
    svg+='</g>';headerBottom=margin+panelHeight;
  }
  let warning=headerBottom>height-margin?'Заголовок не помещается в карту. Увеличьте высоту файла или сократите текст.':'';
  if(config.show_legend&&scale){
    const c=legendContent(config,scale,features,available,missingCount),panelWidth=c.width+padding*2,panelHeight=c.height+padding*2;
    const y=height-margin-panelHeight;
    if(y<headerBottom+(title.length||subtitle.length?16:0))warning='Заголовок и легенда не помещаются в карту. Увеличьте высоту файла, уменьшите шрифт легенды или число интервалов.';
    svg+=`<g transform="translate(${margin},${y})"><rect width="${panelWidth}" height="${panelHeight}" rx="9" fill="white" fill-opacity=".97" stroke="#e0e5de"/><g transform="translate(${padding},${padding})">${c.svg}</g></g>`;
  }
  svg+=`<text x="${width-12}" y="${height-8}" text-anchor="end" font-size="9" fill="#9aa49e">© OpenStreetMap contributors · Protomaps · ESA WorldCover</text>`;
  return {width,height,warning,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Arial, sans-serif" fill="#25332f">${svg}</svg>`};
}
export {legendContent,legendSVG,mapLayout,mapDimensions,lineBreaks,plainTitle};
