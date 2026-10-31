/* ==================================================================
   STATE
================================================================== */
let me = null;              // {email, name, bio}
let authToken = '';
let authMode = 'login';
let regDraft = {email:'', password:''};

let adminCode = '';         // код ва токени маъмур танҳо дар хотира, то панел кушода аст
let adminToken = '';
let adminTabName = 'convs';
let adminConvId = null;

let convs = [];             // рӯйхати сӯҳбатҳои ман
let currentConv = null;     // сӯҳбати кушода
let curMsgs = [];
let lastSig = '';
let editingMsgId = null;
let ngMembers = [];         // аъзоёни гурӯҳи нав
let listTimer = null, msgTimer = null, searchTimer = null, ngTimer = null, gaTimer = null;

/* ==================================================================
   NAVIGATION
================================================================== */
function switchScreen(name){
  if(name !== 'admin'){ adminCode = ''; adminToken = ''; }
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.screen===name));
  if(name==='library' && !document.getElementById('library-list').dataset.loaded) renderLibrary();
  if(name==='pharmacy' && !document.getElementById('pharmacy-list').dataset.loaded) renderPharmacy();
  if(name==='ai' && !document.getElementById('ai-messages').dataset.loaded) initAiChat();
  if(name==='chat' && me){ loadConversations(); }
}

/* ==================================================================
   КУМАКИҲО
================================================================== */
// Танҳо сессияи воридшуда дар браузер нигоҳ дошта мешавад
const store = {
  get(k){ try{ return localStorage.getItem('farida:'+k); }catch(e){ return null; } },
  set(k,v){ try{ localStorage.setItem('farida:'+k, v); }catch(e){} },
  del(k){ try{ localStorage.removeItem('farida:'+k); }catch(e){} }
};

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function initials(name){
  const w = String(name || '?').trim().split(/\s+/).filter(Boolean).slice(0,2);
  return (w.map(x => Array.from(x)[0]).join('') || '?').toUpperCase();
}
function avatarColor(key){
  let h = 0; const s = String(key || '');
  for(let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) % 360;
  return 'hsl('+h+',52%,42%)';
}
function avatarHtml(name, key, cls){
  return '<div class="avatar '+(cls||'')+'" style="background:'+avatarColor(key)+'">'+esc(initials(name))+'</div>';
}
function fmtTime(ts){
  const d = new Date(ts), now = new Date();
  const hm = d.toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit'});
  if(d.toDateString() === now.toDateString()) return hm;
  return String(d.getDate()).padStart(2,'0') + '.' + String(d.getMonth()+1).padStart(2,'0') + ' ' + hm;
}

async function call(method, url, body, extra){
  const headers = {'Content-Type':'application/json'};
  if(authToken) headers['Authorization'] = 'Bearer ' + authToken;
  if(extra) Object.assign(headers, extra);
  try{
    const r = await fetch(url, {method, headers, body: body === undefined ? undefined : JSON.stringify(body)});
    let data = {};
    try{ data = await r.json(); }catch(e){}
    if(r.status === 401 && authToken) sessionExpired();
    return {ok: r.ok, status: r.status, data};
  }catch(e){
    return {ok:false, status:0, data:{error:'network'}};
  }
}
const api = (url, body) => call('POST', url, body);
const adminCall = (method, url, body) => call(method, url, body, {'X-Admin-Token': adminToken});

function sessionExpired(){
  if(!authToken) return;
  logout();
  showAuthError('Сессия тамом шуд. Бори дигар ворид шавед.');
}

/* ==================================================================
   AUTH — вуруд, сабти ном (2 қадам), барқарорсозии код
   Санҷиши парол дар сервер анҷом меёбад (паролҳо ба браузер намераванд).
================================================================== */
const AUTH_TITLES = {
  login:  ['Вуруд ба ҳисоб', 'Барои истифодаи чат ворид шавед'],
  reg1:   ['Сабти номи нав', 'Қадами 1 аз 2: акаунт ва код'],
  reg2:   ['Сабти номи нав', 'Қадами 2 аз 2: номи шумо'],
  forgot: ['Барқарор кардани код', 'Код ба почтаи шумо фиристода мешавад']
};

function showAuthMode(mode){
  authMode = mode;
  hideAuthMessages();
  ['login','reg1','reg2','forgot'].forEach(m=>{
    document.getElementById('panel-'+m).classList.toggle('active', m===mode);
  });
  document.getElementById('auth-title').textContent = AUTH_TITLES[mode][0];
  document.getElementById('auth-sub').textContent = AUTH_TITLES[mode][1];
}
function hideAuthMessages(){
  document.getElementById('auth-error').style.display='none';
  document.getElementById('auth-info').style.display='none';
}
function showAuthError(msg){
  document.getElementById('auth-info').style.display='none';
  const el = document.getElementById('auth-error');
  el.textContent = msg; el.style.display='block';
}
function showAuthInfo(msg){
  document.getElementById('auth-error').style.display='none';
  const el = document.getElementById('auth-info');
  el.textContent = msg; el.style.display='block';
}

const isEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function handleLogin(){
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  if(!email || !password){ showAuthError('Лутфан ҳарду майдонро пур кунед.'); return; }
  if(!isEmail(email)){ showAuthError('Почтаи электронӣ нодуруст аст.'); return; }
  const r = await api('/api/login', {email, password});
  if(r.ok){ loginSuccess(r.data, r.data.token); return; }
  if(r.status === 401) showAuthError('Акаунт ё код нодуруст аст.');
  else showAuthError('Сервер дастрас нест. Бори дигар кӯшиш кунед.');
}

// Қадами 1: акаунт ва код
async function regNext(){
  const email = document.getElementById('reg-email').value.trim().toLowerCase();
  const password = document.getElementById('reg-password').value;
  if(!email || !password){ showAuthError('Лутфан ҳарду майдонро пур кунед.'); return; }
  if(!isEmail(email)){ showAuthError('Почтаи электронӣ нодуруст аст. Масалан: name@gmail.com'); return; }
  if(password.length < 4){ showAuthError('Код бояд камаш 4 аломат бошад.'); return; }
  const r = await api('/api/email-exists', {email});
  if(!r.ok){ showAuthError('Сервер дастрас нест. Бори дигар кӯшиш кунед.'); return; }
  if(r.data.exists){ showAuthError('Ин акаунт аллакай сабт шудааст. Ворид шавед.'); return; }
  regDraft = {email, password};
  showAuthMode('reg2');
}

// Қадами 2: ном ва анҷоми сабти ном
async function handleRegister(){
  const name = document.getElementById('reg-name').value.trim();
  if(name.length < 2){ showAuthError('Лутфан номи худро нависед.'); return; }
  const r = await api('/api/register', {email: regDraft.email, password: regDraft.password, name});
  if(r.ok){ loginSuccess(r.data, r.data.token); return; }
  if(r.status === 409){ showAuthMode('reg1'); showAuthError('Ин акаунт аллакай сабт шудааст.'); return; }
  showAuthError('Сабти ном нашуд. Бори дигар кӯшиш кунед.');
}

// Код фаромӯш шуд
async function handleForgot(){
  const email = document.getElementById('forgot-email').value.trim().toLowerCase();
  if(!isEmail(email)){ showAuthError('Почтаи электронӣ нодуруст аст.'); return; }
  const r = await api('/api/forgot', {email});
  if(r.ok){
    showAuthInfo('Агар ин акаунт сабт шуда бошад, код ба почтаи шумо фиристода шуд. Папкаи «Спам»-ро низ санҷед.');
  } else if(r.status === 429){
    showAuthError('Лутфан як дақиқа интизор шавед ва бори дигар кӯшиш кунед.');
  } else if(r.data && r.data.error === 'smtp_not_configured'){
    showAuthError('Хидмати почта дар сервер танзим нашудааст. Бо маъмур тамос гиред.');
  } else if(r.data && r.data.error === 'mail_failed'){
    showAuthError('Почтаро фиристода натавонистем. Баъдтар кӯшиш кунед.');
  } else {
    showAuthError('Сервер дастрас нест. Бори дигар кӯшиш кунед.');
  }
}

function loginSuccess(user, token){
  me = {email: user.email, name: user.name, bio: user.bio || ''};
  authToken = token;
  store.set('session', JSON.stringify({token}));
  document.getElementById('auth-view').style.display = 'none';
  document.getElementById('chat-view').style.display = 'block';
  document.getElementById('session-pill').classList.add('show');
  startMessenger();
}

function logout(){
  if(authToken) call('POST', '/api/logout');
  authToken = ''; me = null; currentConv = null; convs = []; curMsgs = []; editingMsgId = null;
  clearInterval(listTimer); clearInterval(msgTimer);
  store.del('session');
  document.getElementById('session-pill').classList.remove('show');
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('auth-view').style.display = 'block';
  ['login-email','login-password','reg-email','reg-password','reg-name','forgot-email']
    .forEach(id => document.getElementById(id).value = '');
  regDraft = {email:'', password:''};
  showAuthMode('login');
}

async function restoreSession(){
  const raw = store.get('session');
  if(!raw) return;
  let s = null;
  try{ s = JSON.parse(raw); }catch(e){}
  if(!s || !s.token){ store.del('session'); return; }
  try{
    const r = await fetch('/api/me', {headers: {'Authorization': 'Bearer ' + s.token}});
    if(r.ok) loginSuccess(await r.json(), s.token);
    else store.del('session');
  }catch(e){ /* сервер дастрас нест */ }
}

/* ==================================================================
   МЕССЕНҶЕР — ҳар корбар саҳифаи худро дорад, чати дутарафа ва гурӯҳӣ
================================================================== */
const chatActive = () => me && document.getElementById('screen-chat').classList.contains('active');
const searchActive = () => document.getElementById('m-search').value.trim() !== '';

const SEND_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function renderMe(){
  document.getElementById('m-me-avatar').innerHTML = avatarHtml(me.name, me.email);
  document.getElementById('m-me-name').textContent = me.name;
  document.getElementById('m-me-email').textContent = me.email;
  document.getElementById('session-name').textContent = me.name;
}

function startMessenger(){
  renderMe();
  document.getElementById('m-search').value = '';
  closeMain();
  loadConversations();
  clearInterval(listTimer);
  listTimer = setInterval(() => { if(chatActive() && !searchActive()) loadConversations(); }, 5000);
  clearInterval(msgTimer);
  msgTimer = setInterval(() => {
    if(chatActive() && currentConv && document.getElementById('m-messages')) loadMessages(false);
  }, 3000);
}

function emptyMainHtml(){
  return '<div class="m-empty"><div class="m-empty-ic">💬</div><h3>Сӯҳбатро интихоб кунед</h3>'
    + '<p>Сӯҳбатро аз рӯйхат кушоед ё бо ҷустуҷӯи боло корбареро ёбед, ба саҳифаи ӯ ворид шавед ва паём нависед. Метавонед гурӯҳ низ созед.</p></div>';
}

function closeMain(){
  currentConv = null; editingMsgId = null; lastSig = ''; curMsgs = [];
  document.getElementById('m-main').innerHTML = emptyMainHtml();
  document.getElementById('messenger').classList.remove('show-main');
  renderConvList();
}

async function loadConversations(){
  if(!me) return;
  const r = await call('GET', '/api/conversations');
  if(!r.ok) return;
  convs = r.data.conversations;
  renderConvList();
}

function renderConvList(){
  if(searchActive()) return;
  const el = document.getElementById('m-list');
  if(!convs.length){
    el.innerHTML = '<div class="empty-state">Ҳанӯз сӯҳбате нест.<br>Корбареро ҷустуҷӯ кунед ё гурӯҳ созед.</div>';
    return;
  }
  el.innerHTML = convs.map(c => {
    const active = currentConv && currentConv.id === c.id ? ' active' : '';
    let snip;
    if(!c.last) snip = 'Гурӯҳ сохта шуд';
    else if(c.last.deleted) snip = 'Паём нест карда шуд';
    else {
      const who = c.last.sender === me.email ? 'Шумо: ' : (c.type === 'group' ? c.last.senderName + ': ' : '');
      snip = who + c.last.text.replace(/\s+/g, ' ');
    }
    const unread = c.unread ? '<span class="badge-unread">' + (c.unread > 99 ? '99+' : c.unread) + '</span>' : '';
    return '<div class="conv-item' + active + '" data-id="' + esc(c.id) + '" onclick="openConversation(this.dataset.id)">'
      + avatarHtml(c.title, c.email || c.id)
      + '<div class="ci-main"><div class="ci-top"><b>' + (c.type === 'group' ? '👥 ' : '') + esc(c.title) + '</b>'
      + '<small>' + (c.last ? fmtTime(c.last.created) : '') + '</small></div>'
      + '<div class="ci-bottom"><span class="ci-last">' + esc(snip) + '</span>' + unread + '</div></div></div>';
  }).join('');
}

/* ---------- Ҷустуҷӯи корбарон ---------- */
function userRowHtml(u, fn, extra){
  return '<div class="user-row" data-email="' + esc(u.email) + '" data-name="' + esc(u.name) + '" onclick="' + fn + '(this.dataset.email,this.dataset.name)">'
    + avatarHtml(u.name, u.email)
    + '<div class="ur-text"><b>' + esc(u.name) + '</b><small>' + esc(u.email) + '</small></div>' + (extra || '') + '</div>';
}

function onUserSearch(){
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const qv = document.getElementById('m-search').value.trim();
    if(!qv){ renderConvList(); return; }
    const r = await call('GET', '/api/users?q=' + encodeURIComponent(qv));
    if(!r.ok || document.getElementById('m-search').value.trim() !== qv) return;
    document.getElementById('m-list').innerHTML = '<div class="m-list-title">Корбарон</div>'
      + (r.data.users.length ? r.data.users.map(u => userRowHtml(u, 'openUser')).join('') : '<div class="empty-state">Корбар ёфт нашуд.</div>');
  }, 250);
}

/* ---------- Панелҳо дар тарафи рост ---------- */
function setPanel(title, html){
  document.getElementById('m-main').innerHTML =
    '<div class="m-head"><button class="m-back always" onclick="panelBack()">←</button>'
    + '<div class="m-head-text"><b>' + esc(title) + '</b></div></div>'
    + '<div class="m-panel">' + html + '</div>';
  document.getElementById('messenger').classList.add('show-main');
}

function panelBack(){
  if(currentConv){ renderConvView(); loadMessages(true); }
  else closeMain();
}

// Саҳифаи ("сайти") корбар
async function openUser(email){
  if(email === me.email){ showMyProfile(); return; }
  const r = await call('GET', '/api/users/' + encodeURIComponent(email));
  if(!r.ok) return;
  const u = r.data;
  setPanel('Саҳифаи корбар',
    '<div class="profile-card">' + avatarHtml(u.name, u.email, 'lg')
    + '<div class="p-name">' + esc(u.name) + '</div>'
    + '<div class="p-email">' + esc(u.email) + '</div>'
    + '<div class="p-bio">' + (u.bio ? esc(u.bio) : '<i>Тавсиф навишта нашудааст</i>') + '</div>'
    + '<div class="p-meta">Аз ' + new Date(u.created).toLocaleDateString('ru-RU') + ' дар барнома</div>'
    + '<button class="btn btn-green" data-email="' + esc(u.email) + '" onclick="startDm(this.dataset.email)">💬 Паём навиштан</button></div>');
}

async function startDm(email){
  const r = await call('POST', '/api/dm', {email});
  if(!r.ok) return;
  document.getElementById('m-search').value = '';
  await loadConversations();
  openConversation(r.data.id);
}

// Саҳифаи ман
function showMyProfile(){
  setPanel('Саҳифаи ман',
    '<div class="profile-card">' + avatarHtml(me.name, me.email, 'lg') + '<div class="p-email">' + esc(me.email) + '</div></div>'
    + '<div class="field"><label>Ном</label><input type="text" id="pf-name" maxlength="60" value="' + esc(me.name) + '"></div>'
    + '<div class="field"><label>Дар бораи худ (тавсиф)</label><textarea id="pf-bio" rows="4" maxlength="300" placeholder="Чанд сатр дар бораи худ нависед...">' + esc(me.bio) + '</textarea></div>'
    + '<div class="error-msg" id="pf-err"></div><div class="info-msg" id="pf-info"></div>'
    + '<div class="auth-actions"><button class="btn btn-green" onclick="saveProfile()">Захира кардан</button></div>'
    + '<div class="auth-switch"><a onclick="logout()">Баромадан аз ҳисоб</a></div>');
}

async function saveProfile(){
  const err = document.getElementById('pf-err'), info = document.getElementById('pf-info');
  err.style.display = 'none'; info.style.display = 'none';
  const name = document.getElementById('pf-name').value.trim();
  const bio = document.getElementById('pf-bio').value.trim();
  if(name.length < 2){ err.textContent = 'Ном бояд камаш 2 ҳарф бошад.'; err.style.display = 'block'; return; }
  const r = await call('PUT', '/api/profile', {name, bio});
  if(!r.ok){ err.textContent = 'Захира нашуд. Бори дигар кӯшиш кунед.'; err.style.display = 'block'; return; }
  me = {email: r.data.email, name: r.data.name, bio: r.data.bio || ''};
  renderMe();
  info.textContent = 'Саҳифаи шумо нав шуд.'; info.style.display = 'block';
}

/* ---------- Гурӯҳи нав ---------- */
function showNewGroup(){
  ngMembers = [];
  setPanel('Гурӯҳи нав',
    '<div class="field"><label>Номи гурӯҳ</label><input type="text" id="ng-name" maxlength="60" placeholder="масалан: Оилаи мо"></div>'
    + '<div class="field"><label>Аъзоён</label><div id="ng-chips" class="chips"></div>'
    + '<input type="text" id="ng-search" placeholder="Ҷустуҷӯи корбар (ном ё почта)..." oninput="ngSearch()"></div>'
    + '<div id="ng-results"></div>'
    + '<div class="error-msg" id="ng-err"></div>'
    + '<div class="auth-actions"><button class="btn btn-green" onclick="createGroup()">Сохтани гурӯҳ</button></div>');
  renderChips();
}

function renderChips(){
  const el = document.getElementById('ng-chips');
  if(!el) return;
  el.innerHTML = ngMembers.length
    ? ngMembers.map(m => '<span class="chip">' + esc(m.name) + '<button data-email="' + esc(m.email) + '" onclick="ngRemove(this.dataset.email)">×</button></span>').join('')
    : '<span class="chips-empty">Ҳанӯз аъзо илова нашудааст</span>';
}

function ngSearch(){
  clearTimeout(ngTimer);
  ngTimer = setTimeout(async () => {
    const box = document.getElementById('ng-search');
    const out = document.getElementById('ng-results');
    if(!box || !out) return;
    const qv = box.value.trim();
    if(!qv){ out.innerHTML = ''; return; }
    const r = await call('GET', '/api/users?q=' + encodeURIComponent(qv));
    if(!r.ok || !document.getElementById('ng-search')) return;
    const list = r.data.users.filter(u => !ngMembers.some(m => m.email === u.email));
    out.innerHTML = list.length ? list.map(u => userRowHtml(u, 'ngAdd')).join('') : '<div class="empty-state">Корбар ёфт нашуд.</div>';
  }, 250);
}
function ngAdd(email, name){
  if(!ngMembers.some(m => m.email === email)) ngMembers.push({email, name});
  document.getElementById('ng-search').value = '';
  document.getElementById('ng-results').innerHTML = '';
  renderChips();
}
function ngRemove(email){
  ngMembers = ngMembers.filter(m => m.email !== email);
  renderChips();
}
async function createGroup(){
  const err = document.getElementById('ng-err');
  err.style.display = 'none';
  const name = document.getElementById('ng-name').value.trim();
  if(name.length < 2){ err.textContent = 'Номи гурӯҳро нависед.'; err.style.display = 'block'; return; }
  if(!ngMembers.length){ err.textContent = 'Камаш як аъзо илова кунед.'; err.style.display = 'block'; return; }
  const r = await call('POST', '/api/groups', {name, members: ngMembers.map(m => m.email)});
  if(!r.ok){ err.textContent = 'Гурӯҳ сохта нашуд. Бори дигар кӯшиш кунед.'; err.style.display = 'block'; return; }
  await loadConversations();
  openConversation(r.data.id);
}

/* ---------- Сӯҳбат ---------- */
async function openConversation(id){
  const r = await call('GET', '/api/conversations/' + encodeURIComponent(id));
  if(!r.ok) return;
  currentConv = r.data; editingMsgId = null; lastSig = '';
  renderConvView();
  await loadMessages(true);
  renderConvList();
  loadConversations();
}

function renderConvView(){
  const c = currentConv;
  const sub = c.type === 'group' ? c.members.length + ' аъзо' : (c.other ? c.other.email : '');
  document.getElementById('m-main').innerHTML =
    '<div class="m-head">'
    + '<button class="m-back" onclick="closeMain()">←</button>'
    + '<div onclick="showConvInfo()" style="cursor:pointer">' + avatarHtml(c.title, c.other ? c.other.email : c.id) + '</div>'
    + '<div class="m-head-text" onclick="showConvInfo()"><b>' + (c.type === 'group' ? '👥 ' : '') + esc(c.title) + '</b><small>' + esc(sub) + '</small></div>'
    + '</div>'
    + '<div class="chat-messages m-messages" id="m-messages"></div>'
    + '<div class="m-editbar" id="m-editbar" style="display:none"><span>✏️ Таҳрири паём</span><a onclick="cancelEdit()">Бекор кардан</a></div>'
    + '<div class="chat-input-row">'
    + '<input type="text" id="m-input" placeholder="Паём нависед..." maxlength="4000" onkeydown="if(event.key===\'Enter\') sendMsg();">'
    + '<button class="icon-send" onclick="sendMsg()">' + SEND_SVG + '</button></div>';
  document.getElementById('messenger').classList.add('show-main');
}

async function loadMessages(force){
  if(!currentConv) return;
  const id = currentConv.id;
  const r = await call('GET', '/api/conversations/' + encodeURIComponent(id) + '/messages');
  if(r.status === 404){ closeMain(); loadConversations(); return; }
  if(!r.ok || !currentConv || currentConv.id !== id) return;
  curMsgs = r.data.messages;
  const sig = JSON.stringify(curMsgs.map(m => [m.id, m.text, m.edited, m.deleted]));
  if(!force && sig === lastSig) return;
  lastSig = sig;
  renderMessages(curMsgs, force);
}

function renderMessages(msgs, forceScroll){
  const box = document.getElementById('m-messages');
  if(!box) return;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  if(!msgs.length){
    box.innerHTML = '<div class="empty-state">Ҳанӯз паём нест. Аввалин паёмро нависед!</div>';
    return;
  }
  const group = currentConv.type === 'group';
  box.innerHTML = msgs.map(m => {
    const mine = m.sender === me.email;
    const sender = (!mine && group) ? '<span class="sender">' + esc(m.senderName) + '</span>' : '';
    const body = m.deleted ? '<span class="msg-deleted">Ин паём нест карда шуд</span>' : '<span class="msg-text">' + esc(m.text) + '</span>';
    const meta = fmtTime(m.created) + (m.edited && !m.deleted ? ' · таҳрир шуд' : '');
    const actions = (mine && !m.deleted)
      ? '<span class="msg-actions"><button title="Таҳрир кардан" onclick="startEdit(' + m.id + ')">✏️</button><button title="Нест кардан" onclick="deleteMsg(' + m.id + ')">🗑️</button></span>'
      : '';
    return '<div class="bubble ' + (mine ? 'me' : 'doc') + '">' + sender + body + '<span class="meta">' + meta + '</span>' + actions + '</div>';
  }).join('');
  if(forceScroll || atBottom) box.scrollTop = box.scrollHeight;
}

async function sendMsg(){
  const input = document.getElementById('m-input');
  if(!input || !currentConv) return;
  const text = input.value.trim();
  if(!text) return;
  if(editingMsgId){
    const r = await call('PUT', '/api/messages/' + editingMsgId, {text});
    if(!r.ok){ alert('Таҳрир нашуд.'); return; }
    cancelEdit();
  } else {
    input.value = '';
    const r = await call('POST', '/api/conversations/' + encodeURIComponent(currentConv.id) + '/messages', {text});
    if(!r.ok){ input.value = text; alert('Паём фиристода нашуд.'); return; }
  }
  await loadMessages(true);
  loadConversations();
}

function startEdit(id){
  const m = curMsgs.find(x => x.id === id);
  const input = document.getElementById('m-input');
  if(!m || m.deleted || !input) return;
  editingMsgId = id;
  input.value = m.text;
  document.getElementById('m-editbar').style.display = 'flex';
  input.focus();
}
function cancelEdit(){
  editingMsgId = null;
  const bar = document.getElementById('m-editbar'), input = document.getElementById('m-input');
  if(bar) bar.style.display = 'none';
  if(input) input.value = '';
}
async function deleteMsg(id){
  if(!confirm('Ин паёмро нест мекунед? Онро барои ҳама нест мекунад.')) return;
  if(editingMsgId === id) cancelEdit();
  const r = await call('DELETE', '/api/messages/' + id);
  if(!r.ok){ alert('Нест карда нашуд.'); return; }
  await loadMessages(true);
  loadConversations();
}

/* ---------- Маълумоти сӯҳбат / гурӯҳ ---------- */
function showConvInfo(){
  if(!currentConv) return;
  if(currentConv.type === 'dm'){ if(currentConv.other) openUser(currentConv.other.email); return; }
  showGroupInfo();
}

function showGroupInfo(){
  const c = currentConv;
  const isOwner = c.owner === me.email;
  const rows = c.members.map(m => userRowHtml(m, 'openUser', m.email === c.owner ? '<span class="owner-tag">Соҳиб</span>' : '')).join('');
  setPanel('Маълумоти гурӯҳ',
    '<div class="profile-card">' + avatarHtml(c.title, c.id, 'lg')
    + '<div class="p-name">' + esc(c.title) + '</div><div class="p-meta">' + c.members.length + ' аъзо</div></div>'
    + '<h4>Аъзоён</h4><div>' + rows + '</div>'
    + (isOwner
      ? '<h4 style="margin-top:20px">Иловаи аъзо</h4><div class="field"><input type="text" id="ga-search" placeholder="Ҷустуҷӯи корбар (ном ё почта)..." oninput="gaSearch()"></div><div id="ga-results"></div>'
      : '')
    + '<div class="auth-actions"><button class="btn btn-outline" onclick="leaveGroup()">Баромадан аз гурӯҳ</button></div>');
}

function gaSearch(){
  clearTimeout(gaTimer);
  gaTimer = setTimeout(async () => {
    const box = document.getElementById('ga-search'), out = document.getElementById('ga-results');
    if(!box || !out || !currentConv) return;
    const qv = box.value.trim();
    if(!qv){ out.innerHTML = ''; return; }
    const r = await call('GET', '/api/users?q=' + encodeURIComponent(qv));
    if(!r.ok || !document.getElementById('ga-search')) return;
    const list = r.data.users.filter(u => !currentConv.members.some(m => m.email === u.email));
    out.innerHTML = list.length ? list.map(u => userRowHtml(u, 'gaAdd')).join('') : '<div class="empty-state">Корбар ёфт нашуд.</div>';
  }, 250);
}
async function gaAdd(email){
  if(!currentConv) return;
  const r = await call('POST', '/api/conversations/' + encodeURIComponent(currentConv.id) + '/members', {email});
  if(!r.ok){ alert('Аъзо илова нашуд.'); return; }
  currentConv = r.data;
  showGroupInfo();
  loadConversations();
}
async function leaveGroup(){
  if(!currentConv || !confirm('Аз гурӯҳ мебароед?')) return;
  const r = await call('POST', '/api/conversations/' + encodeURIComponent(currentConv.id) + '/leave', {});
  if(!r.ok){ alert('Баромада нашуд.'); return; }
  closeMain();
  loadConversations();
}

/* ==================================================================
   ПАНЕЛИ МАЪМУР — танҳо назорат (хондан). Маъмур паём намефиристад.
================================================================== */
function openAdminPanel(){
  switchScreen('admin');
  ['admin-new-code','admin-new-code2'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('admin-code-error').style.display = 'none';
  document.getElementById('admin-code-info').style.display = 'none';
  adminTabName = 'convs';
  renderAdminList();
}

function adminTab(name){
  adminTabName = name;
  renderAdminList();
}

async function renderAdminList(){
  adminConvId = null;
  document.getElementById('admin-chat-view').style.display = 'none';
  document.getElementById('admin-settings').style.display = 'block';
  document.getElementById('admin-main').style.display = 'block';
  document.getElementById('tab-convs').classList.toggle('active', adminTabName === 'convs');
  document.getElementById('tab-users').classList.toggle('active', adminTabName === 'users');

  const el = document.getElementById('admin-user-list');
  el.innerHTML = '<div class="empty-state">Бор карда истодааст...</div>';

  if(adminTabName === 'convs'){
    const r = await adminCall('GET', '/api/admin/conversations');
    if(!r.ok){ el.innerHTML = '<div class="empty-state">Хатогӣ дар боркунӣ. Бори дигар бо код ворид шавед.</div>'; return; }
    const list = r.data.conversations;
    if(!list.length){ el.innerHTML = '<div class="empty-state">Ҳанӯз сӯҳбате нест.</div>'; return; }
    el.innerHTML = list.map(c => {
      const last = c.last ? (c.last.deleted ? '(паём нест карда шуд)' : c.last.sender + ': ' + c.last.text) : 'Паём нест';
      return '<div class="admin-user" data-id="' + esc(c.id) + '" onclick="openAdminConv(this.dataset.id)"><div>'
        + '<b>' + (c.type === 'group' ? '👥 ' : '💬 ') + esc(c.title) + '</b><br>'
        + '<span>' + esc(last.replace(/\s+/g, ' ').slice(0, 80)) + ' · ' + c.count + ' паём · ' + c.members.length + ' аъзо</span>'
        + '</div><span>→</span></div>';
    }).join('');
  } else {
    const r = await adminCall('GET', '/api/admin/users');
    if(!r.ok){ el.innerHTML = '<div class="empty-state">Хатогӣ дар боркунӣ. Бори дигар бо код ворид шавед.</div>'; return; }
    if(!r.data.users.length){ el.innerHTML = '<div class="empty-state">Ҳанӯз корбаре нест.</div>'; return; }
    el.innerHTML = r.data.users.map(u =>
      '<div class="admin-user" style="cursor:default"><div><b>' + esc(u.name) + '</b><br><span>' + esc(u.email)
      + ' · сабт шуд: ' + new Date(u.created).toLocaleDateString('ru-RU') + '</span></div></div>'
    ).join('');
  }
}

async function openAdminConv(id){
  adminConvId = id;
  const r = await adminCall('GET', '/api/admin/conversations/' + encodeURIComponent(id) + '/messages');
  if(!r.ok) return;
  document.getElementById('admin-settings').style.display = 'none';
  document.getElementById('admin-main').style.display = 'none';
  document.getElementById('admin-chat-view').style.display = 'block';
  document.getElementById('admin-conv-head').innerHTML =
    '<h3>' + (r.data.type === 'group' ? '👥 ' : '💬 ') + esc(r.data.title) + '</h3>'
    + '<p style="font-size:.85rem;color:var(--gray);margin:0;">Аъзоён: ' + r.data.members.map(m => esc(m.name) + ' (' + esc(m.email) + ')').join(', ') + '</p>';
  const box = document.getElementById('admin-messages');
  if(!r.data.messages.length){
    box.innerHTML = '<div class="empty-state">Ҳанӯз паём нест.</div>';
    return;
  }
  box.innerHTML = r.data.messages.map(m =>
    '<div class="bubble doc"><span class="sender">' + esc(m.senderName) + ' <small>' + esc(m.sender) + '</small></span>'
    + (m.deleted ? '<span class="msg-deleted">Паём аз тарафи фиристанда нест карда шуд</span>' : '<span class="msg-text">' + esc(m.text) + '</span>')
    + '<span class="meta">' + fmtTime(m.created) + (m.edited && !m.deleted ? ' · таҳрир шуд' : '') + '</span></div>'
  ).join('');
  box.scrollTop = box.scrollHeight;
}

function refreshAdminConv(){
  if(adminConvId) openAdminConv(adminConvId);
}

async function changeAdminCode(){
  const errEl = document.getElementById('admin-code-error');
  const infoEl = document.getElementById('admin-code-info');
  errEl.style.display = 'none'; infoEl.style.display = 'none';
  const showErr = m => { errEl.textContent = m; errEl.style.display = 'block'; };

  const n1 = document.getElementById('admin-new-code').value;
  const n2 = document.getElementById('admin-new-code2').value;
  if(!/^\S{6,64}$/.test(n1)){ showErr('Код бояд аз 6 то 64 аломат бошад ва фосила надошта бошад.'); return; }
  if(n1 !== n2){ showErr('Ду код мувофиқат намекунанд.'); return; }
  if(!adminCode){ showErr('Сессия тамом шуд. Бори дигар бо код ворид шавед.'); return; }

  const r = await api('/api/admin/change-code', {oldCode: adminCode, newCode: n1});
  if(r.ok){
    adminCode = n1;
    document.getElementById('admin-new-code').value = '';
    document.getElementById('admin-new-code2').value = '';
    infoEl.textContent = 'Коди маъмур иваз шуд. Аз ин дам бо коди нав ворид шавед.';
    infoEl.style.display = 'block';
  } else if(r.status === 400){
    showErr('Код бояд аз 6 то 64 аломат бошад ва фосила надошта бошад.');
  } else if(r.status === 403){
    showErr('Сессия тамом шуд. Бори дигар бо код ворид шавед.');
  } else if(r.status === 429){
    showErr('Кӯшишҳои зиёд. Баъди чанд дақиқа дубора кӯшиш кунед.');
  } else {
    showErr('Сервер дастрас нест. Бори дигар кӯшиш кунед.');
  }
}

/* ==================================================================
   LIBRARY (specialties & subspecialties)
================================================================== */
const LIBRARY = [
  {name:'Кардиология', desc:'Илми дил ва рагҳо', subs:[
    {name:'Аритмология', desc:'Ташхис ва табобати вайроншавии зарбаи дил.'},
    {name:'Кардиохирургия', desc:'Ҷарроҳии дил, аз ҷумла шунтгузаронӣ ва тағйири клапан.'},
    {name:'Кардиологияи инвазивӣ', desc:'Табобат тавассути катетер, бе ҷарроҳии кушода.'}
  ]},
  {name:'Педиатрия', desc:'Саломатии кӯдакон', subs:[
    {name:'Неонатология', desc:'Нигоҳубини навзодон, махсусан таваллуди пеш аз мӯҳлат.'},
    {name:'Эндокринологияи кӯдакона', desc:'Мушкилоти рушд, диабет ва гормонҳо дар кӯдакон.'},
    {name:'Неврологияи кӯдакона', desc:'Мушкилоти системаи асаб дар кӯдакон.'}
  ]},
  {name:'Неврология', desc:'Системаи асаб', subs:[
    {name:'Эпилептология', desc:'Ташхис ва табобати ҳамлаҳои эпилептикӣ.'},
    {name:'Неврологияи инсулт', desc:'Табобати таъҷилӣ ва барқарорсозӣ пас аз инсулт.'}
  ]},
  {name:'Гинекология', desc:'Саломатии занон', subs:[
    {name:'Акушерӣ', desc:'Назорати ҳомиладорӣ ва таваллуд.'},
    {name:'Онкогинекология', desc:'Ташхис ва табобати варамҳои системаи репродуктивӣ.'},
    {name:'Репродуктология', desc:'Табобати нобарорӣ ва усулҳои кумаки репродуктивӣ.'}
  ]},
  {name:'Стоматология', desc:'Дандон ва даҳон', subs:[
    {name:'Ортодонтия', desc:'Рост кардани дандонҳои каҷ бо брекет ё капа.'},
    {name:'Ҷарроҳии дандон', desc:'Хориҷкунӣ ва ҷарроҳии мураккаби дандон.'},
    {name:'Терапияи дандон', desc:'Табобати кариес ва масолеҳгузорӣ.'}
  ]},
  {name:'Дерматология', desc:'Пӯст ва мӯй', subs:[
    {name:'Дерматокосметология', desc:'Табобати эстетикии пӯст.'},
    {name:'Аллергология', desc:'Ташхиси реаксияҳои аллергӣ ва зиддиаллергия.'}
  ]},
  {name:'Офтальмология', desc:'Чашм ва биноӣ', subs:[
    {name:'Ретинология', desc:'Табобати бемориҳои пардаи шабакия.'},
    {name:'Ҷарроҳии чашм', desc:'Аз ҷумла ҷарроҳии катаракта ва лазерӣ.'}
  ]},
  {name:'ЛОР (Гӯшу-гулӯ-бинӣ)', desc:'Роҳҳои нафас ва шунавоӣ', subs:[
    {name:'Отология', desc:'Ташхис ва табобати гӯш ва шунавоӣ.'},
    {name:'Ринология', desc:'Табобати бинӣ ва синусҳо.'}
  ]},
  {name:'Ортопедия', desc:'Устухон ва буғумҳо', subs:[
    {name:'Травматология', desc:'Табобати осеб ва шикастагии устухон.'},
    {name:'Ҷарроҳии сутунмӯҳра', desc:'Табобати мушкилоти сутунмӯҳра.'}
  ]},
  {name:'Психиатрия', desc:'Саломатии равонӣ', subs:[
    {name:'Психотерапия', desc:'Табобат тавассути гуфтугӯ ва усулҳои равонӣ.'},
    {name:'Наркология', desc:'Табобати вобастагӣ ба моддаҳо.'}
  ]}
];

const hasPaths = () => typeof LEARNING !== 'undefined';
let pathSpec = null;     // номи ихтисосе, ки роҳи омӯзишаш кушода аст

/* ---------- Пешрафти омӯзиш (дар браузер, барои ҳар корбар алоҳида) ---------- */
function progKey(){ return 'progress:' + (me ? me.email : 'guest'); }
function loadProgress(){ try{ return JSON.parse(store.get(progKey()) || '{}'); }catch(e){ return {}; } }
function saveProgress(p){ store.set(progKey(), JSON.stringify(p)); }
function pathTotal(name){
  const L = LEARNING[name];
  return L ? L.stages.reduce((n, s) => n + s.topics.length, 0) : 0;
}
function pathDone(name){
  const L = LEARNING[name];
  if(!L) return 0;
  const p = loadProgress()[name] || {};
  let n = 0;
  L.stages.forEach((s, si) => s.topics.forEach((t, ti) => { if(p[si + '-' + ti]) n++; }));
  return n;
}
function pathPercent(name){
  const t = pathTotal(name);
  return t ? Math.round(pathDone(name) * 100 / t) : 0;
}

function renderLibrary(){
  const el = document.getElementById('library-list');
  el.dataset.loaded = '1';
  el.innerHTML = '';
  LIBRARY.forEach((spec, i)=>{
    const L = hasPaths() ? LEARNING[spec.name] : null;
    const pct = L ? pathPercent(spec.name) : 0;
    const icon = L ? '<span class="spec-ic">' + L.icon + '</span>' : '';
    const chip = L ? '<span class="path-chip' + (pct ? ' on' : '') + '">📚 ' + (pct ? 'Пешрафт: ' + pct + '%' : 'Роҳи омӯзиш') + '</span>' : '';
    const btn = L ? '<button class="btn btn-green path-btn" onclick="openPath(' + i + ')">📚 Роҳи омӯзиш аз 0 то 100</button>' : '';
    const div = document.createElement('div');
    div.className = 'box spec-item';
    div.id = 'spec-'+i;
    div.innerHTML = `
      <div class="head" onclick="toggleSpec(${i})">
        <div class="head-main">${icon}<div><h3>${spec.name}</h3><span style="font-size:.78rem;color:var(--gray);">${spec.desc}</span>${chip}</div></div>
        <svg viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </div>
      <div class="sub-list">
        ${spec.subs.map(s=>`<div class="sub-item"><h4>${s.name}</h4><p>${s.desc}</p></div>`).join('')}
        ${btn}
      </div>`;
    el.appendChild(div);
  });
}
function toggleSpec(i){
  document.getElementById('spec-'+i).classList.toggle('open');
}

/* ---------- Саҳифаи роҳи омӯзиш ---------- */
const LV_CLASS = {'Оғоз':1, 'Миёна':2, 'Пешрафта':3};

function buildPathHtml(spec, L){
  const C = LEARNING_COMMON;
  const prog = loadProgress()[spec.name] || {};
  const subs = spec.subs.map(s => '<span class="sub-pill">' + esc(s.name) + '</span>').join('');
  const books = L.books.map(b =>
    '<div class="book-card"><span class="lv lv-' + (LV_CLASS[b.lv] || 1) + '">' + esc(b.lv) + '</span>'
    + '<b>' + esc(b.t) + '</b><small>' + esc(b.a) + '</small><p>' + esc(b.why) + '</p></div>'
  ).join('');
  const stages = L.stages.map((s, si) => {
    const meta = STAGE_META[si];
    const topics = s.topics.map((t, ti) =>
      '<li><label><input type="checkbox" ' + (prog[si + '-' + ti] ? 'checked ' : '') + 'onchange="toggleTopic(\'' + si + '-' + ti + '\', this.checked)"><span>' + esc(t) + '</span></label></li>'
    ).join('');
    return '<div class="stage" id="stage-' + si + '">'
      + '<div class="stage-dot">' + (si + 1) + '</div>'
      + '<div class="stage-card">'
      + '<div class="stage-top"><span class="stage-pct">' + meta.p + '</span><span class="stage-time">⏱ ' + esc(s.time) + '</span><span class="stage-count" id="stage-count-' + si + '"></span></div>'
      + '<h4>' + esc(meta.title) + '</h4>'
      + '<p class="stage-goal">🎯 ' + esc(s.goal) + '</p>'
      + '<div class="pbar sm"><i id="stage-fill-' + si + '"></i></div>'
      + '<ul class="topics">' + topics + '</ul>'
      + '</div></div>';
  }).join('');
  const common = C.books.map(b =>
    '<li><b>' + esc(b.t) + '</b> <small>— ' + esc(b.a) + '</small><span>' + esc(b.why) + '</span></li>'
  ).join('');
  const links = L.links.concat(C.links).map(x => '<li>' + esc(x) + '</li>').join('');
  const tips = C.tips.map(x => '<li>' + esc(x) + '</li>').join('');

  return '<div class="back-link" onclick="closePath()">← Ба рӯйхати ихтисосҳо</div>'
    + '<div class="path-hero"><div class="path-ic">' + L.icon + '</div><div class="path-hero-text">'
    + '<h2>' + esc(spec.name) + ': аз 0 то 100</h2><p>' + esc(L.intro) + '</p><div class="subs">' + subs + '</div></div></div>'
    + '<div class="path-progress"><div class="pp-top"><b id="path-pct">0%</b><span id="path-count"></span>'
    + '<a class="reset-link" onclick="resetPath()">Аз нав оғоз кардан</a></div>'
    + '<div class="pbar"><i id="path-fill"></i></div>'
    + '<div class="path-done" id="path-done-msg" style="display:none">🎉 Табрик! Шумо ҳамаи қадамҳои ин роҳро анҷом додед. Барои таҷрибаи воқеӣ ба таҳсилоти расмӣ ва таҷрибаи клиникӣ гузаред.</div></div>'
    + '<div class="note-box">⚠️ ' + esc(C.disclaimer) + '</div>'
    + '<h3 class="path-h">📖 Китобҳои асосии ихтисос</h3><div class="books-grid">' + books + '</div>'
    + '<h3 class="path-h">🗺️ Қадамҳои омӯзиш</h3><div class="stages">' + stages + '</div>'
    + '<h3 class="path-h">🧱 Китобҳои умумии асосӣ (барои ҳамаи ихтисосҳо)</h3><ul class="common-books">' + common + '</ul>'
    + '<div class="two-col"><div class="box"><h4>🌐 Манбаъҳои ройгон</h4><ul class="plain-list">' + links + '</ul></div>'
    + '<div class="box"><h4>💡 Маслиҳатҳои омӯзиш</h4><ul class="plain-list">' + tips + '</ul></div></div>';
}

function openPath(i){
  if(!hasPaths()) return;
  const spec = LIBRARY[i], L = LEARNING[spec.name];
  if(!L) return;
  pathSpec = spec.name;
  document.getElementById('library-list').style.display = 'none';
  document.getElementById('lib-title').style.display = 'none';
  const view = document.getElementById('path-view');
  view.innerHTML = buildPathHtml(spec, L);
  view.style.display = 'block';
  updatePathProgress();
  document.querySelector('.app-body').scrollTop = 0;
}

function closePath(){
  pathSpec = null;
  document.getElementById('path-view').style.display = 'none';
  document.getElementById('library-list').style.display = '';
  document.getElementById('lib-title').style.display = '';
  renderLibrary();
  document.querySelector('.app-body').scrollTop = 0;
}

function toggleTopic(key, checked){
  if(!pathSpec) return;
  const p = loadProgress();
  p[pathSpec] = p[pathSpec] || {};
  if(checked) p[pathSpec][key] = true; else delete p[pathSpec][key];
  saveProgress(p);
  updatePathProgress();
}

function resetPath(){
  if(!pathSpec || !confirm('Пешрафти ин ихтисосро аз нав оғоз мекунед? Ҳамаи қайдҳо нест мешаванд.')) return;
  const p = loadProgress();
  delete p[pathSpec];
  saveProgress(p);
  const i = LIBRARY.findIndex(s => s.name === pathSpec);
  openPath(i);
}

function updatePathProgress(){
  if(!pathSpec) return;
  const L = LEARNING[pathSpec];
  const prog = loadProgress()[pathSpec] || {};
  let total = 0, done = 0;
  L.stages.forEach((s, si) => {
    let sd = 0;
    s.topics.forEach((t, ti) => { total++; if(prog[si + '-' + ti]){ done++; sd++; } });
    const fill = document.getElementById('stage-fill-' + si);
    if(fill) fill.style.width = (sd * 100 / s.topics.length) + '%';
    const card = document.getElementById('stage-' + si);
    if(card) card.classList.toggle('complete', sd === s.topics.length);
    const cnt = document.getElementById('stage-count-' + si);
    if(cnt) cnt.textContent = sd + '/' + s.topics.length;
  });
  const pct = total ? Math.round(done * 100 / total) : 0;
  document.getElementById('path-pct').textContent = pct + '%';
  document.getElementById('path-count').textContent = done + ' аз ' + total + ' мавзӯъ омӯхта шуд';
  document.getElementById('path-fill').style.width = pct + '%';
  document.getElementById('path-done-msg').style.display = pct === 100 ? 'block' : 'none';
}

/* ==================================================================
   PHARMACY (searchable medicine database)
================================================================== */
let pharmSpec = -1;      // -1 = ҳамаи ихтисосҳо
let pharmLimit = 40;     // чанд корт якбора нишон дода мешавад
let pharmLastQ = '';

function pharmSelect(i){ pharmSpec = i; pharmLimit = 40; renderPharmacy(); }
function pharmMore(){ pharmLimit += 40; renderPharmacy(); }

function renderPharmacy(){
  const el = document.getElementById('pharmacy-list');
  const chipsEl = document.getElementById('pharmacy-chips');
  el.dataset.loaded = '1';
  const q = (document.getElementById('pharmacy-search').value || '').trim().toLowerCase();
  if(q !== pharmLastQ){ pharmLastQ = q; pharmLimit = 40; }

  const match = m => !q || (m.n + ' ' + m.c + ' ' + m.i).toLowerCase().includes(q);
  const all = MED_SPECS.map((s,i) => ({s, i, list: s.meds.filter(match)})).filter(g => g.list.length);
  const totalMatch = all.reduce((n,g) => n + g.list.length, 0);

  // Тугмаҳои ихтисосҳо
  if(pharmSpec >= 0 && !all.some(g => g.i === pharmSpec)) pharmSpec = -1;
  chipsEl.innerHTML =
    `<button class="chip ${pharmSpec<0?'active':''}" onclick="pharmSelect(-1)">Ҳама <span>${totalMatch}</span></button>` +
    all.map(g => `<button class="chip ${pharmSpec===g.i?'active':''}" onclick="pharmSelect(${g.i})">${esc(g.s.name)} <span>${g.list.length}</span></button>`).join('');

  const groups = all.filter(g => pharmSpec < 0 || g.i === pharmSpec);
  if(groups.length === 0){
    el.innerHTML = '<div class="empty-state">Ҳеҷ дору ёфт нашуд. Калимаи дигар кӯшиш кунед (масалан номи беморӣ ё модда).</div>';
    return;
  }

  let shown = 0, html = '', more = 0;
  for(const g of groups){
    if(shown >= pharmLimit){ more += g.list.length; continue; }
    html += `<h3 class="med-group">${esc(g.s.name)} <small>${esc(g.s.desc)} · ${g.list.length}</small></h3>`;
    for(const m of g.list){
      if(shown >= pharmLimit){ more++; continue; }
      shown++;
      html += `
      <div class="med-card">
        <h3>${esc(m.n)}${m.r ? ' <span class="rx" title="Танҳо бо нусхаи духтур">Rx</span>' : ''}</h3>
        <div class="med-row"><div class="lbl">Таркиб</div><div class="val">${esc(m.c)}</div></div>
        <div class="med-row"><div class="lbl">Барои чист</div><div class="val">${esc(m.i)}</div></div>
        <div class="med-row"><div class="lbl">Кай истифода баред</div><div class="val">${esc(m.t)}</div></div>
        <div class="med-row warn"><div class="lbl">Кай истифода набаред</div><div class="val">${esc(m.x)}</div></div>
      </div>`;
    }
  }
  if(more > 0) html += `<div class="more-wrap"><button class="btn btn-outline" onclick="pharmMore()">Бештар нишон диҳед (боқӣ: ${more})</button></div>`;
  html += '<p style="font-size:.72rem;color:var(--gray);text-align:center;">Rx — доруҳои танҳо бо нусхаи духтур. Ин маълумоти умумӣ аст ва ивазкунандаи машварати духтур нест; миқдор ва мӯҳлати қабулро духтур муайян мекунад.</p>';
  el.innerHTML = html;
}

/* ==================================================================
   AI DOCTOR (Claude API + voice)
================================================================== */
let aiHistory = [];
const AI_SYSTEM_PROMPT = `Шумо "AI Духтур"-и барномаи шахсии тиббии "Фарида" ҳастед. Ҳамеша бо забони тоҷикӣ (кириллӣ), сода ва дӯстона ҷавоб диҳед.
Қоидаҳо:
1. Метавонед маълумоти умумии тиббӣ диҳед: аломатҳо, пешгирӣ, тарзи ҳаёти солим, кай бояд ба духтур муроҷиат кард.
2. ҲЕҶГОҲ ташхиси дақиқи шахсӣ нагузоред. Ҳамеша хотиррасон кунед, ки барои ташхис ва табобати воқеӣ бояд ба духтур муроҷиат кард.
3. Дар ҳолати аломатҳои ҷиддӣ (дарди шадиди дил, нафастангӣ, хунравии сахт) фавран тавсия диҳед ба ёрии таъҷилӣ занг зананд.
4. Ҷавобҳо кӯтоҳ бошанд (3-6 ҷумла).`;

function initAiChat(){
  const el = document.getElementById('ai-messages');
  el.dataset.loaded = '1';
  el.innerHTML = '<div class="bubble doc">Салом! Ман AI Духтур ҳастам. Саволи тиббии худро бинависед ё тугмаи микрофонро пахш кунед.</div>';
}

function addAiBubble(text, who){
  const el = document.getElementById('ai-messages');
  const div = document.createElement('div');
  div.className = 'bubble ' + (who==='user' ? 'me' : 'doc');
  div.textContent = text;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function showAiTyping(){
  const el = document.getElementById('ai-messages');
  const t = document.createElement('div');
  t.className='typing'; t.id='ai-typing';
  t.innerHTML='<span></span><span></span><span></span>';
  el.appendChild(t); el.scrollTop = el.scrollHeight;
}
function hideAiTyping(){ const t=document.getElementById('ai-typing'); if(t) t.remove(); }

async function sendAiMessage(){
  const input = document.getElementById('ai-input');
  const text = input.value.trim();
  if(!text) return;
  // Агар паём ба код монанд бошад (як калима), онро дар сервер месанҷем
  if(/^\S{4,64}$/.test(text)){
    const v = await api('/api/admin/verify', {code: text});
    if(v.ok && v.data && v.data.ok){
      input.value = '';
      adminCode = text;
      adminToken = v.data.token || '';
      openAdminPanel();
      return;
    }
  }
  if(!authToken){
    addAiBubble('Барои сӯҳбат бо AI Духтур аввал дар бахши «Чат» ворид шавед ё сабти ном кунед.', 'bot');
    input.value = '';
    return;
  }
  addAiBubble(text, 'user');
  aiHistory.push({role:'user', content:text});
  input.value = '';
  showAiTyping();
  const r = await call('POST', '/api/ai', {messages: aiHistory.slice(-20)});
  hideAiTyping();
  if(r.ok && r.data.reply){
    addAiBubble(r.data.reply, 'bot');
    aiHistory.push({role:'assistant', content: r.data.reply});
    speakAi(r.data.reply);
    return;
  }
  aiHistory.pop();   // паёми нофиристодашударо аз таърих мебарорем
  const err = r.data && r.data.error;
  const msgs = {
    ai_not_configured: 'AI Духтур ҳанӯз танзим нашудааст: дар сервер калиди API лозим аст (нигаред ба ai.config.example.json).',
    ai_key_invalid: 'Калиди API нодуруст аст ё иҷозат надорад. Калидро дар ai.config.json санҷед.',
    ai_model: 'Номи модел нодуруст аст. Дар ai.config.json майдони "model"-ро санҷед.',
    ai_busy: 'AI ҳоло банд аст. Як дақиқа пас бори дигар кӯшиш кунед.',
    ai_unreachable: 'Сервер ба API-и AI пайваст шуда натавонист. Интернет ё дастрасии минтақаро санҷед.',
    ai_failed: 'AI ҷавоб дода натавонист. Бори дигар кӯшиш кунед.',
    too_many: 'Паёмҳо хеле зуд-зуд фиристода шуданд. Каме интизор шавед.'
  };
  addAiBubble(msgs[err] || 'Хатогии пайвастшавӣ. Бори дигар кӯшиш кунед.', 'bot');
}

function speakAi(text){
  if(!('speechSynthesis' in window)){
    addAiBubble('⚠️ Ин браузер садодиҳиро (Text-to-Speech) дастгирӣ намекунад.', 'bot');
    return;
  }
  try{
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = 0.97;
    u.onerror = (ev) => {
      addAiBubble('⚠️ Хатои садодиҳӣ: ' + (ev.error || 'номаълум') + '. Ин метавонад маҳдудияти ин муҳити пешнамоиш бошад — файлро зеркашӣ карда, дар браузери оддӣ санҷед.', 'bot');
    };
    window.speechSynthesis.speak(u);
  }catch(err){
    addAiBubble('⚠️ Садо кор накард: ' + err.message, 'bot');
  }
}

function testVoice(){
  speakAi('Салом! Ин санҷиши садо аст. Агар шумо инро мешунавед, садодиҳӣ дуруст кор мекунад.');
}

let aiRecognition = null, aiListening = false;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
if(SR){
  aiRecognition = new SR();
  aiRecognition.lang = 'ru-RU';
  aiRecognition.onresult = e => { document.getElementById('ai-input').value = e.results[0][0].transcript; sendAiMessage(); };
  aiRecognition.onend = () => { aiListening=false; document.getElementById('ai-mic-btn').classList.remove('listening'); };
  aiRecognition.onerror = (ev) => {
    aiListening=false; document.getElementById('ai-mic-btn').classList.remove('listening');
    let msg = 'Хатои микрофон: ' + ev.error;
    if(ev.error === 'not-allowed' || ev.error === 'service-not-allowed'){
      msg = '⚠️ Дастрасӣ ба микрофон радд шуд. Дар ин пешнамоиши чат ё дар файли кушодашуда бо file://, браузерҳо микрофонро иҷозат намедиҳанд — танҳо дар сомонаи https:// ё localhost кор мекунад. Файлро дар сервери воқеӣ ҷойгир кунед то микрофон кор кунад.';
    } else if(ev.error === 'no-speech'){
      msg = 'Ҳеҷ садое шунида нашуд. Бори дигар кӯшиш кунед.';
    }
    addAiBubble(msg, 'bot');
  };
}
function toggleAiMic(){
  if(!aiRecognition){ addAiBubble('⚠️ Браузери шумо шинохти овозро дастгирӣ намекунад.', 'bot'); return; }
  const btn = document.getElementById('ai-mic-btn');
  if(aiListening){ aiRecognition.stop(); aiListening=false; btn.classList.remove('listening'); }
  else{
    try{
      aiRecognition.start(); aiListening=true; btn.classList.add('listening');
    }catch(err){
      addAiBubble('⚠️ Микрофонро оғоз карда натавонист: ' + err.message, 'bot');
    }
  }
}

/* ==================================================================
   INIT
================================================================== */
restoreSession();
