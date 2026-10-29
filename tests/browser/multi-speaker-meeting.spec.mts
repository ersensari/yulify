import {test,expect} from './portal-mock';

async function mount(page:any,component:string) {
  await page.goto('/');
  await page.evaluate(async(name:string)=>{
    const reactPath='/node_modules/.vite/deps/react.js';
    const domPath='/node_modules/.vite/deps/react-dom_client.js';
    const react=await import(reactPath),dom=await import(domPath);
    const module=await import(`/src/components/${name}.tsx`);
    const host=document.createElement('div');host.style.cssText='position:fixed;right:20px;bottom:20px;z-index:9999;background:white;color:black;padding:16px;width:500px';
    document.body.append(host);(dom.default||dom).createRoot(host).render((react.default||react).createElement(module[name],{sessionId:'meeting-test'}));
  },component);
}

test('Stop waits for queued audio and keeps sequence order without a physical microphone',async({page})=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const sequences:number[]=[];let stopCalled=false;
  const snapshot={id:'source',status:'recording',sample_rate:16000,samples:0,next_sequence:0,turns:[]};
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/meeting/start'))return route.fulfill({json:snapshot});
    if(path.endsWith('/meeting/chunk')){
      const seq=Number(route.request().headers()['x-audio-sequence']);sequences.push(seq);
      if(seq===0)await held;
      return route.fulfill({json:{...snapshot,samples:(seq+1)*16000,next_sequence:seq+1}});
    }
    if(path.endsWith('/meeting/stop')){stopCalled=true;return route.fulfill({json:{...snapshot,status:'completed',transcriptPath:'.meeting-notes/test.txt'}});}
    if(path.endsWith('/meeting'))return route.fulfill({json:snapshot});
    return route.fulfill({json:{}});
  });
  await page.addInitScript(()=>{
    Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})},configurable:true});
    (window as any).AudioContext=class {
      sampleRate=16000;destination={};
      resume(){return Promise.resolve();}close(){return Promise.resolve();}
      createMediaStreamSource(){return {connect(){}};}
      createGain(){return {gain:{value:0},connect(){}};}
      createScriptProcessor(){const node={connect(){},disconnect(){},onaudioprocess:null};(window as any).recorder=node;return node;}
    };
  });
  await mount(page,'MeetingNotes');
  await page.getByRole('button',{name:'Start meeting notes',exact:true}).click();
  await expect(page.getByRole('button',{name:'Stop meeting notes',exact:true})).toBeVisible();
  await page.evaluate(()=>{
    const node=(window as any).recorder;
    for(let i=0;i<3;i++)node.onaudioprocess({inputBuffer:{getChannelData:()=>new Float32Array(16000).fill(.2)}});
  });
  await expect.poll(()=>sequences.length).toBe(1);
  await page.getByRole('button',{name:'Stop meeting notes',exact:true}).click();
  expect(stopCalled).toBe(false);
  release();
  await expect.poll(()=>stopCalled).toBe(true);
  expect(sequences).toEqual([0,1,2]);
  await expect(page.getByText('Saved in Files: .meeting-notes/test.txt')).toBeVisible();
});

test('Retained speaker examples can be assigned permanently and deleted',async({page})=>{
  const id='a'.repeat(32);let person:string|null=null,deleted=false;
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname,method=route.request().method();
    if(path==='/api/voice/speaker-examples')return route.fulfill({json:{retention_days:7,examples:deleted?[]:[{id,session_id:'session1234',label:'Speaker 1',created:Date.now()/1000,seconds:3,person,expires_at:person?null:Date.now()/1000+604800,start_sample:0,end_sample:48000}]}});
    if(path===`/api/voice/speaker-examples/${id}`){
      if(method==='PUT')person=route.request().postDataJSON().person;
      if(method==='DELETE')deleted=true;
      return route.fulfill({json:{ok:true}});
    }
    return route.fulfill({json:{}});
  });
  await mount(page,'SpeakerExamples');
  await expect(page.getByText('Speaker 1',{exact:true})).toBeVisible();
  await page.getByPlaceholder('Person name').fill('Ersen');
  await page.getByRole('button',{name:'Keep',exact:true}).click();
  await expect(page.getByText(/Kept until deleted/)).toBeVisible();
  expect(person).toBe('Ersen');
  await page.getByRole('button',{name:'Delete',exact:true}).click();
  await expect(page.getByText(/No retained examples/)).toBeVisible();expect(deleted).toBe(true);
});
