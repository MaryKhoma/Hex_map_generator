/* Local files stay in this worker. Only validated map data is sent to the UI. */
importScripts(new URL('../vendor/papaparse.js',self.location.href).href,new URL('../vendor/h3-js.js',self.location.href).href);
let rows=[],fields=[];
const MAX_ROWS=50000;
self.onmessage=event=>{
  const {id,action}=event.data;
  try {
    if(action==='parse')parseFile(event.data);
    else if(action==='build')buildData(event.data);
    else throw new Error('Неизвестная операция с данными.');
  }catch(error){self.postMessage({id,type:'error',message:error.message});}
};
function parseFile({id,file,encoding}){
  if(!(file instanceof Blob))throw new Error('Выберите CSV-файл.');
  if(file.size>100*1024*1024)throw new Error('CSV больше 100 МБ. Оставьте только необходимые колонки и до 50 000 строк.');
  rows=[];fields=[];let failed=false;
  Papa.parse(file,{
    header:true,skipEmptyLines:'greedy',dynamicTyping:false,encoding,
    transformHeader:name=>name.replace(/^\uFEFF/,'').trim(),
    step(result,parser){
      if(failed)return;
      if(result.errors.length){
        failed=true;parser.abort();self.postMessage({id,type:'error',message:`Ошибка CSV около строки ${rows.length+2}: ${result.errors[0].message}`});return;
      }
      if(!fields.length)fields=result.meta.fields||[];
      if(fields.length!==new Set(fields).size||fields.some(name=>!name.trim())||result.meta.renamedHeaders&&Object.keys(result.meta.renamedHeaders).length){
        failed=true;parser.abort();self.postMessage({id,type:'error',message:'В заголовке CSV есть пустые или повторяющиеся названия колонок.'});return;
      }
      rows.push(result.data);
      if(rows.length>MAX_ROWS){failed=true;parser.abort();self.postMessage({id,type:'error',message:'Для этой версии поддерживается до 50 000 строк CSV.'});return;}
      if(rows.length%5000===0)self.postMessage({id,type:'progress',message:`Прочитано ${rows.length.toLocaleString('ru-RU')} строк…`});
    },
    complete(){
      if(failed)return;
      if(!rows.length){self.postMessage({id,type:'error',message:'CSV не содержит данных.'});return;}
      self.postMessage({id,type:'parsed',fields,preview:rows.slice(0,5),count:rows.length});
    },
    error(error){self.postMessage({id,type:'error',message:`Не удалось прочитать CSV: ${error.message}`});}
  });
}
function buildData({id,columns,decimal}){
  if(!rows.length)throw new Error('Сначала выберите CSV.');
  const {hex,value,group,hover=[]}=columns;
  const chosen=[hex,value,...(group?[group]:[])];
  if(new Set(chosen).size!==chosen.length)throw new Error('Колонки H3, значения и фильтра должны различаться.');
  if([...chosen,...hover].some(name=>!fields.includes(name)))throw new Error('Выбранная колонка отсутствует в CSV.');
  if(!['.',','].includes(decimal))throw new Error('Выберите десятичный знак.');
  const geometries=new Map(),duplicates=new Set(),groups=new Set(),features=[];
  let resolution=null,west=Infinity,south=Infinity,east=-Infinity,north=-Infinity;
  for(let i=0;i<rows.length;i++){
    const source=rows[i],cell=String(source[hex]??'').trim().toLowerCase(),line=i+2;
    if(!h3.isValidCell(cell))throw new Error(`Неверный H3 hex_id в строке ${line}: ${cell.slice(0,40)}`);
    const level=h3.getResolution(cell);
    if(resolution!==null&&resolution!==level)throw new Error(`В CSV смешаны уровни H3 ${resolution} и ${level}. Подготовьте один уровень.`);
    resolution=level;
    const raw=String(source[value]??'').trim();let number=null;
    if(!['','na','nan','null','none','n/a'].includes(raw.toLowerCase())){
      const normalized=raw.replace(/[\s\u00a0\u202f]/g,'').replace(decimal===','?/,/g:/$^/g,'.');
      if(!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(normalized)||!Number.isFinite(Number(normalized)))throw new Error(`Неверное числовое значение в строке ${line}. Проверьте колонку value и десятичный знак.`);
      number=Number(normalized);
    }
    const name=group?String(source[group]??'').trim():'Все данные';
    if(!name)throw new Error(`Пустая группа в строке ${line}.`);
    const key=JSON.stringify([cell,name]);
    if(duplicates.has(key))throw new Error(`Повторяется пара гекс + группа в строке ${line}: ${cell}, ${name}.`);
    duplicates.add(key);groups.add(name);
    if(!geometries.has(cell)){
      const ring=h3.cellToBoundary(cell,true);
      if(ring.some(([lon,lat])=>Math.abs(lat)>85.05112878))throw new Error('Гексы за пределами Web Mercator (±85,051°) не поддерживаются.');
      if(Math.max(...ring.map(c=>c[0]))-Math.min(...ring.map(c=>c[0]))>180)throw new Error('Гексы на линии перемены дат пока не поддерживаются.');
      if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])ring.push([...ring[0]]);
      for(const [lon,lat]of ring){west=Math.min(west,lon);south=Math.min(south,lat);east=Math.max(east,lon);north=Math.max(north,lat);}
      geometries.set(cell,{type:'Polygon',coordinates:[ring]});
    }
    features.push({type:'Feature',id:i,geometry:geometries.get(cell),properties:{hex_id:cell,value:number,group:name,details:Object.fromEntries(hover.map(name=>[name,String(source[name]??'')]))}});
    if(i&&i%5000===0)self.postMessage({id,type:'progress',message:`Подготовлено ${i.toLocaleString('ru-RU')} строк…`});
  }
  self.postMessage({id,type:'built',data:{type:'FeatureCollection',features},bounds:[west,south,east,north],groups:[...groups],resolution,rows:rows.length,hover_columns:hover});
}
