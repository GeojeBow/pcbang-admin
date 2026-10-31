// PC방 관리자 웹앱 (PC / 핸드폰 공용)
// Supabase 라이브러리는 vendor/ 폴더에 함께 들어 있다 (index.html에서 먼저 불러옴)
const { createClient } = window.supabase;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = (n) => (n || 0).toLocaleString('ko-KR') + '원';
const hm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- 상태 ----------
const S = {
  seats: new Map(),     // id -> seat row + { _at: 받은 시각 }
  thumbs: new Map(),    // id -> dataURL
  orders: [],
  messages: new Map(),  // seatId -> [rows]
  menu: [],
  pending: new Map(),   // seatId -> [commands 미실행]
  openSeat: null,
  openChat: null,
};
let sb = null;
let control = null;

const isOnline = (s) => s.online && Date.now() - new Date(s.last_seen).getTime() < 45_000;
function remainingOf(s) {
  if (s.mode !== 'timed') return null;
  const elapsed = isOnline(s) && !s.locked ? Math.floor((Date.now() - s._at) / 1000) : 0;
  return Math.max(0, s.remaining_sec - elapsed);
}
function statusOf(s) {
  if (!isOnline(s)) return { cls: 'off', label: '꺼짐' };
  if (s.locked) return { cls: 'lock', label: '잠김' };
  return { cls: 'use', label: s.mode === 'free' ? '자유 이용' : '사용 중' };
}

// ---------- 로그인 ----------
function getCfg() { return { url: store.get('pcb_url') || '', key: store.get('pcb_key') || '' }; }

function showLogin(err = '') {
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  const c = getCfg();
  $('#cfgFields').classList.toggle('hidden', !!(c.url && c.key));
  $('#editCfg').classList.toggle('hidden', !(c.url && c.key));
  $('#cfgUrl').value = c.url; $('#cfgKey').value = c.key;
  $('#loginErr').textContent = err;
}
$('#editCfg').onclick = () => { $('#cfgFields').classList.remove('hidden'); $('#editCfg').classList.add('hidden'); };

$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const url = $('#cfgUrl').value.trim().replace(/\/(rest|auth|realtime)\/v1.*$/, '').replace(/\/+$/, '');
  const key = $('#cfgKey').value.trim();
  if (!/^https?:\/\/.+/.test(url) || !key) { $('#loginErr').textContent = 'Supabase 주소와 공개 키를 입력하세요.'; $('#cfgFields').classList.remove('hidden'); return; }
  $('#loginBtn').disabled = true; $('#loginErr').textContent = '';
  try {
    if (url !== getCfg().url || key !== getCfg().key || !sb) {
      store.set('pcb_url', url); store.set('pcb_key', key);
      sb = createClient(url, key);
    }
    const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#password').value });
    if (error) throw new Error(error.message === 'Invalid login credentials' ? '이메일 또는 비밀번호가 틀렸습니다.' : error.message);
    await enter();
    // 안드로이드 앱이면 앱을 닫아도 알림을 받도록 앱에도 로그인시킨다 (비밀번호는 앱에 저장되지 않음)
    if (inApp) { window.PCBangApp.login(url, key, $('#email').value.trim(), $('#password').value); setTimeout(updateNotifyBtn, 4000); }
  } catch (err) {
    $('#loginErr').textContent = String(err.message || err);
  } finally { $('#loginBtn').disabled = false; }
};

$('#logout').onclick = async () => {
  if (!confirm('로그아웃할까요?')) return;
  await sb.removeAllChannels();
  await sb.auth.signOut();
  window.PCBangApp?.logout();
  showLogin();
};

async function enter() {
  const { data: role, error } = await sb.rpc('my_role');
  if (error) throw new Error('설정 확인 실패: ' + error.message + ' (SQL 설정을 실행했는지 확인하세요)');
  if (role !== 'admin') { await sb.auth.signOut(); throw new Error('이 계정은 관리자(admin) 역할이 아닙니다.'); }
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  await loadAll();
  await subscribe();
  renderAll();
}

// ---------- 데이터 ----------
async function loadAll() {
  const since = new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString();
  const [seats, orders, msgs, menu, cmds] = await Promise.all([
    sb.from('seats').select('*'),
    sb.from('orders').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(200),
    sb.from('messages').select('*').gte('created_at', since).order('created_at').limit(1000),
    sb.from('menu').select('*').order('sort').order('id'),
    sb.from('commands').select('*').eq('done', false).order('id'),
  ]);
  const now = Date.now();
  S.seats = new Map((seats.data || []).map((s) => [s.id, { ...s, _at: now }]));
  S.orders = orders.data || [];
  S.messages = new Map();
  for (const m of msgs.data || []) pushMsg(m);
  S.menu = menu.data || [];
  S.pending = new Map();
  for (const c of cmds.data || []) addPending(c);
}
function pushMsg(m) {
  const list = S.messages.get(m.seat_id) || [];
  if (list.some((x) => x.id === m.id)) return false;
  list.push(m); S.messages.set(m.seat_id, list.slice(-200));
  return true;
}
function addPending(c) { const l = S.pending.get(c.seat_id) || []; if (!l.some((x) => x.id === c.id)) l.push(c); S.pending.set(c.seat_id, l); }
function removePending(c) { const l = (S.pending.get(c.seat_id) || []).filter((x) => x.id !== c.id); S.pending.set(c.seat_id, l); }

async function subscribe() {
  await sb.removeAllChannels();
  sb.channel('admin-db')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'seats' }, (p) => {
      if (p.eventType === 'DELETE') S.seats.delete(p.old.id);
      else {
        const before = S.seats.get(p.new.id);
        S.seats.set(p.new.id, { ...p.new, _at: Date.now() });
        if (before && !before.locked && p.new.locked && p.new.mode === 'timed' && p.new.remaining_sec === 0) {
          alertUser('timeout', `${p.new.name} 사용 시간이 끝나 잠겼습니다.`, p.new.id);
        }
      }
      renderSeats(); renderModal();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' }, (p) => {
      if (S.orders.some((o) => o.id === p.new.id)) return;
      S.orders.unshift(p.new);
      alertUser('order', `${p.new.seat_name} 주문: ${p.new.items.map((i) => `${i.name}×${i.qty}`).join(', ')}`, null, () => showTab('orders'));
      renderOrders();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' }, (p) => {
      const i = S.orders.findIndex((o) => o.id === p.new.id);
      if (i >= 0) S.orders[i] = p.new; renderOrders();
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => {
      if (!pushMsg(p.new)) return;
      const seat = S.seats.get(p.new.seat_id);
      if (p.new.sender === 'guest') {
        const viewing = S.openSeat === p.new.seat_id || S.openChat === p.new.seat_id;
        if (viewing && !document.hidden) markRead(p.new.seat_id);
        if (p.new.kind === 'call') alertUser('call', `🔔 ${seat?.name || 'PC'}에서 카운터를 호출했습니다.`, p.new.seat_id);
        else alertUser('chat', `💬 ${seat?.name || 'PC'}: ${p.new.text}`, p.new.seat_id, () => openChat(p.new.seat_id));
      }
      renderChats(); renderModal(); renderSeats();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, (p) => {
      const l = S.messages.get(p.new.seat_id) || [];
      const i = l.findIndex((m) => m.id === p.new.id); if (i >= 0) l[i] = p.new;
      renderChats(); renderSeats();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'menu' }, async () => {
      const { data } = await sb.from('menu').select('*').order('sort').order('id');
      S.menu = data || []; renderMenu();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'commands' }, (p) => {
      if (p.eventType === 'DELETE') return;
      if (p.new.done) removePending(p.new); else addPending(p.new);
      renderModal();
    })
    .subscribe((status) => setConn(status === 'SUBSCRIBED'));

  // 화면 전송 채널 (비공개). 관리자가 접속해 있다는 신호(presence)를 보내야 손님 PC가 화면을 보낸다.
  control = sb.channel('pcbang-control', { config: { private: true, broadcast: { self: false }, presence: { key: 'admin:' + crypto.randomUUID() } } })
    .on('broadcast', { event: 'thumb' }, ({ payload }) => {
      if (!payload?.seatId) return;
      S.thumbs.set(payload.seatId, payload.img);
      const img = document.querySelector(`[data-thumb="${payload.seatId}"]`);
      if (img) img.src = payload.img; else renderSeats();
    })
    .on('broadcast', { event: 'frame' }, ({ payload }) => {
      if (payload?.seatId !== S.openSeat) return;
      $('#mFrame').src = payload.img; $('#mLiveMsg').textContent = '';
    })
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') await control.track({ role: 'admin', at: Date.now() });
    });
}

function setConn(ok) {
  $('#conn').className = 'conn ' + (ok ? 'ok' : 'bad');
  $('#conn').textContent = ok ? '실시간' : '연결 중';
}

// 앱을 다시 열었을 때 최신 상태로
document.addEventListener('visibilitychange', async () => {
  if (document.hidden || !sb || $('#app').classList.contains('hidden')) return;
  await loadAll(); renderAll();
  if (S.openSeat) markRead(S.openSeat);
});

// ---------- 명령 ----------
async function command(seatId, cmd, arg = null) {
  const { error } = await sb.from('commands').insert({ seat_id: seatId, cmd, arg: arg == null ? null : String(arg) });
  if (error) { toast('명령 실패: ' + error.message, 'timeout'); return false; }
  const s = S.seats.get(seatId);
  if (s && !isOnline(s)) toast(`${s.name}이(가) 꺼져 있어 켜지면 실행됩니다.`);
  return true;
}
async function markRead(seatId) {
  const unread = (S.messages.get(seatId) || []).filter((m) => m.sender === 'guest' && !m.read);
  if (!unread.length) return;
  unread.forEach((m) => (m.read = true));
  renderSeats(); renderChats();
  await sb.from('messages').update({ read: true }).eq('seat_id', seatId).eq('sender', 'guest').eq('read', false);
}
const unreadOf = (seatId) => (S.messages.get(seatId) || []).filter((m) => m.sender === 'guest' && !m.read).length;

// ---------- 화면 ----------
function showTab(t) {
  $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + t));
}
$$('#tabs button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

function sortedSeats() {
  return [...S.seats.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
}

function renderAll() { renderSeats(); renderOrders(); renderChats(); renderMenu(); }

function renderSeats() {
  const seats = sortedSeats();
  $('#noSeats').classList.toggle('hidden', seats.length > 0);
  const on = seats.filter(isOnline).length, use = seats.filter((s) => isOnline(s) && !s.locked).length;
  $('#summary').textContent = `전체 ${seats.length}대 · 켜짐 ${on} · 사용 중 ${use}`;
  $('#seats').innerHTML = seats.map((s) => {
    const st = statusOf(s), rem = remainingOf(s), thumb = S.thumbs.get(s.id), un = unreadOf(s.id);
    return `<button class="seat ${st.cls === 'off' ? 'off' : ''}" data-seat="${s.id}">
      <div class="thumb">${thumb && isOnline(s) ? `<img data-thumb="${s.id}" src="${thumb}" alt="">` : `<span>${isOnline(s) ? '화면 대기 중' : '꺼짐'}</span>`}
        ${isOnline(s) && s.locked ? '<span class="lockico">🔒</span>' : ''}</div>
      <div class="info">
        <div class="name"><span>${esc(s.name)} ${un ? `<b class="badge">${un}</b>` : ''}</span><span class="pill ${st.cls}">${st.label}</span></div>
        <div class="time ${rem != null && rem <= 300 && !s.locked ? 'low' : ''}" data-time="${s.id}">${rem == null ? '자유 이용' : fmtTime(rem)}</div>
      </div></button>`;
  }).join('');
  $$('[data-seat]').forEach((b) => (b.onclick = () => openSeat(b.dataset.seat)));
  const totalUnread = seats.reduce((a, s) => a + unreadOf(s.id), 0);
  $('#chatBadge').textContent = totalUnread || '';
}

// 1초마다 남은 시간만 갱신
setInterval(() => {
  for (const el of $$('[data-time]')) {
    const s = S.seats.get(el.dataset.time); if (!s) continue;
    const rem = remainingOf(s);
    el.textContent = rem == null ? '자유 이용' : fmtTime(rem);
  }
  if (S.openSeat) {
    const s = S.seats.get(S.openSeat);
    if (s) { const rem = remainingOf(s); $('#mRemain').textContent = rem == null ? '자유 이용' : fmtTime(rem); }
  }
}, 1000);
// 켜짐/꺼짐 판정 갱신
setInterval(() => { if (!$('#app').classList.contains('hidden')) renderSeats(); }, 15000);

$('#lockAll').onclick = async () => {
  const targets = sortedSeats().filter((s) => isOnline(s) && !s.locked);
  if (!targets.length) return toast('사용 중인 PC가 없습니다.');
  if (!confirm(`사용 중인 ${targets.length}대를 모두 잠글까요?`)) return;
  await sb.from('commands').insert(targets.map((s) => ({ seat_id: s.id, cmd: 'lock' })));
};

// ---------- 좌석 상세 ----------
let watchTimer = null;
function openSeat(id) {
  S.openSeat = id;
  $('#mFrame').removeAttribute('src');
  $('#mLiveMsg').textContent = '화면 불러오는 중…';
  $('#seatModal').classList.remove('hidden');
  renderModal();
  markRead(id);
  const ping = () => control?.send({ type: 'broadcast', event: 'watch', payload: { seatId: id } });
  ping(); clearInterval(watchTimer); watchTimer = setInterval(ping, 4000);
}
function closeSeat() {
  S.openSeat = null; clearInterval(watchTimer);
  $('#seatModal').classList.add('hidden');
}
$('#mClose').onclick = closeSeat;
$('#seatModal').onclick = (e) => { if (e.target.id === 'seatModal') closeSeat(); };

function renderModal() {
  const id = S.openSeat; if (!id) return;
  const s = S.seats.get(id);
  if (!s) { closeSeat(); return; }
  const st = statusOf(s);
  $('#mName').textContent = s.name;
  $('#mStatus').className = 'pill ' + st.cls; $('#mStatus').textContent = st.label;
  if (!isOnline(s)) { $('#mFrame').removeAttribute('src'); $('#mLiveMsg').textContent = 'PC가 꺼져 있습니다'; }
  const rem = remainingOf(s);
  $('#mRemain').textContent = rem == null ? '자유 이용' : fmtTime(rem);
  const pend = S.pending.get(id) || [];
  $('#mPending').classList.toggle('hidden', !pend.length);
  $('#mPending').textContent = pend.length ? `PC가 켜지면 실행될 명령 ${pend.length}개가 대기 중입니다.` : '';
  $('#mDelete').disabled = isOnline(s);
  renderChatBox($('#mChat'), id);
}

$$('[data-add]').forEach((b) => (b.onclick = () => command(S.openSeat, 'addTime', b.dataset.add)));
// 시간 조정: 버튼으로 양을 맞추고 충전/빼기 (핸드폰에서 마이너스를 입력할 필요 없음)
let adjMin = 30;
const fmtMin = (m) => [m >= 60 ? `${Math.floor(m / 60)}시간` : '', m % 60 ? `${m % 60}분` : ''].filter(Boolean).join(' ') || '0분';
function renderAdj() {
  const t = fmtMin(adjMin).trim();
  $('#mAdjVal').textContent = t;
  $('#mAdjAdd').textContent = `＋ ${t} 충전`;
  $('#mAdjSub').textContent = `－ ${t} 빼기`;
}
$$('[data-step]').forEach((b) => (b.onclick = () => { adjMin = Math.min(1440, Math.max(10, adjMin + Number(b.dataset.step))); renderAdj(); }));
$('#mAdjVal').onclick = () => {
  const v = parseInt(prompt('몇 분인지 숫자로 입력하세요 (예: 45)', String(adjMin)), 10);
  if (v > 0) { adjMin = Math.min(1440, v); renderAdj(); }
};
$('#mAdjAdd').onclick = () => command(S.openSeat, 'addTime', adjMin);
$('#mAdjSub').onclick = () => {
  const s = S.seats.get(S.openSeat);
  if (confirm(`${s.name}에서 ${fmtMin(adjMin).trim()}을 뺄까요?`)) command(S.openSeat, 'addTime', -adjMin);
};
renderAdj();
$('#mFree').onclick = () => command(S.openSeat, 'setFree');
$$('[data-cmd]').forEach((b) => (b.onclick = () => {
  const cmd = b.dataset.cmd;
  const s = S.seats.get(S.openSeat);
  const ask = { shutdown: `${s.name}을(를) 끌까요?`, restart: `${s.name}을(를) 다시 시작할까요?`, endSession: `${s.name} 사용을 종료할까요? 남은 시간이 0이 됩니다.` }[cmd];
  if (ask && !confirm(ask)) return;
  command(S.openSeat, cmd);
}));
$('#mSendNotice').onclick = () => {
  const t = $('#mNotice').value.trim(); if (!t) return;
  command(S.openSeat, 'notice', t); $('#mNotice').value = '';
};
$('#mRenameBtn').onclick = async () => {
  const name = $('#mRename').value.trim(); if (!name) return;
  const { error } = await sb.from('seats').update({ name }).eq('id', S.openSeat);
  if (error) toast(error.message); else $('#mRename').value = '';
};
$('#mDelete').onclick = async () => {
  const s = S.seats.get(S.openSeat);
  if (!confirm(`${s.name}을(를) 목록에서 삭제할까요? 채팅/주문 기록도 지워집니다.`)) return;
  const { error } = await sb.from('seats').delete().eq('id', s.id);
  if (error) return toast(error.message);
  S.seats.delete(s.id); closeSeat(); renderSeats();
};

// ---------- 채팅 ----------
function renderChatBox(el, seatId) {
  const msgs = S.messages.get(seatId) || [];
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = msgs.map((m) => m.kind === 'call'
    ? `<div class="msg call">🔔 카운터 호출 · ${hm(m.created_at)}</div>`
    : `<div class="msg ${m.sender}">${esc(m.text)}<small>${hm(m.created_at)}</small></div>`).join('')
    || '<div style="color:var(--muted);text-align:center;margin-top:30px;font-size:14px">대화가 없습니다</div>';
  if (atBottom || el.dataset.seat !== seatId) el.scrollTop = el.scrollHeight;
  el.dataset.seat = seatId;
}
async function sendChat(seatId, input) {
  const text = input.value.trim(); if (!text) return;
  input.value = '';
  const { data, error } = await sb.from('messages').insert({ seat_id: seatId, sender: 'admin', text }).select().single();
  if (error) return toast('전송 실패: ' + error.message);
  pushMsg(data); renderModal(); renderChats();
}
$('#mChatForm').onsubmit = (e) => { e.preventDefault(); sendChat(S.openSeat, $('#mChatText')); };
$('#cChatForm').onsubmit = (e) => { e.preventDefault(); sendChat(S.openChat, $('#cChatText')); };

function openChat(id) {
  S.openChat = id;
  $('#cName').textContent = (S.seats.get(id)?.name || 'PC') + ' 채팅';
  $('#chatModal').classList.remove('hidden');
  renderChatBox($('#cChat'), id);
  markRead(id);
}
$('#cClose').onclick = () => { S.openChat = null; $('#chatModal').classList.add('hidden'); };
$('#chatModal').onclick = (e) => { if (e.target.id === 'chatModal') $('#cClose').onclick(); };

function renderChats() {
  const seats = sortedSeats().map((s) => ({ s, last: (S.messages.get(s.id) || []).at(-1), un: unreadOf(s.id) }))
    .sort((a, b) => (b.last ? new Date(b.last.created_at) : 0) - (a.last ? new Date(a.last.created_at) : 0));
  $('#chatList').innerHTML = seats.map(({ s, last, un }) => `
    <button class="row" data-chat="${s.id}" style="text-align:left">
      <div class="grow"><b>${esc(s.name)}</b> ${un ? `<b class="badge">${un}</b>` : ''}
        <div class="meta">${last ? esc(last.kind === 'call' ? '🔔 카운터 호출' : (last.sender === 'admin' ? '나: ' : '') + last.text) : '대화 없음'}</div></div>
      <span class="meta">${last ? hm(last.created_at) : ''}</span>
    </button>`).join('') || '<p class="empty">손님 PC가 없습니다.</p>';
  $$('[data-chat]').forEach((b) => (b.onclick = () => openChat(b.dataset.chat)));
  if (S.openChat) renderChatBox($('#cChat'), S.openChat);
}

// ---------- 주문 ----------
const statusLabel = { new: '새 주문', making: '준비 중', done: '완료', canceled: '취소' };
$('#showDone').onchange = renderOrders;
function renderOrders() {
  const showDone = $('#showDone').checked;
  const list = S.orders.filter((o) => showDone || o.status === 'new' || o.status === 'making');
  const newCount = S.orders.filter((o) => o.status === 'new').length;
  $('#orderBadge').textContent = newCount || '';
  const today = S.orders.filter((o) => o.status === 'done' && new Date(o.created_at).toDateString() === new Date().toDateString());
  $('#orderSummary').textContent = `오늘 완료 ${today.length}건 · ${won(today.reduce((a, o) => a + o.total, 0))}`;
  $('#orders').innerHTML = list.map((o) => `
    <div class="row ${o.status === 'new' ? 'new' : ''}">
      <div class="grow">
        <b>${esc(o.seat_name)}</b> <span class="st ${o.status}">${statusLabel[o.status]}</span>
        <div>${esc(o.items.map((i) => `${i.name} × ${i.qty}`).join(', '))}</div>
        ${o.note ? `<div class="meta">요청: ${esc(o.note)}</div>` : ''}
        <div class="meta">${hm(o.created_at)} · ${won(o.total)}</div>
      </div>
      <div class="acts">
        ${o.status === 'new' ? `<button class="btn small" data-o="${o.id}" data-s="making">준비 시작</button>` : ''}
        ${o.status === 'new' || o.status === 'making' ? `<button class="btn small primary" data-o="${o.id}" data-s="done">완료</button><button class="btn small danger" data-o="${o.id}" data-s="canceled">취소</button>` : ''}
      </div>
    </div>`).join('') || '<p class="empty">처리할 주문이 없습니다.</p>';
  $$('[data-o]').forEach((b) => (b.onclick = async () => {
    const { error } = await sb.from('orders').update({ status: b.dataset.s }).eq('id', b.dataset.o);
    if (error) toast(error.message);
  }));
}

// ---------- 메뉴 ----------
// 메뉴 이름으로 어울리는 그림과 색을 고른다 (사진이 없을 때)
const MENU_ART = [
  [/라면|라멘|우동|국수|짬뽕/, '🍜', ['#fde68a', '#f97316']],
  [/콜라|사이다|탄산|환타|펩시/, '🥤', ['#fecaca', '#dc2626']],
  [/커피|아메리카노|라떼|카페/, '☕', ['#e7d3c1', '#92400e']],
  [/주스|에이드|스무디/, '🧃', ['#fef08a', '#65a30d']],
  [/물|생수/, '💧', ['#bae6fd', '#0284c7']],
  [/과자|스낵|칩/, '🍪', ['#fde68a', '#b45309']],
  [/핫도그|소시지/, '🌭', ['#fed7aa', '#c2410c']],
  [/햄버거|버거/, '🍔', ['#fde68a', '#a16207']],
  [/피자/, '🍕', ['#fecaca', '#ea580c']],
  [/치킨|닭/, '🍗', ['#fed7aa', '#b45309']],
  [/감자|튀김|프라이/, '🍟', ['#fef08a', '#dc2626']],
  [/밥|덮밥|볶음밥|김밥/, '🍚', ['#e2e8f0', '#475569']],
  [/떡볶이/, '🌶️', ['#fecaca', '#b91c1c']],
  [/만두/, '🥟', ['#f5f5f4', '#78716c']],
  [/아이스티|티$|녹차|홍차|밀크티/, '🧋', ['#fef3c7', '#b45309']],
  [/아이스크림|빙수|콘$/, '🍦', ['#e0f2fe', '#7c3aed']],
  [/초코|초콜릿/, '🍫', ['#e7d3c1', '#78350f']],
  [/빵|샌드위치|토스트/, '🥪', ['#fef3c7', '#a16207']],
  [/에너지|핫식스|레드불|몬스터/, '⚡', ['#d9f99d', '#15803d']],
  [/맥주|음료/, '🥤', ['#ddd6fe', '#6d28d9']],
];
function menuArt(name) {
  for (const [re, emoji, colors] of MENU_ART) if (re.test(name || '')) return { emoji, colors };
  return { emoji: '🍽️', colors: ['#e0e7ff', '#4f46e5'] };
}
function menuPic(m) {
  if (m.image && /^data:image\//.test(m.image)) return `<img src="${m.image}" alt="">`;
  const a = menuArt(m.name);
  return `<span style="background:linear-gradient(135deg, ${a.colors[0]}, ${a.colors[1]})">${a.emoji}</span>`;
}
// 사진을 정사각형 400px JPEG로 줄여서 메뉴에 바로 저장한다 (약 30~60KB)
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const size = 400, c = document.createElement('canvas');
      c.width = c.height = size;
      const r = Math.max(size / img.width, size / img.height);
      const w = img.width * r, h = img.height * r;
      c.getContext('2d').drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    img.src = URL.createObjectURL(file);
  });
}
async function saveMenuImage(id, image) {
  const { error } = await sb.from('menu').update({ image }).eq('id', id);
  if (error) return toast(/image/.test(error.message) ? '사진 기능을 쓰려면 Supabase에서 SQL 한 줄을 먼저 실행해야 합니다. (설치 안내 참고)' : error.message);
  const m = S.menu.find((x) => String(x.id) === String(id));
  if (m) { m.image = image; renderMenu(); }
  toast(image ? '사진을 저장했습니다.' : '사진을 지웠습니다.');
}
function renderMenu() {
  $('#menuList').innerHTML = S.menu.map((m) => `
    <div class="row" data-m="${m.id}">
      <label class="mpic" title="사진 바꾸기">${menuPic(m)}<input type="file" accept="image/*" data-img="${m.id}" hidden></label>
      <div class="grow"><input value="${esc(m.name)}" data-f="name" maxlength="40"></div>
      <input class="price" type="number" min="0" step="100" value="${m.price}" data-f="price">
      <label class="chk"><input type="checkbox" data-f="sold_out" ${m.sold_out ? 'checked' : ''}> 품절</label>
      ${m.image ? `<button class="btn small" data-noimg="${m.id}">사진 지우기</button>` : ''}
      <button class="btn small danger" data-del="${m.id}">삭제</button>
    </div>`).join('') || '<p class="empty">메뉴가 없습니다.</p>';
  $$('[data-img]').forEach((inp) => (inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    try { await saveMenuImage(inp.dataset.img, await shrinkImage(f)); } catch (e) { toast(e.message); }
  }));
  $$('[data-noimg]').forEach((b) => (b.onclick = () => saveMenuImage(b.dataset.noimg, null)));
  $$('[data-m] [data-f]').forEach((inp) => (inp.onchange = async () => {
    const id = inp.closest('[data-m]').dataset.m, f = inp.dataset.f;
    const v = f === 'sold_out' ? inp.checked : f === 'price' ? Math.max(0, parseInt(inp.value, 10) || 0) : inp.value.trim();
    if (f === 'name' && !v) return renderMenu();
    const { error } = await sb.from('menu').update({ [f]: v }).eq('id', id);
    toast(error ? error.message : '저장했습니다.');
  }));
  $$('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('이 메뉴를 삭제할까요?')) return;
    const { error } = await sb.from('menu').delete().eq('id', b.dataset.del);
    if (error) toast(error.message);
  }));
}
$('#addMenu').onclick = async () => {
  const name = prompt('메뉴 이름'); if (!name?.trim()) return;
  const price = parseInt(prompt('가격 (원)', '1000'), 10) || 0;
  const sort = Math.max(0, ...S.menu.map((m) => m.sort)) + 1;
  const { error } = await sb.from('menu').insert({ name: name.trim().slice(0, 40), price, sort });
  if (error) toast(error.message);
};

// ---------- 알림 ----------
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const tones = kind === 'order' ? [880, 1175] : kind === 'call' ? [988, 740, 988] : [660];
    tones.forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.3, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.start(t); o.stop(t + 0.17);
    });
  } catch {}
}
document.addEventListener('pointerdown', () => { try { audioCtx ||= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume(); } catch {} }, { once: true });

function toast(text, kind = '', onClick) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind ? ' t-' + kind : ''); el.textContent = text;
  el.onclick = () => { el.remove(); onClick?.(); };
  $('#toasts').prepend(el);
  setTimeout(() => el.remove(), kind ? 8000 : 3500);
}
async function alertUser(kind, text, seatId, onClick) {
  toast(text, kind, onClick || (seatId ? () => openSeat(seatId) : undefined));
  beep(kind);
  navigator.vibrate?.(kind === 'call' ? [200, 100, 200] : 200);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.showNotification('PC방 관리자', { body: text, icon: 'icons/icon-192.png', tag: kind + (seatId || ''), renotify: true });
      else new Notification('PC방 관리자', { body: text });
    } catch {}
  }
}
const inApp = !!window.PCBangApp;
function updateNotifyBtn() {
  if (inApp) {
    const on = window.PCBangApp.hasAlerts();
    $('#notifyBtn').textContent = on ? '🔔' : '🔕';
    $('#notifyBtn').title = on ? '앱 알림 켜짐 (알림 설정 열기)' : '앱 알림 꺼짐';
    return;
  }
  const on = 'Notification' in window && Notification.permission === 'granted';
  $('#notifyBtn').textContent = on ? '🔔' : '🔕';
  $('#notifyBtn').title = on ? '알림 켜짐' : '알림 켜기';
}
$('#notifyBtn').onclick = async () => {
  if (inApp) {
    if (window.PCBangApp.hasAlerts()) return window.PCBangApp.openNotificationSettings();
    return toast('앱 알림을 켜려면 로그아웃(⎋) 후 다시 로그인해 주세요.', 'call');
  }
  if (!('Notification' in window)) return toast('이 브라우저는 알림을 지원하지 않습니다. 핸드폰에서는 홈 화면에 추가한 뒤 사용하세요.');
  const p = await Notification.requestPermission();
  updateNotifyBtn();
  toast(p === 'granted' ? '알림을 켰습니다.' : '알림이 허용되지 않았습니다.');
};

// ---------- 시작 ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
updateNotifyBtn();
(async () => {
  const c = getCfg();
  if (!c.url || !c.key) return showLogin();
  sb = createClient(c.url, c.key);
  const { data } = await sb.auth.getSession();
  if (!data.session) return showLogin();
  try { await enter(); } catch (e) { return showLogin(String(e.message || e)); }
  if (inApp && !window.PCBangApp.hasAlerts()) toast('앱을 닫아도 알림을 받으려면 로그아웃(⎋) 후 다시 로그인해 주세요.', 'call');
})();
