// Usage: node take-screenshots.mjs <appUrl> <apiUrl> <outDir>   (FRESH API: it installs the administrator through the screen)
// Needs playwright-core (install it where you run this: `bun add -d playwright-core` or `npm i --no-save playwright-core`)
// and a Chromium-based browser; BROWSER_CHANNEL picks it (default msedge, or chrome).
// Takes the screenshots for the README with the real app, fictional data and a synthetic camera picture.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const appUrl = process.argv[2];
const apiUrl = process.argv[3];
const outDir = path.resolve(process.argv[4]);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const taken = [];
const note = (name) => { taken.push(name); console.log('shot', name); };
const api = async (m, p, b, t) => { const r = await fetch(apiUrl + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); const x = await r.text(); try { return JSON.parse(x); } catch { return x; } };

// Synthetic media for the page (one function: it is serialised into the page, so it must not use anything outside it).
// A "camera" that shows a person in a room, and optionally a "screen" to share (a small dashboard).
const FAKE_MEDIA = ({ hue, screen }) => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.video) return original(constraints);
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let t = 0;
    const paint = () => {
      const wall = ctx.createLinearGradient(0, 0, 0, 360);
      wall.addColorStop(0, `hsl(${hue} 32% 80%)`); wall.addColorStop(1, `hsl(${hue} 30% 66%)`);
      ctx.fillStyle = wall; ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#eaf5ff'; ctx.fillRect(60, 40, 140, 150);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 6; ctx.strokeRect(60, 40, 140, 150);
      ctx.beginPath(); ctx.moveTo(130, 40); ctx.lineTo(130, 190); ctx.moveTo(60, 115); ctx.lineTo(200, 115); ctx.stroke();
      ctx.fillStyle = `hsl(${hue} 25% 38%)`; ctx.fillRect(470, 170, 140, 10);
      ctx.fillStyle = '#b5651d'; ctx.fillRect(520, 130, 40, 40);
      ctx.fillStyle = '#3f9d4f';
      for (const [x, y, r] of [[525, 105, 22], [555, 108, 22], [540, 85, 24]]) { ctx.beginPath(); ctx.ellipse(x, y, r * 0.55, r, 0, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = `hsl(${hue} 22% 28%)`; ctx.fillRect(0, 305, 640, 55);
      const sway = Math.sin(t / 25) * 4;
      const cx = 335 + sway;
      ctx.fillStyle = `hsl(${(hue + 150) % 360} 50% 42%)`;
      ctx.beginPath(); ctx.ellipse(cx, 345, 150, 110, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#d9a07c'; ctx.fillRect(cx - 20, 235, 40, 45);
      ctx.beginPath(); ctx.ellipse(cx, 185, 52, 62, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3b2a20';
      ctx.beginPath(); ctx.ellipse(cx, 150, 56, 46, 0, Math.PI, 0); ctx.fill();
      ctx.beginPath(); ctx.arc(cx - 52, 160, 14, 0, Math.PI * 2); ctx.arc(cx + 52, 160, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2a2018';
      ctx.beginPath(); ctx.arc(cx - 20, 182, 5, 0, Math.PI * 2); ctx.arc(cx + 20, 182, 5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#7a3b2e'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(cx, 205, 18, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
      t++;
    };
    paint(); setInterval(paint, 80);
    const stream = canvas.captureStream(12);
    if (constraints.audio) (await original({ audio: constraints.audio })).getAudioTracks().forEach((track) => stream.addTrack(track));
    return stream;
  };
  if (screen) {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const ctx = canvas.getContext('2d');
      let t = 0;
      const paint = () => {
        ctx.fillStyle = '#f4f6fa'; ctx.fillRect(0, 0, 1280, 720);
        ctx.fillStyle = '#222428'; ctx.fillRect(0, 0, 1280, 70);
        ctx.fillStyle = '#ffcd34'; ctx.font = 'bold 30px sans-serif'; ctx.fillText('Quarterly review', 230, 46);
        const bars = [220, 340, 280, 420, 380, 500, 460];
        bars.forEach((h, i) => { ctx.fillStyle = i === 5 ? '#ffcd34' : '#3a7bd5'; ctx.fillRect(230 + i * 118, 640 - h - (i === 5 ? Math.sin(t / 10) * 6 : 0), 78, h); });
        ctx.fillStyle = '#222428'; ctx.font = '24px sans-serif'; ctx.fillText('Revenue by month', 230, 130);
        ctx.fillStyle = '#6b7280'; ctx.font = '20px sans-serif';
        ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'].forEach((m, i) => ctx.fillText(m, 242 + i * 118, 675));
        t++;
      };
      paint(); setInterval(paint, 100);
      return canvas.captureStream(10);
    };
  }
};

const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
async function context(kind = 'desktop', init) {
  const common = { serviceWorkers: 'block', permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] };
  const ctx = await browser.newContext(kind === 'mobile'
    ? { ...common, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: MOBILE_UA }
    : { ...common, viewport: { width: 1280, height: kind === 'static' ? 900 : 800 } });
  if (init) await ctx.addInitScript(init.fn, init.arg);
  return ctx;
}
const shot = async (page, name, options = {}) => { await page.screenshot({ path: path.join(outDir, name), ...options }); note(name); };
const button = (p, label) => p.locator(`[role="button"][aria-label="${label}"]`);

// ---------- the administrator side ----------
{
  const ctx = await context('static');
  const page = await ctx.newPage();
  await page.goto(appUrl + '/home'); await sleep(1800);
  await shot(page, '01-home.png');

  await page.goto(appUrl + '/install'); await sleep(1500);
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'correct-horse-battery');
  await page.fill('input[name="confirmPassword"]', 'correct-horse-battery');
  await shot(page, '04-install.png');
  await page.click('ion-button:has-text("Create Admin")');
  await page.waitForURL('**/admin');
  await sleep(1200);
  await page.fill('input[name="username"]', 'admin');
  await page.fill('input[name="password"]', 'correct-horse-battery');
  await shot(page, '05-admin-sign-in.png');
  await page.click('ion-button:has-text("Sign In")');
  await page.waitForURL('**/hosts');
  await sleep(1200);
  await page.fill('input[name="name"]', 'Alice Martin');
  await page.fill('input[name="username"]', 'alice');
  await page.fill('input[name="password"]', 'a-long-host-password');
  await page.click('ion-button:has-text("Create Host")');
  await page.waitForSelector('text=Alice Martin');
  await sleep(500);
  await shot(page, '06-hosts-create.png'); // with the "Credentials copied." message
  const adminToken = (await api('POST', '/admin/signIn', { username: 'admin', password: 'correct-horse-battery' })).accessToken;
  await api('POST', '/host', { name: 'Bob Chen', username: 'bob', password: 'another-host-password' }, adminToken);
  await api('POST', '/host', { name: 'Carla Rossi', username: 'carla', password: 'third-host-password' }, adminToken);
  await page.goto(appUrl + '/hosts'); await page.waitForSelector('text=Carla Rossi'); await sleep(1500);
  await shot(page, '07-hosts.png');

  await page.click('text=Privacy Policy');
  await page.waitForURL('**/privacy/edit'); await sleep(1500);
  await page.locator('.ql-editor').evaluate((el) => el.setAttribute('spellcheck', 'false'));
  await page.locator('.ql-editor').click();
  await page.keyboard.type('Privacy policy');
  await page.keyboard.press('Enter');
  await page.keyboard.type('We only keep what the meetings need to work: the accounts of the hosts and the messages while a meeting runs. Calls go directly between the participants and are never recorded.');
  await sleep(300);
  await shot(page, '08-privacy-editor.png');
  await ctx.close();
}

// ---------- start and join ----------
{
  const ctx = await context('static');
  const page = await ctx.newPage();
  await page.goto(appUrl + '/start'); await sleep(1500);
  await page.fill('input[name="username"]', 'alice');
  await page.fill('input[name="password"]', 'a-long-host-password');
  await shot(page, '02-start.png');
  await page.goto(appUrl + '/join?id=Qm7xK2pLd9W'); await sleep(1500);
  await shot(page, '03-join.png');
  await ctx.close();
}

// ---------- a meeting with three people ----------
let meetingId;
const hostCtx = await context('desktop', { fn: FAKE_MEDIA, arg: { hue: 200 } });
const host = await hostCtx.newPage();
host.on('websocket', (ws) => { const m = ws.url().match(/[?&]id=([^&]+)/); if (m && ws.url().includes('/peer/peerjs') && !meetingId) meetingId = m[1]; });
await host.goto(appUrl + '/start'); await sleep(1000);
await host.fill('input[name="username"]', 'alice');
await host.fill('input[name="password"]', 'a-long-host-password');
await host.click('ion-button:has-text("Start Meeting")');
await host.waitForSelector('video'); await sleep(1000);

async function join(ctxFactory) {
  const ctx = await ctxFactory;
  const page = await ctx.newPage();
  await page.goto(`${appUrl}/join?id=${meetingId}`); await sleep(800);
  await page.click('ion-button:has-text("Join Meeting")');
  await page.waitForSelector('video');
  return { ctx, page };
}
const m1 = await join(context('desktop', { fn: FAKE_MEDIA, arg: { hue: 280 } }));
await sleep(2500);
await shot(m1.page, '09-meeting-voice.png'); // a voice meeting: avatars, no black squares

const m2 = await join(context('desktop', { fn: FAKE_MEDIA, arg: { hue: 25, screen: true } }));
await sleep(3000);

// the host and the second guest switch their cameras on, the first guest mutes the microphone
await button(host, 'Turn camera on').click();
await button(m2.page, 'Turn camera on').click();
await button(m1.page, 'Mute microphone').click();
await sleep(5000);
await shot(m1.page, '10-meeting-camera.jpg', { type: 'jpeg', quality: 86 });
await m1.page.evaluate(() => document.querySelector('ion-content').scrollToBottom(0));
await sleep(700);
await shot(m1.page, '11-meeting-participants.jpg', { type: 'jpeg', quality: 86 });
await m1.page.evaluate(() => document.querySelector('ion-content').scrollToTop(0));
await sleep(500);
const cropMenu = async (page, name) => {
  await page.evaluate(() => { document.documentElement.style.zoom = '2.2'; });
  await sleep(500);
  await page.locator('[class*="MenuItems_bottom"]').screenshot({ path: path.join(outDir, name) });
  await page.evaluate(() => { document.documentElement.style.zoom = ''; });
  await sleep(400);
  note(name);
};
await cropMenu(m1.page, '12-menu-muted.png');
await cropMenu(host, '13-menu-on.png');

// chat
const send = async (page, text) => { await page.fill('textarea[aria-label="Message"]', text); await page.keyboard.press('Enter'); await sleep(600); };
await button(m1.page, 'Chat').click(); await sleep(400);
await button(host, 'Chat').click(); await sleep(400);
await button(m2.page, 'Chat').click(); await sleep(400);
await send(m1.page, 'Hi everyone, my microphone is off because of the noise here. I can follow, I will write.');
await send(host, 'No problem, we can read you. Let us start with the agenda.');
await send(m2.page, 'I can share the numbers on my screen when we get to the second point.');
await sleep(1200);
await shot(m1.page, '14-chat.png');

// whiteboard (the host draws, everybody sees it)
await button(m1.page, 'Chat').click().catch(() => {});
await sleep(300);
await host.keyboard.press('Escape'); // closes the host's chat panel
await sleep(400);
await button(host, 'Whiteboard').click();
await sleep(2200);
const box = await host.locator('canvas').first().boundingBox();
if (box) {
  const stroke = async (points) => { await host.mouse.move(box.x + points[0][0], box.y + points[0][1]); await host.mouse.down(); for (const [x, y] of points.slice(1)) await host.mouse.move(box.x + x, box.y + y, { steps: 6 }); await host.mouse.up(); };
  await stroke([[380, 260], [620, 260], [620, 350], [380, 350], [380, 260]]);
  await stroke([[760, 260], [1000, 260], [1000, 350], [760, 350], [760, 260]]);
  await stroke([[620, 305], [760, 305]]); await stroke([[735, 290], [760, 305], [735, 320]]);
  await stroke([[420, 450], [470, 420], [520, 470], [570, 420], [620, 470], [670, 420], [720, 470]]);
  await sleep(1000);
}
await shot(host, '15-whiteboard.png');
await button(host, 'Whiteboard').click().catch(() => {});

// screen sharing: the second guest shares, the first guest looks at it
await m2.page.locator('[role="button"][aria-label="Share screen"]').click();
await sleep(5000);
await m1.page.evaluate(() => document.querySelector('ion-content').scrollToBottom(0));
await sleep(500);
const tiles = m1.page.locator('[class*="VideoBlock_square"]');
for (let i = 0; i < (await tiles.count()); i++) {
  const hasPicture = await tiles.nth(i).evaluate((el) => !el.querySelector('[class*="AudioOnly_audioOnly"]'));
  const self = await tiles.nth(i).evaluate((el) => !!el.querySelector('video[class*="horizontalFlip"]'));
  if (hasPicture && !self) { await tiles.nth(i).click(); break; }
}
await sleep(2500);
await m1.page.evaluate(() => document.querySelector('ion-content').scrollToTop(0));
await sleep(700);
await shot(m1.page, '16-screen-share.jpg', { type: 'jpeg', quality: 86 });

// ---------- the phone ----------
{
  const m3 = await join(context('mobile'));
  await sleep(3000);
  await shot(m3.page, '21-mobile-meeting.png');
  await button(m3.page, 'Chat').click(); await sleep(900);
  await shot(m3.page, '22-mobile-chat.png');
  const home = await (await context('mobile')).newPage();
  await home.goto(appUrl + '/home'); await sleep(1800);
  await shot(home, '20-mobile-home.png');
}

console.log(`\n${taken.length} screenshots`);
await browser.close();
