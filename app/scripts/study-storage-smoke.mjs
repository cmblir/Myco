// Explicit browser-memory fixtures; no native disk, model, or installed acceptance.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.MYCO_TEST_URL ?? 'http://127.0.0.1:5173';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname));
const output = process.env.MYCO_SCREENSHOTS ?? '/tmp/myco-study-storage';
await mkdir(output, {recursive:true});
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1280,height:900}});
page.setDefaultTimeout(15000);
const errors=[];
page.on('pageerror', error=>errors.push(error.message));
const gates=[];
const names=['invalid_deck_read_has_recovery','retry_preserves_original_bytes','partial_save_is_not_success','partial_keeps_written_file','no_unhandled_error'];
const path='/myco/cards/attention-mechanism.md';
try {
 await page.route('**/*', route=>{
  const url=new URL(route.request().url());
  return ['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)
   ?route.continue():route.abort('blockedbyclient');
 });
 await page.addInitScript(()=>{
  localStorage.setItem('myco.onboarded','1');
  localStorage.setItem('myco-ui',JSON.stringify({version:3,state:{lang:'ko',theme:'light',aiCards:false}}));
 });
 await page.goto(base+'/?mock=1',{waitUntil:'domcontentloaded'});
 await page.locator('.home-page').waitFor();
 const raw=await page.evaluate(async path=>(await window.__TAURI_INTERNALS__.invoke('read_file',{path})).raw,path);
 if(await page.locator('.app.sidebar-collapsed').count()) await page.getByTitle(/Toggle sidebar|사이드바/).click();
 const more=page.locator('.side-nav button[aria-expanded]').filter({hasText:/더|More/}).first();
 if(await more.count() && await more.getAttribute('aria-expanded')==='false') await more.click();
 await page.locator('.side-nav .nav-item').filter({has:page.locator('.ni-text',{hasText:/^학습$/})}).click();
 const row=page.locator('.deck-row').filter({has:page.locator('.deck-row__name',{hasText:/^attention-mechanism$/})});
 await row.waitFor();
 await page.evaluate(async path=>window.__TAURI_INTERNALS__.invoke('write_file',{path,content:'```markdown\nIncomplete synthetic deck'}),path);
 await row.locator('.deck-row__open').click();
 const alert=page.locator('.study-deck-error[role=alert]');
 await alert.waitFor();
 assert.match(await alert.innerText(),/덱을 읽지 못했어요/);
 assert.equal(await page.locator('.study-card').count(),0);
 gates.push(names[0]);
 await page.screenshot({path:output+'/read-error.png',fullPage:true});
 const heading='# Synthetic human heading\r\n\r\n<!-- Keep this exact comment -->\r\n\r\n';
 const content=heading+raw.replace(/\r?\n/g,'\r\n');
 await page.evaluate(async ({path,content})=>window.__TAURI_INTERNALS__.invoke('write_file',{path,content}),{path,content});
 await alert.getByRole('button',{name:'다시 시도',exact:true}).click();
 await page.locator('.study-card').waitFor();
 assert.equal(await alert.count(),0);
 assert.equal(await page.evaluate(async path=>(await window.__TAURI_INTERNALS__.invoke('read_file',{path})).raw,path),content);
 gates.push(names[1]);
 await page.evaluate(()=>{
  const previous=window.__TAURI_INTERNALS__.invoke;
  let injected=false;
  window.__TAURI_INTERNALS__.invoke=async function(command,args,options){
   const reply=await previous.call(this,command,args,options);
   if(command==='write_study_deck'&&!injected){
    injected=true;
    return {...reply,state:'partial',revision:null,error:'Synthetic browser receipt failure'};
   }
   return reply;
  };
 });
 await page.locator('.study-flip').click();
 await page.getByRole('button',{name:/^기억남/}).click();
 const warning=page.getByText('파일이 이미 저장됐을 수 있지만 결과를 확인하지 못했어요. 덱을 확인한 뒤 다시 시도해 주세요.',{exact:true});
 await warning.waitFor();
 gates.push(names[2]);
 const written=await page.evaluate(async path=>(await window.__TAURI_INTERNALS__.invoke('read_file',{path})).raw,path);
 assert.ok(written.startsWith(heading));
 assert.notEqual(written,content);
 assert.deepEqual(written.split('\r\n').filter(line=>line.includes(' ?? ')),content.split('\r\n').filter(line=>line.includes(' ?? ')));
 gates.push(names[3]);
 await page.screenshot({path:output+'/partial-save.png',fullPage:true});
 assert.deepEqual(errors,[]);
 gates.push(names[4]);
 console.log(JSON.stringify({scope:'browser_memory_only',modelInference:false,nativeAuthority:false,installedAcceptance:false,planned:names,passed:gates,errors}));
} finally { await browser.close(); }
