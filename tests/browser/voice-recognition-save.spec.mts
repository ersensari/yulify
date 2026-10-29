import { type Page } from '@playwright/test';
import { test, expect, mockPortal, reply } from './portal-mock';

async function voiceSettings(page: Page) {
  let voice = { enabled:true, whisperUrl:'http://localhost/stt', breezeUrl:'http://localhost/tts', instruction:'Clear speech', voice:'design', runtime:'breeze', language:'auto', cfgScale:4 };
  let recognition = { enabled:true, speaker_verification_enabled:false, segmentation_mode:'vad', interval_seconds:2, silence_ms:800, speech_start_threshold:.5, speech_end_threshold:.35, min_speech_ms:96, pre_roll_ms:320, tail_ms:160, max_utterance_seconds:30, language:'auto', cpu_threads:4, barge_in_enabled:true, diarization_enabled:true };
  const limits = {silence_ms:[200,3000,1],interval_seconds:[1,30,.1],speech_start_threshold:[.1,.95,.01],speech_end_threshold:[.05,.9,.01],min_speech_ms:[64,2000,1],pre_roll_ms:[0,1000,1],tail_ms:[0,1000,1],max_utterance_seconds:[2,30,1],cpu_threads:[1,16,1]};
  const calls: string[] = [];
  let refuse = false;
  await mockPortal(page, ({path,method,json}) => {
    if (path === '/api/voice') {
      if (method === 'PUT') { calls.push('voice'); voice=json(); }
      return voice;
    }
    if (path === '/api/voice/asr-settings') {
      if (method === 'PUT') {
        calls.push('recognition');
        if (refuse) return reply(400,{error:'Could not save recognition settings'});
        recognition=json();
      }
      return {settings:recognition,limits,status:'enabled',identity:{required:false,minimum_seconds:1,threshold:.32,policy:'disabled'},model:'Whisper',vad_frame_ms:32};
    }
    if (path === '/api/voice/install') return {available:false,state:'unavailable',busy:false,progress:'',error:''};
    if (path === '/api/voice/presets') return [];
    if (path === '/api/voice/hardware') return {gpus:[],source:'none',checked:false};
  }, {settings:true});
  const open = async () => {
    await page.goto('/settings/add-ons');
    await page.getByRole('dialog',{name:'Settings'}).getByRole('tab',{name:'Voice',exact:true}).click();
    await expect(page.getByLabel('End-of-turn silence (ms)',{exact:false})).toHaveValue('800');
  };
  await open();
  return {calls, recognition:()=>recognition, refuse:(value:boolean)=>{refuse=value;}};
}

test('the main Save persists recognition settings and closes without discard; reopening retains them', async ({page}) => {
  const saved=await voiceSettings(page);
  const dialog=page.getByRole('dialog',{name:'Settings'});
  await dialog.getByLabel('End-of-turn silence (ms)',{exact:false}).fill('1200');
  await dialog.getByRole('button',{name:'Save voice settings',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
  expect(saved.recognition().silence_ms).toBe(1200);
  expect(saved.calls).toEqual(['recognition','voice']);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog',{name:'Discard your changes?'})).toBeHidden();
  await expect(dialog).toBeHidden();
  await page.goto('/settings/add-ons');
  await page.getByRole('dialog',{name:'Settings'}).getByRole('tab',{name:'Voice',exact:true}).click();
  await expect(page.getByLabel('End-of-turn silence (ms)',{exact:false})).toHaveValue('1200');
});

test('a rejected recognition save keeps the draft and prevents a false Saved result', async ({page}) => {
  const saved=await voiceSettings(page);
  const dialog=page.getByRole('dialog',{name:'Settings'});
  saved.refuse(true);
  await dialog.getByLabel('End-of-turn silence (ms)',{exact:false}).fill('1200');
  await dialog.getByRole('button',{name:'Save voice settings',exact:true}).click();
  await expect(dialog.getByRole('region',{name:'Transcription and speaker verification'}).getByRole('alert')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Saved',exact:true})).toBeHidden();
  expect(saved.recognition().silence_ms).toBe(800);
  expect(saved.calls).toEqual(['recognition']);
  await page.keyboard.press('Escape');
  const discard=page.getByRole('alertdialog',{name:'Discard your changes?'});
  await expect(discard).toBeVisible();
  await discard.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog.getByLabel('End-of-turn silence (ms)',{exact:false})).toHaveValue('1200');
  saved.refuse(false);
  await dialog.getByRole('button',{name:'Save voice settings',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('interval previews retain the separate silence endpoint setting', async ({page}) => {
  const saved=await voiceSettings(page);
  const dialog=page.getByRole('dialog',{name:'Settings'});
  await dialog.getByLabel('Transcription mode').selectOption('fixed_interval');
  await dialog.getByLabel('Transcription interval (seconds)',{exact:false}).fill('1');
  const silence=dialog.getByLabel('End-of-turn silence (ms)',{exact:false});
  await expect(silence).toBeEnabled();
  await silence.fill('1200');
  await dialog.getByRole('button',{name:'Save voice settings',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
  expect(saved.recognition().segmentation_mode).toBe('fixed_interval');
  expect(saved.recognition().interval_seconds).toBe(1);
  expect(saved.recognition().silence_ms).toBe(1200);
});

test('voice layout defaults to full and is saved with the main Voice Save action',async({page})=>{
 await voiceSettings(page);
 const dialog=page.getByRole('dialog',{name:'Settings'});
 const choice=dialog.getByRole('combobox',{name:'Voice conversation view'});
 await expect(choice).toHaveValue('full');
 await choice.selectOption('mini');
 expect(await page.evaluate(()=>localStorage.getItem('yulify.voiceLayout'))).toBeNull();
 await dialog.getByRole('button',{name:'Save voice settings',exact:true}).click();
 await expect(dialog.getByRole('button',{name:'Saved',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>localStorage.getItem('yulify.voiceLayout'))).toBe('mini');
 await page.keyboard.press('Escape');
 await page.goto('/settings/add-ons');
 await page.getByRole('dialog',{name:'Settings'}).getByRole('tab',{name:'Voice',exact:true}).click();
 await expect(page.getByRole('combobox',{name:'Voice conversation view'})).toHaveValue('mini');
});
