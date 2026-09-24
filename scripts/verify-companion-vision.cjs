// Real page, canvas and upload interactions; provider and GPU calls are intercepted.
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const target = process.env.TEST_URL || 'http://127.0.0.1:3000';
(async () => {
 const browser = await chromium.launch({channel:'msedge',headless:true});
 try {
  for (const mobile of [false,true]) {
   const context = await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,reducedMotion:'reduce'});
   await context.addInitScript(()=>localStorage.setItem('ruhua-companion-v1',JSON.stringify({collapsed:true,right:18,bottom:16,known:true})));
   const page = await context.newPage(), requests=[], errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://*.app.beam.cloud/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/assist')requests.push(route.request().postDataJSON());
    const body=path==='/healthz'?{ok:true,assist:true,assist_vision:true}:path==='/assist'?{reply:'看到了这次提供的内容。',mood:'neutral'}:path==='/generate'?{call_id:'a'.repeat(32),job_id:'a'.repeat(32)}:{status:'queued',stage:'等待处理'};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
   });
   await page.goto(target+'/?nointro');
   await page.getByRole('button',{name:'直接进入'}).click();
   await page.getByRole('button',{name:'展开鲸鱼娘并聊天'}).click();
   const ask=async text=>{
    const n=requests.length;
    await page.getByLabel('给鲸鱼娘的消息').fill(text);
    await page.getByRole('button',{name:'发送',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[aria-label="鲸鱼娘正在输入"]'));
    assert.equal(requests.length,n+1);
    return requests.at(-1);
   };
   const off=await ask('现在能看到图片吗');
   assert(!off.page_image&&!off.screen&&!off.context.page_text);
   await page.getByRole('button',{name:'关闭对话'}).click();
   await page.locator('nav').getByRole('button',{name:'创作',exact:true}).click();
   await page.locator('main input[type=file]').setInputFiles('public/author/avatar.jpg');
   await page.locator('.develop-painting canvas').waitFor();
   await page.waitForTimeout(800);
   await page.getByRole('button',{name:'和鲸鱼娘聊天',exact:true}).click();
   await page.getByLabel('允许查看当前网页').check();
   await page.evaluate(()=>{
    const main=document.querySelector('.develop-painting').closest('main');
    main.insertAdjacentHTML('beforeend','<p style="margin-top:1800px">OFFSCREEN_VISIBLE_NOTE</p><input type="password" value="PASSWORD_PRIVATE"><textarea>TEXTAREA_PRIVATE</textarea><p data-assist-private>PRIVATE_PANEL</p><p hidden>HIDDEN_NOTE</p>');
   });
   const visible=await ask('这张上传原图是什么');
   assert(visible.page_image?.startsWith('data:image/jpeg;base64,'));
   assert(visible.context.page_text.includes('用户刚上传的完整原图'));
   assert(visible.context.page_text.includes('OFFSCREEN_VISIBLE_NOTE'));
   for(const secret of ['PASSWORD_PRIVATE','TEXTAREA_PRIVATE','PRIVATE_PANEL','HIDDEN_NOTE']) assert(!JSON.stringify(visible).includes(secret));
   await page.getByLabel('允许查看当前网页').uncheck();
   const stopped=await ask('关闭之后呢');assert(!stopped.page_image&&!stopped.context.page_text);
   await page.getByLabel('选择截图').setInputFiles('public/author/avatar.jpg');
   await page.getByAltText('待发送截图预览').waitFor();
   const screen=await ask('解释这张截图');assert(screen.screen?.startsWith('data:image/jpeg;base64,'));
   assert(!screen.page_image);
   await page.getByAltText('待发送截图预览').waitFor({state:'detached'});
   // A browser-provided display stream is stopped immediately after its first still frame.
   await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#27a1b3';ctx.fillRect(0,0,320,180);
    const stream=canvas.captureStream(5);
    window.__visionTrack=stream.getVideoTracks()[0];
    Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>stream});
   });
   await page.getByRole('button',{name:'截取屏幕',exact:true}).click();
   await page.getByAltText('待发送截图预览').waitFor();
   assert.equal(await page.evaluate(()=>window.__visionTrack.readyState),'ended');
   const beforeCancel=requests.length;
   await page.getByRole('button',{name:'移除截图'}).click();
   assert.equal(requests.length,beforeCancel,'Capturing or removing never calls the provider');
   const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
   assert(!storage.includes('data:image/'),'Images never enter browser chat history');
   await page.screenshot({path:`artifacts/vision-${mobile?'mobile':'desktop'}.png`});
   assert.deepEqual(errors,[]);
   console.log(JSON.stringify({mobile,consent:true,uploadedOriginal:true,offscreenText:true,secretExclusion:true,screenshot:true,captureStops:true,noPersistedImages:true}));
   await context.close();
  }
 }finally{await browser.close()}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
