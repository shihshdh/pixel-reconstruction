// 实际 WebGL draw 与布局读取计数：可见预览、滚出视口、返回。付费请求全部 mock。
const fs = require('node:fs');
const { chromium } = require('playwright');
const { PROBE } = require('./ux-audit.cjs');
const arg = (k,d) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k)+1] : d;
(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
  try {
    const context = await browser.newContext({ viewport: { width: 393,height: 852 },deviceScaleFactor:3,isMobile:true,hasTouch:true });
    await context.addInitScript(PROBE,true);
    await context.addInitScript(job => {
      localStorage.setItem('ruhua-gallery-v1',JSON.stringify([{...job,title:'验收场景',date:'2026/10/22',meta:'Beam',thumb:new URL(job.file_urls['original.jpg'],job.backend_url).href}]));
      window.__draws = new WeakMap(); window.__layoutReads = 0;
      for (const proto of [WebGLRenderingContext.prototype,WebGL2RenderingContext.prototype]) {
        for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']) {
          const fn=proto[name]; if(!fn) continue;
          proto[name]=function(...args) { window.__draws.set(this.canvas,(window.__draws.get(this.canvas)||0)+1); return fn.apply(this,args); };
        }
      }
      for(const name of ['offsetWidth','offsetHeight']) {
        const desc=Object.getOwnPropertyDescriptor(HTMLElement.prototype,name);
        Object.defineProperty(HTMLElement.prototype,name,{...desc,get(){ if(typeof this.className==='string' && this.className.includes('viewer-mount')) window.__layoutReads++; return desc.get.call(this); }});
      }
    },JSON.parse(fs.readFileSync('artifacts/secure-job.json')));
    await require('./mock-paid.cjs')(context);
    const page=await context.newPage();
    const cdp=await context.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
    await page.goto(arg('--url','http://127.0.0.1:3207'));
    await page.getByRole('button',{name:/直接进入/}).click(); await page.waitForTimeout(2000);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='作品库' && b.getBoundingClientRect().width)?.click());
    await page.getByRole('button',{name:/打开场景/}).first().click();
    await page.waitForSelector('[class*=viewer-mount] canvas',{timeout:120000}); await page.waitForTimeout(15000);
    await page.getByRole('button',{name:'缓推',exact:true}).first().click();
    const canvas=page.locator('[class*=viewer-mount] canvas').first();
    const counts=()=>page.evaluate(()=>({draws:window.__draws.get(document.querySelector('[class*=viewer-mount] canvas'))||0,reads:window.__layoutReads}));
    const sample=async()=>{ const a=await counts(); await page.waitForTimeout(2000); const b=await counts(); return {draws:b.draws-a.draws,layoutReads:b.reads-a.reads}; };
    await canvas.scrollIntoViewIfNeeded(); await page.waitForTimeout(1500);
    const visible=await sample();
    await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight)); await page.waitForTimeout(1500);
    const offscreen=await canvas.evaluate(el=>el.getBoundingClientRect().bottom<=0);
    if(!offscreen) throw Error('画布尚未完全滚出视口');
    const hidden=await sample();
    await canvas.scrollIntoViewIfNeeded(); await page.waitForTimeout(1500);
    const resumed=await sample();
    const result={visible,hidden,resumed};
    fs.writeFileSync(arg('--out','artifacts/task-k/visibility.json'),JSON.stringify(result,null,2)); console.log(result);
    if(process.argv.includes('--assert') && (hidden.draws!==0 || hidden.layoutReads!==0 || !visible.draws || !resumed.draws)) throw Error('可见性调度断言失败');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
