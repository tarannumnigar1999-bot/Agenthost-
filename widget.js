(function () {
  const scriptTag = document.currentScript;
  const agentId = scriptTag.getAttribute('data-agent');
  if (!agentId) { console.error('AgentHost widget: missing data-agent attribute'); return; }

  const API_URL = 'https://myagenthost.app/api/widget-chat';

  const ACCENT = '#00f5a0';
  const BG = '#0d1018';
  const CARD = '#101520';
  const BORDER = '#222840';
  const TEXT = '#dde2f0';
  const MUTED = '#6a7490';

  let isOpen = false;
  let history = [];
  let sending = false;

  const container = document.createElement('div');
  container.id = 'agenthost-widget-container';
  container.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;';
  document.body.appendChild(container);

  const bubble = document.createElement('button');
  bubble.id = 'agenthost-widget-bubble';
  bubble.innerHTML = '&#128172;';
  bubble.style.cssText = `
    width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;
    background:${ACCENT};color:#000;font-size:26px;
    box-shadow:0 8px 24px rgba(0,245,160,.35);
    display:flex;align-items:center;justify-content:center;
    transition:transform .2s ease;
  `;
  bubble.onmouseenter = () => { bubble.style.transform = 'scale(1.08)'; };
  bubble.onmouseleave = () => { bubble.style.transform = 'scale(1)'; };
  container.appendChild(bubble);

  const panel = document.createElement('div');
  panel.id = 'agenthost-widget-panel';
  panel.style.cssText = `
    display:none;flex-direction:column;
    position:fixed;bottom:92px;right:20px;
    width:340px;max-width:90vw;height:460px;max-height:70vh;
    background:${BG};border:1px solid ${BORDER};border-radius:16px;
    box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;
  `;
  container.appendChild(panel);

  panel.innerHTML = `
    <div style="padding:16px 18px;border-bottom:1px solid ${BORDER};background:${CARD};display:flex;align-items:center;justify-content:space-between;">
      <div style="color:${TEXT};font-weight:700;font-size:14px;">Chat with us</div>
      <button id="agenthost-widget-close" style="background:none;border:none;color:${MUTED};font-size:18px;cursor:pointer;">&times;</button>
    </div>
    <div id="agenthost-widget-msgs" style="flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;"></div>
    <div style="padding:12px;border-top:1px solid ${BORDER};display:flex;gap:8px;background:${CARD};">
      <input id="agenthost-widget-input" type="text" placeholder="Type a message..." style="flex:1;background:${BG};border:1px solid ${BORDER};border-radius:8px;padding:10px 12px;color:${TEXT};font-size:13px;outline:none;"/>
      <button id="agenthost-widget-send" style="background:${ACCENT};color:#000;border:none;border-radius:8px;padding:0 16px;font-weight:700;font-size:13px;cursor:pointer;">Send</button>
    </div>
  `;

  const msgsEl = panel.querySelector('#agenthost-widget-msgs');
  const inputEl = panel.querySelector('#agenthost-widget-input');
  const sendBtn = panel.querySelector('#agenthost-widget-send');
  const closeBtn = panel.querySelector('#agenthost-widget-close');

  function addMsg(text, fromUser) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;' + (fromUser ? 'justify-content:flex-end' : '');
    const bubbleEl = document.createElement('div');
    bubbleEl.style.cssText = `
      max-width:80%;padding:10px 14px;border-radius:12px;font-size:13px;line-height:1.5;
      background:${fromUser ? 'rgba(0,245,160,.12)' : CARD};
      border:1px solid ${fromUser ? 'rgba(0,245,160,.25)' : BORDER};
      color:${TEXT};white-space:pre-wrap;word-break:break-word;
    `;
    bubbleEl.textContent = text;
    row.appendChild(bubbleEl);
    msgsEl.appendChild(row);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  addMsg("Hi! How can I help you today?", false);

  function toggle() {
    isOpen = !isOpen;
    panel.style.display = isOpen ? 'flex' : 'none';
    bubble.innerHTML = isOpen ? '&times;' : '&#128172;';
    if (isOpen) inputEl.focus();
  }
  bubble.onclick = toggle;
  closeBtn.onclick = toggle;

  async function send() {
    const text = inputEl.value.trim();
    if (!text || sending) return;
    sending = true;
    inputEl.value = '';
    addMsg(text, true);

    const typingRow = document.createElement('div');
    typingRow.id = 'agenthost-widget-typing';
    typingRow.style.cssText = 'display:flex;';
    typingRow.innerHTML = `<div style="padding:10px 14px;border-radius:12px;background:${CARD};border:1px solid ${BORDER};color:${MUTED};font-size:13px;">...</div>`;
    msgsEl.appendChild(typingRow);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, message: text, history: history }),
      });
      const data = await res.json();
      const typingEl = document.getElementById('agenthost-widget-typing');
      if (typingEl) typingEl.remove();
      if (!res.ok || data.error) {
        addMsg(data.error || "Sorry, something went wrong. Please try again.", false);
      } else {
        addMsg(data.reply, false);
        history.push({ role: 'user', content: text }, { role: 'assistant', content: data.reply });
      }
    } catch (e) {
      const typingEl = document.getElementById('agenthost-widget-typing');
      if (typingEl) typingEl.remove();
      addMsg("Connection error. Please try again.", false);
    }
    sending = false;
  }

  sendBtn.onclick = send;
  inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
})();

