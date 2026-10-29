import { test, expect, mockPortal } from './portal-mock';

const transport=`export class MiniCpmDuplexRoom {
 constructor(id,hooks){this.hooks=hooks;window.voiceAcoustics=event=>hooks.event(event);window.voiceConnects=window.voiceConnects||0;}
 async connect(){window.voiceConnects++;this.hooks.state('connected');}
 async setMicrophoneEnabled(enabled){window.micEnabled=enabled;}
 async sendText(text){if(window.rejectText)throw new Error('Voice input unavailable');window.voiceTexts=(window.voiceTexts||[]).concat(text);this.hooks.event({type:'assistant.text.delta',response_id:crypto.randomUUID(),text:'Spoken response to '+text});this.hooks.event({type:'voice.activity',activity:'speaking'});}
 async close(){window.voiceCloses=(window.voiceCloses||0)+1;}
 async interrupt(){window.interrupted=true;}
 async setMusicPlaying(){}
}`;
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('yulify.theme','dark'));
 await mockPortal(page,({path})=>path==='/api/voice'?{enabled:true}:undefined);
 await page.route('**/api/sessions/test/commands',r=>r.fulfill({json:{commands:[]}}));
 await page.route('**/api/sessions/test/config',r=>r.fulfill({status:503,json:{}}));
 await page.route('**/src/minicpm-duplex-room.ts',r=>r.fulfill({body:transport,contentType:'application/javascript'}));
});
test('switches between full and mini without reconnecting; typed and muted input use the live voice room',async({page})=>{
 await page.goto('/tests/voice.html');
 await page.getByRole('button',{name:'Start voice mode',exact:true}).click();
 await expect(page.locator('.voice-stage')).toBeVisible();
 await page.getByRole('button',{name:'Use mini orb in chat'}).click();
 await expect(page.locator('.mini-voice-bar')).toBeVisible();
 await expect(page.getByText('We can work through it together.')).toBeVisible();
 const box=page.getByRole('textbox',{name:'Message',exact:true});
 await expect(box).toBeVisible();
 await box.fill('Read my typed request');await box.press('Enter');
 await expect.poll(()=>page.evaluate(()=>(window as any).voiceTexts)).toEqual(['Read my typed request']);
 await expect(page.getByTestId('sent')).toHaveText('0');
 await expect(page.locator('.mini-voice-bar')).toContainText('Spoken response to Read my typed request');
 await page.screenshot({path:'/tmp/yulify-mini-chat-preview.png'});
 await page.locator('.mini-voice-bar').getByRole('button',{name:'Mute microphone',exact:true}).click();
 await box.fill('Still respond while muted');await box.press('Enter');
 await expect.poll(()=>page.evaluate(()=>(window as any).voiceTexts?.length)).toBe(2);
 await page.getByRole('button',{name:'Expand voice view'}).click();
 await expect(page.locator('.voice-stage')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).voiceConnects)).toBe(1);
 await page.locator('.voice-stage').getByRole('button',{name:'End voice mode',exact:true}).click();
 await expect(page.locator('.voice-stage')).toHaveCount(0);
 await expect(box).toBeVisible();
});
test('mini preference survives reopening and a rejected message restores the draft',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('yulify.voiceLayout','mini'));
 await page.setViewportSize({width:390,height:844});
 await page.goto('/tests/voice.html');
 await page.getByRole('button',{name:'Start voice mode',exact:true}).click();
 await expect(page.locator('.mini-voice-bar')).toBeVisible();
 const box=page.getByRole('textbox',{name:'Message',exact:true});
 await page.evaluate(()=>{(window as any).rejectText=true;});
 await box.fill('Keep this unsent draft');await box.press('Enter');
 await expect(box).toHaveValue('Keep this unsent draft');
 await expect(page.getByRole('alert').filter({hasText:'Voice input unavailable'})).toBeVisible();
 const bounds=await page.locator('.mini-voice-bar').boundingBox();expect(bounds!.width).toBeLessThan(391);
 await page.locator('.mini-voice-bar').getByRole('button',{name:'End voice mode',exact:true}).click();
});

test('experimental acoustics status follows both voice layouts without breaking the conversation',async({page})=>{
 await page.goto('/tests/voice.html');await page.getByRole('button',{name:'Start voice mode',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).voiceAcoustics)).toBe('function');
 await page.evaluate(()=>{(window as any).voiceAcoustics({type:'voice.acoustics',status:'measured',hint:'near_like',c50_db:15});});
 await expect(page.getByText('Near-like · experimental',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Use mini orb in chat'}).click();
 await expect(page.locator('.mini-voice-bar').getByText('Near-like · experimental',{exact:true})).toBeVisible();
 await page.evaluate(()=>{(window as any).voiceAcoustics({type:'voice.acoustics',status:'unavailable'});});
 await expect(page.locator('.mini-voice-bar').getByText('Acoustic analysis unavailable',{exact:true})).toBeVisible();
 await expect(page.locator('.mini-voice-bar')).toBeVisible();
});

test('mini view draws independent microphone and speech levels',async({page})=>{
 await page.addInitScript(()=>localStorage.setItem('yulify.voiceLayout','mini'));
 await page.goto('/tests/voice.html');await page.getByRole('button',{name:'Start voice mode',exact:true}).click();
 const canvas=page.locator('.mini-voice-waves canvas');await expect(canvas).toBeVisible();
 const pixels=()=>canvas.evaluate((c:HTMLCanvasElement)=>{const d=c.getContext('2d')!.getImageData(0,0,c.width,c.height).data;let upper=0,lower=0;for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++)if(d[(y*c.width+x)*4+3]){if(y<14)upper++;else lower++;}return {upper,lower};});
 const before=await pixels();
 await page.evaluate(()=>{(window as any).voiceAcoustics({type:'microphone.capture',level:.8,enabled:true,muted:false});(window as any).voiceAcoustics({type:'voice.output.level',level:.9});});
 await expect.poll(async()=>{const p=await pixels();return p.upper>before.upper&&p.lower>before.lower;}).toBe(true);
});
