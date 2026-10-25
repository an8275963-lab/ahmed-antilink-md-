const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || path.join(__dirname, 'auth');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let sock;
let currentQR = '';
let connectionStatus = 'Starting';
let lastError = '';
let reconnecting = false;
let settings = { antilink: true, welcome: false, antiTag: false };

try {
  if (fs.existsSync(SETTINGS_FILE)) {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  }
} catch (e) { console.error('Settings load error:', e.message); }

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); }
  catch (e) { console.error('Settings save error:', e.message); }
}
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function page() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>AHMED ANTI-LINK BOT</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0b1220;color:#eaf0ff;font:16px system-ui}
  main{max-width:680px;margin:28px auto;padding:16px}.card{background:#151f32;border:1px solid #293751;border-radius:18px;padding:22px;margin:14px 0}
  h1{margin:0 0 8px;color:#67e8b5}p{color:#b9c6dd;line-height:1.5}.status{font-weight:700}
  #qr{display:block;width:min(280px,100%);margin:16px auto;background:white;padding:10px;border-radius:12px}
  .muted{font-size:13px;color:#91a1bd}.pill{display:inline-block;padding:6px 10px;border-radius:99px;background:#263650}
  a{color:#67e8b5}button{border:0;border-radius:10px;padding:10px 14px;background:#67e8b5;color:#07130f;font-weight:700}
  </style></head><body><main><div class="card"><h1>AHMED ANTI-LINK MD BOT</h1>
  <p>WhatsApp QR connection panel</p><span class="pill status" id="status">Loading status…</span>
  <p id="hint">Open WhatsApp → Linked devices → Link a device, then scan this QR.</p>
  <img id="qr" alt="WhatsApp login QR" style="display:none"><p class="muted" id="qrnote">QR refreshes automatically. Do not share this page publicly.</p>
  <p class="muted">If connected, the QR disappears. Keep the hosting service and persistent auth storage running.</p></div>
  <div class="card"><h2>Features</h2><p>Anti-link: <b id="anti">…</b><br>Welcome messages: <b id="welcome">…</b><br>Anti-tag: <b id="antitag">…</b></p>
  <p class="muted">Change features in the group with .antilink on/off, .welcome on/off and .antitag on/off (bot should have the needed group permissions).</p></div>
  <div class="card"><h3>Safety / setup</h3><p>Never share your QR or session files. Add the bot to your group and make it an admin so it can delete messages. Only use this bot in groups where you have permission.</p></div>
  </main><script>
  async function refresh(){try{const r=await fetch('/status');const d=await r.json();
  document.getElementById('status').textContent=d.status;
  document.getElementById('anti').textContent=d.settings.antilink?'ON':'OFF';
  document.getElementById('welcome').textContent=d.settings.welcome?'ON':'OFF';
  document.getElementById('antitag').textContent=d.settings.antiTag?'ON':'OFF';
  const img=document.getElementById('qr'); if(d.qr){img.src=d.qr;img.style.display='block';}else{img.style.display='none';}
  document.getElementById('hint').textContent=d.status==='Connected'?'WhatsApp connected successfully.':'Open WhatsApp → Linked devices → Link a device, then scan the QR.';
  }catch(e){document.getElementById('status').textContent='Panel reconnecting';}}
  refresh();setInterval(refresh,3000);
  </script></body></html>`;
}
app.get('/', (_req, res) => res.type('html').send(page()));
app.get('/health', (_req, res) => res.json({ ok: true, status: connectionStatus }));
app.get('/status', async (_req, res) => {
  let qr = '';
  if (currentQR) {
    try { qr = await QRCode.toDataURL(currentQR, { margin: 1, width: 280 }); }
    catch (e) { lastError = e.message; }
  }
  res.json({ status: connectionStatus, qr, settings, error: lastError ? 'A connection error occurred; check host logs.' : '' });
});

const LINK_RE = /(?:https?:\/\/|www\.|(?:^|\s)(?:t\.me\/|telegram\.me\/|wa\.me\/|chat\.whatsapp\.com\/|whatsapp\.com\/|youtube\.com\/|youtu\.be\/|m\.youtube\.com\/|tiktok\.com\/|vm\.tiktok\.com\/|vt\.tiktok\.com\/|instagram\.com\/|facebook\.com\/|fb\.watch\/|discord\.gg\/|discord\.com\/invite\/)[^\s]+/i;
const GROUP_RE = /@g\.us$/;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function sendText(jid, text, quoted) {
  if (!sock) return;
  try { await sock.sendMessage(jid, { text }, quoted ? { quoted } : {}); }
  catch (e) { console.error('Send message error:', e.message); }
}
async function isAdmin(jid, participant) {
  try {
    const metadata = await sock.groupMetadata(jid);
    const member = metadata.participants.find(p => p.id === participant || p.lid === participant);
    return !!member && (member.admin === 'admin' || member.admin === 'superadmin');
  } catch (_) { return false; }
}
async function handleMessage(m) {
  const msg = m.message;
  if (!msg || m.key.fromMe) return;
  const jid = m.key.remoteJid;
  if (!jid) return;
  const isGroup = GROUP_RE.test(jid);
  const sender = m.key.participant || m.key.remoteJid;
  const body = msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption || '';
  const text = String(body).trim();
  if (!text) return;

  if (text.toLowerCase() === '.menu') {
    await sendText(jid,
`╭─「 AHMED MD BOT 」
│ .menu — show commands
│ .ping — check bot response
│ .antilink on/off — block links in groups
│ .welcome on/off — welcome new members
│ .antitag on/off — block @everyone/@all
│ .groupinfo — group details
│ .tagall — mention group members (admins)
╰──────────────
Note: link deletion needs the bot to be a group admin.
Current anti-link: ${settings.antilink ? 'ON' : 'OFF'}`, m);
    return;
  }
  if (text.toLowerCase() === '.ping') {
    await sendText(jid, '🏓 Pong! AHMED MD BOT is online.', m); return;
  }
  if (/^\.(antilink|welcome|antitag)\s+(on|off)$/i.test(text)) {
    if (!isGroup) { await sendText(jid, 'Yeh command sirf group mein use hoti hai.', m); return; }
    const [, feature, state] = text.match(/^\.(antilink|welcome|antitag)\s+(on|off)$/i);
    const admin = await isAdmin(jid, sender);
    if (!admin) { await sendText(jid, 'Sirf group admin is setting ko change kar sakta hai.', m); return; }
    const key = feature.toLowerCase() === 'antitag' ? 'antiTag' : feature.toLowerCase();
    settings[key] = state.toLowerCase() === 'on'; saveSettings();
    await sendText(jid, `✅ ${feature} ${state.toUpperCase()} ho gaya.`, m); return;
  }
  if (text.toLowerCase() === '.groupinfo' && isGroup) {
    try {
      const meta = await sock.groupMetadata(jid);
      await sendText(jid, `📋 ${meta.subject}\nMembers: ${meta.participants.length}\nGroup ID: ${jid}`, m);
    } catch (_) { await sendText(jid, 'Group info nahi mil saka.', m); }
    return;
  }
  if (text.toLowerCase() === '.tagall' && isGroup) {
    if (!(await isAdmin(jid, sender))) { await sendText(jid, 'Sirf group admin .tagall use kar sakta hai.', m); return; }
    try {
      const meta = await sock.groupMetadata(jid);
      const mentions = meta.participants.map(p => p.id);
      const lines = mentions.map(id => `@${id.split('@')[0]}`).join(' ');
      await sock.sendMessage(jid, { text: `📢 Group members:\n${lines}`, mentions });
    } catch (_) { await sendText(jid, 'Tagall fail hua. Dobara try karo.', m); }
    return;
  }
  if (!isGroup) return;

  if (settings.antiTag && /@everyone|@all/i.test(text)) {
    try {
      if (await isAdmin(jid, sender)) return;
      await sock.sendMessage(jid, { delete: m.key });
      await sendText(jid, '⚠️ @everyone/@all mention allowed nahi hai.');
    } catch (e) { console.error('Anti-tag delete failed:', e.message); }
    return;
  }
  if (settings.antilink && LINK_RE.test(text)) {
    try {
      if (await isAdmin(jid, sender)) return;
      await sock.sendMessage(jid, { delete: m.key });
      await sendText(jid, '🔗 Link delete kar diya gaya — group mein links allowed nahi hain.');
    } catch (e) {
      console.error('Link deletion failed (bot may not be admin):', e.message);
    }
  }
}

async function startBot() {
  if (reconnecting) return;
  reconnecting = true;
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); }
    catch (e) { console.error('Could not fetch latest WhatsApp version; using library default.', e.message); }
    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['AHMED MD BOT', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { currentQR = qr; connectionStatus = 'Waiting for QR scan'; }
      if (connection === 'open') {
        currentQR = ''; connectionStatus = 'Connected'; lastError = '';
        console.log('WhatsApp connected.');
      }
      if (connection === 'close') {
        connectionStatus = 'Disconnected';
        const code = lastDisconnect?.error?.output?.statusCode;
        console.error('WhatsApp connection closed. Status:', code || 'unknown');
        if (code === DisconnectReason.loggedOut) {
          currentQR = '';
          console.error('Logged out. Remove the saved auth directory and redeploy/restart to pair again.');
        } else {
          await sleep(2500);
          reconnecting = false;
          startBot();
        }
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try { await handleMessage(m); }
        catch (e) { console.error('Message handler error:', e.stack || e.message); }
      }
    });
  } catch (e) {
    lastError = e.message; connectionStatus = 'Startup error';
    console.error('Bot startup failed:', e.stack || e.message);
    await sleep(5000);
  } finally {
    reconnecting = false;
  }
}
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web panel listening on port ${PORT}`);
  startBot();
});
