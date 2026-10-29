const mix = (a, b, t) => {
    t = Math.max(0, Math.min(1, t));
    const channels = [1, 3, 5].map(i => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t));
    return "#" + channels.map(c => c.toString(16).padStart(2, "0")).join("");
  };
  function parseBinEdges(text) {
    if (!text.trim()) return [];
    const tokens = text.trim().replaceAll("−","-").split(/[;\s]+/).filter(Boolean);
    if (tokens.some(token=>!/^[-+]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:e[-+]?\d+)?$/i.test(token))) {
      throw new Error("Введите числа через «;», например: 0; 12,5; 35; 100.");
    }
    const edges = tokens.map(token=>Number(token.replace(",",".")));
    const message = binEdgesError(edges,[]);
    if (message) throw new Error(message);
    return edges;
  }
  function binEdgesError(edges, values) {
    if (!Array.isArray(edges) || (edges.length && (edges.length < 2 || edges.some((v,i)=>typeof v !== "number" || !Number.isFinite(v) || (i>0 && v<=edges[i-1]))))) {
      return "Нужно минимум две числовые границы строго по возрастанию.";
    }
    if (!edges.length) return "";
    const valid = values.filter(v=>typeof v === "number" && Number.isFinite(v));
    if (valid.some(v=>v<edges[0] || v>edges[edges.length-1])) return "Крайние границы должны покрывать весь текущий диапазон значений.";
    if (valid.some(v=>v<0) && valid.some(v=>v>0) && !edges.includes(0)) return "Для значений обоих знаков добавьте границу 0.";
    return "";
  }
  function createScale(values, options) {
    const vals = values.filter(v => typeof v === "number" && Number.isFinite(v));
    const negative = vals.some(v => v < 0), positive = vals.some(v => v > 0);
    let min = vals.length ? vals.reduce((a,b)=>Math.min(a,b), Infinity) : 0;
    let max = vals.length ? vals.reduce((a,b)=>Math.max(a,b), -Infinity) : 0;
    const requestedEdges = options.scale_mode === "discrete" ? (options.bin_edges || []) : [];
    const binWarning = binEdgesError(requestedEdges,vals);
    const customEdges = !binWarning && requestedEdges.length ? requestedEdges : null;
    if (customEdges) {min = customEdges[0]; max = customEdges[customEdges.length-1];}
    if (!customEdges && negative && positive && options.symmetric) {
      const m = Math.max(-min, max); min = -m; max = m;
    }
    const constant = min === max;
    const minus = options.negative_palette?.length ? options.negative_palette : [options.negative_color];
    const plus = options.positive_palette?.length ? options.positive_palette : [options.positive_color];
    const hasZero = vals.some(v=>v === 0) || (negative && positive);
    let stops;
    if (constant) {
      stops = [[min, min === 0 ? options.zero_color : (positive ? plus[plus.length-1] : minus[0])]];
    } else if (negative && positive) {
      stops = [...minus.map((c,i) => [min + (-min) * i / minus.length,c]), [0,options.zero_color],
        ...plus.map((c,i) => [max * (i+1) / plus.length,c])];
    } else {
      // On a one-sided domain, the full palette spans the actual data extent.
      const colors = negative ? [...minus,options.zero_color] : [options.zero_color,...plus];
      stops = colors.map((c,i) => [min + (max-min) * i / (colors.length-1),c]);
    }
    function continuous(v) {
      if (hasZero && v === 0) return options.zero_color;
      if (constant || v <= min) return stops[0][1];
      for (let i=1; i<stops.length; i++) {
        const [a,ca] = stops[i-1], [b,cb] = stops[i];
        if (v <= b) return mix(ca,cb,(v-a)/(b-a));
      }
      return stops[stops.length-1][1];
    }
    const bins = [];
    function addBins(a, b) {
      if (a === b) return;
      for (let i = 0; i < options.bins; i++) {
        const lo = a + (b - a) * i / options.bins;
        const hi = a + (b - a) * (i + 1) / options.bins;
        bins.push({lo, hi, color: continuous((lo + hi) / 2)});
      }
    }
    if (customEdges) {
      for (let i=1; i<customEdges.length; i++) {
        const lo=customEdges[i-1], hi=customEdges[i];
        bins.push({lo,hi,color:options.bin_colors?.length === customEdges.length-1 ? options.bin_colors[i-1] : continuous(lo/2+hi/2)});
      }
    } else if (negative && positive) {addBins(min, 0); addBins(0, max);} else addBins(min, max);
    function color(v) {
      if (v === null || !Number.isFinite(v)) return options.missing_color;
      if (hasZero && v === 0) return options.zero_color;
      if (options.scale_mode !== "discrete" || constant) return continuous(v);
      return (bins.find(b => v < b.hi) || bins[bins.length - 1]).color;
    }
    // Explicit zero and missing branches avoid null→0 coercion in MapLibre.
    let ramp = constant ? stops[0][1] : ["interpolate", ["linear"], ["get", "value"], ...stops.flat()];
    if (options.scale_mode === "discrete" && bins.length) {
      ramp = ["step", ["get", "value"], bins[0].color, ...bins.slice(1).flatMap(b => [b.lo, b.color])];
    }
    const expression = ["case", ["==", ["get", "value"], null], options.missing_color,
                        ...(hasZero ? [["==", ["get", "value"], 0], options.zero_color] : []), ramp];
    return {min, max, negative, positive, hasZero, binWarning, customBins:!!customEdges, constant, empty: !vals.length, stops, bins, color, expression};
  }
  function allFeatures(features) {
    const cells = new Map();
    for (const feature of features) {
      const id = feature.properties.hex_id;
      if (!cells.has(id)) cells.set(id,[]);
      cells.get(id).push(feature);
    }
    return [...cells.values()].map(rows => {
      if (rows.length === 1) return rows[0];
      const valid = rows.map(f=>f.properties.value).filter(v=>typeof v === "number" && Number.isFinite(v));
      const details = Object.fromEntries(Object.entries(rows[0].properties.details || {}).filter(
        ([key,value])=>rows.every(f=>f.properties.details?.[key] === value)
      ));
      return {...rows[0],properties:{...rows[0].properties,
        value:valid.length ? valid.reduce((sum,v)=>sum + v / valid.length,0) : null,
        group:valid.length ? `Все · среднее по ${valid.length} группам` : "Все · нет данных", details,
        group_values:rows.map(f=>({group:f.properties.group,value:f.properties.value})),
      }};
    });
  }

const sequentialPalettes = {
  level:["#bc4821","#f0754c","#ee9b6a","#e3bc7e","#aec561","#73b243","#2b6f25"],
  magma:["#000004","#1d1147","#51127c","#832681","#b73779","#e75263","#fc8961","#fec488","#fcfdbf"],
  viridis:["#440154","#472d7b","#3b528b","#2c728e","#21918c","#28ae80","#5ec962","#addc30","#fde725"],
};
const palettes = {
  classic: {negative:["#2166ac","#67a9cf","#d1e5f0"], zero:"#f7f7f7", positive:["#fddbc7","#ef8a62","#b2182b"]},
  purple: {negative:["#542788","#998ec3","#d8daeb"], zero:"#f7f7f7", positive:["#fee0b6","#f1a340","#b35806"]},
  change: {negative:["#5e150b","#c44b0e","#f5b87b"],zero:"#f5f3eb",positive:["#b4e8a0","#46d742","#0f7e19"]},
  green: {negative:["#2166ac","#67a9cf","#d1e5f0"], zero:"#f7f7f7", positive:["#c7e9b4","#41ab5d","#006d2c"]},
};
function reverseColors(palette, negative, positive) {
  if (negative && positive) return {negative:[...palette.positive].reverse(),zero:palette.zero,positive:[...palette.negative].reverse()};
  if (negative) {
    const colors = [...palette.negative,palette.zero].reverse();
    return {...palette,negative:colors.slice(0,-1),zero:colors[colors.length-1]};
  }
  const colors = [palette.zero,...palette.positive].reverse();
  return {...palette,zero:colors[0],positive:colors.slice(1)};
}
function mixedSigns(values) {
  return values.some(v=>typeof v === "number" && Number.isFinite(v) && v < 0)
    && values.some(v=>typeof v === "number" && Number.isFinite(v) && v > 0);
}
function paletteForValues(name, values, reverse=false) {
  const colors = sequentialPalettes[name];
  const negative = values.some(v => typeof v === "number" && v < 0);
  const positive = values.some(v => typeof v === "number" && v > 0);
  let palette = palettes[name];
  if (colors && negative && positive) return reverse ? reverseColors(palettes.classic,true,true) : palettes.classic;
  if (colors) {
    const last = colors.length-1;
    const zeroIndex = negative ? (positive ? Math.floor(last/2) : last) : 0;
    palette = {negative:zeroIndex ? colors.slice(0,zeroIndex) : [colors[0]],
      zero:colors[zeroIndex],positive:zeroIndex < colors.length-1 ? colors.slice(zeroIndex+1) : [colors[colors.length-1]]};
  }
  return palette && reverse ? reverseColors(palette,negative,positive) : palette;
}


const presetBins = {
  change:{edges:[-15,-10,-5,0,5,10,15],colors:["#5e150b","#c44b0e","#f5b87b","#b4e8a0","#46d742","#0f7e19"]},
  level:{edges:[3,4,5,6,7,8,9,10],colors:["#bc4821","#f0754c","#ee9b6a","#e3bc7e","#aec561","#73b243","#2b6f25"]},
};
const DEFAULTS = {
  title:"Гексагональная карта",subtitle:"",legend_title:"Значение показателя",unit:"",
  scale_mode:"continuous",scale_scope:"group",bins:5,bin_edges:[],bin_colors:[],symmetric:true,
  negative_color:"#2166ac",zero_color:"#f7f7f7",positive_color:"#b2182b",missing_color:"#acb4bb",
  negative_palette:["#2166ac","#67a9cf","#d1e5f0"],positive_palette:["#fddbc7","#ef8a62","#b2182b"],
  palette_name:"classic",custom_palette_kind:"diverging",reverse_palette:false,
  opacity:.78,outline:true,show_legend:true,hover:true,decimals:1,
  label_size_scale:1,label_text_color:"#666666",label_halo_color:"#ffffff",label_halo_enabled:true,
  legend_title_size:16,legend_text_size:14,export_width:3200,export_height:2400,
  share_filename:"hex_map.html",html_all_groups:true,
  basemap_visibility:{labels:true,roads:true,buildings:true,water:true,parks:true,boundaries:true,poi:false},
};
function defaultConfig(){return structuredClone(DEFAULTS);}
function escapeXML(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[c]));}
function formatNumber(value,decimals){
  if(value===null||!Number.isFinite(Number(value)))return "Нет данных";
  const n=Number(value),v=Math.abs(n)<.5*10**-decimals?0:n;
  return v.toLocaleString("ru-RU",{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
}
function validateConfig(input){
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("В файле нет объекта настроек.");
  const result=defaultConfig();
  for(const key of Object.keys(DEFAULTS))if(Object.hasOwn(input,key))result[key]=structuredClone(input[key]);
  const numbers={bins:[2,9,true],decimals:[0,8,true],opacity:[0,1],label_size_scale:[.5,3],legend_title_size:[8,36,true],legend_text_size:[8,36,true],export_width:[1200,8192,true],export_height:[1000,8192,true]};
  for(const [key,[min,max,integer]]of Object.entries(numbers))if(typeof result[key]!=="number"||!Number.isFinite(result[key])||result[key]<min||result[key]>max||(integer&&!Number.isInteger(result[key])))throw new Error(`Некорректная настройка ${key}. Допустимо ${min}–${max}.`);
  for(const key of ["title","subtitle","legend_title","unit","share_filename"])if(typeof result[key]!=="string"||result[key].length>1000)throw new Error(`Некорректная настройка ${key}.`);
  for(const key of ["negative_color","zero_color","positive_color","missing_color","label_text_color","label_halo_color"])if(!/^#[a-f0-9]{6}$/i.test(result[key]))throw new Error(`Некорректный цвет ${key}.`);
  for(const key of ["negative_palette","positive_palette","bin_colors"]){const a=result[key];if(!Array.isArray(a)||a.length>(key==="bin_colors"?99:8)||a.some(c=>typeof c!=="string"||!/^#[a-f0-9]{6}$/i.test(c)))throw new Error(`Некорректные цвета ${key}.`);}
  if(!result.negative_palette.length)result.negative_palette=[result.negative_color];
  if(!result.positive_palette.length)result.positive_palette=[result.positive_color];
  if(result.bin_edges?.length>100)throw new Error("Не более 100 границ интервалов.");
  const edgeError=binEdgesError(result.bin_edges,[]);if(edgeError)throw new Error(edgeError);
  for(const key of ["symmetric","reverse_palette","outline","show_legend","hover","label_halo_enabled","html_all_groups"])if(typeof result[key]!=="boolean")throw new Error(`Некорректная настройка ${key}.`);
  if(!["continuous","discrete"].includes(result.scale_mode)||!["group","global"].includes(result.scale_scope)||!["custom",...Object.keys(palettes),...Object.keys(sequentialPalettes)].includes(result.palette_name)||!["diverging","sequential"].includes(result.custom_palette_kind))throw new Error("Неизвестный режим шкалы или палитра.");
  if(!result.basemap_visibility||typeof result.basemap_visibility!=="object")throw new Error("Некорректная видимость слоёв.");
  result.basemap_visibility=Object.fromEntries(Object.keys(DEFAULTS.basemap_visibility).map(k=>[k,result.basemap_visibility[k]!==false]));
  return result;
}
function choosePalette(config,values){
  const mixed=mixedSigns(values);
  if(mixed&&(sequentialPalettes[config.palette_name]||(config.palette_name==="custom"&&config.custom_palette_kind==="sequential"))){config.palette_name="classic";config.bin_colors=[];}
  const p=paletteForValues(config.palette_name,values,config.reverse_palette);
  if(p){config.negative_palette=[...p.negative];config.positive_palette=[...p.positive];config.zero_color=p.zero;config.negative_color=p.negative[0];config.positive_color=p.positive.at(-1);}
  if(presetBins[config.palette_name]&&JSON.stringify(config.bin_edges)===JSON.stringify(presetBins[config.palette_name].edges))config.bin_colors=config.reverse_palette?[...presetBins[config.palette_name].colors].reverse():[...presetBins[config.palette_name].colors];
}
export {mix,createScale,allFeatures,parseBinEdges,binEdgesError,sequentialPalettes,palettes,presetBins,reverseColors,mixedSigns,paletteForValues,defaultConfig,validateConfig,choosePalette,escapeXML,formatNumber};
