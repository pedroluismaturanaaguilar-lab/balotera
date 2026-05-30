const ADMIN_CODE = 'admin123';
let socket = io();

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast-message';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function animateButton(btn) {
  btn.classList.add('btn-clicked');
  setTimeout(() => btn.classList.remove('btn-clicked'), 200);
}

function checkLogin() {
  const code = document.getElementById('adminCode').value;
  if (code === ADMIN_CODE) {
    document.getElementById('login').style.display = 'none';
    document.getElementById('adminContent').style.display = 'block';
    loadConfig();
    loadPendingPayments();
    loadHistory();
    loadBudgetAndProfit();
    socket.on('budgetUpdated', (data) => {
      document.getElementById('machineBudgetDisplay').innerText = data.budget.toLocaleString();
      loadPendingPayments();
      loadHistory();
    });
    socket.on('netProfitUpdated', (data) => {
      document.getElementById('machineProfitDisplay').innerText = data.netProfit.toLocaleString();
    });
    socket.on('dailyProfitUpdated', (data) => {
      document.getElementById('dailyProfitDisplay').innerText = data.dailyProfit.toLocaleString();
    });
    socket.on('ticketPaid', () => {
      loadPendingPayments();
      loadHistory();
      loadBudgetAndProfit();
    });
    showToast('✅ Acceso concedido');
  } else {
    alert('Código incorrecto');
  }
}
document.getElementById('loginBtn').addEventListener('click', checkLogin);

async function loadConfig() {
  const res = await fetch('/api/admin/config');
  const cfg = await res.json();
  document.getElementById('miniTarget').value = cfg.miniAccumulatedTarget;
  document.getElementById('miniPercent').value = parseFloat(cfg.miniAccumulatedPercentage) * 100;
  updatePrizePreview();
  const drawInterval = cfg.drawInterval || '2500';
  const select = document.getElementById('drawIntervalSelect');
  for (let i = 0; i < select.options.length; i++) {
    if (select.options[i].value === drawInterval) {
      select.selectedIndex = i;
      break;
    }
  }
  const multiplier = parseFloat(cfg.globalMultiplier) || 0.8;
  document.getElementById('globalMultiplierSlider').value = multiplier;
  document.getElementById('multiplierValue').innerText = multiplier.toFixed(2);
  document.getElementById('machineBudgetDisplay').innerText = parseInt(cfg.machineBudget || 0).toLocaleString();
  await loadBudgetAndProfit();

  document.getElementById('avoidBetNumbersCheckbox').checked = cfg.avoidBetNumbers === 'true';
}

function updatePrizePreview() {
  const target = parseFloat(document.getElementById('miniTarget').value) || 0;
  const percent = parseFloat(document.getElementById('miniPercent').value) || 0;
  const prize = (target * percent / 100).toFixed(0);
  document.getElementById('prizePreview').innerHTML = `💰 Premio para el ganador: $${parseInt(prize).toLocaleString()}`;
}

document.getElementById('miniTarget').addEventListener('input', updatePrizePreview);
document.getElementById('miniPercent').addEventListener('input', updatePrizePreview);

const slider = document.getElementById('globalMultiplierSlider');
const multiplierSpan = document.getElementById('multiplierValue');
slider.addEventListener('input', () => {
  multiplierSpan.innerText = parseFloat(slider.value).toFixed(2);
});

async function loadBudgetAndProfit() {
  const res = await fetch('/api/admin/budget');
  const data = await res.json();
  document.getElementById('machineBudgetDisplay').innerText = data.budget.toLocaleString();
  document.getElementById('machineProfitDisplay').innerText = data.profit.toLocaleString();
  document.getElementById('dailyProfitDisplay').innerText = data.dailyProfit.toLocaleString();
}

document.getElementById('saveConfigBtn').addEventListener('click', async () => {
  const btn = document.getElementById('saveConfigBtn');
  animateButton(btn);
  let percentValue = parseFloat(document.getElementById('miniPercent').value);
  if (isNaN(percentValue)) percentValue = 0;
  percentValue = Math.round(percentValue * 100) / 100;
  const updates = {
    miniAccumulatedTarget: document.getElementById('miniTarget').value,
    miniAccumulatedPercentage: (percentValue / 100).toString(),
    drawInterval: document.getElementById('drawIntervalSelect').value,
    globalMultiplier: document.getElementById('globalMultiplierSlider').value,

   avoidBetNumbers: document.getElementById('avoidBetNumbersCheckbox').checked ? 'true' : 'false'
  };
  const res = await fetch('/api/admin/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) });
  if (res.ok) {
    showToast('✅ Configuración guardada');
    loadConfig();
  } else {
    showToast('❌ Error al guardar');
  }
});

document.getElementById('setBudgetBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('setBudgetBtn');
  animateButton(btn);
  const amount = parseInt(document.getElementById('setBudgetAmount').value);
  if (isNaN(amount) || amount < 0) return showToast('Monto inválido');
  const res = await fetch('/api/admin/set-budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount })
  });
  if (res.ok) {
    showToast(`✅ Presupuesto establecido en $${amount.toLocaleString()}`);
    document.getElementById('setBudgetAmount').value = '';
    loadConfig();
    loadPendingPayments();
    loadHistory();
  } else {
    showToast('❌ Error');
  }
});

document.getElementById('reloadBudgetBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('reloadBudgetBtn');
  animateButton(btn);
  const amount = parseInt(document.getElementById('reloadBudgetAmount').value);
  if (isNaN(amount) || amount <= 0) return showToast('Monto inválido');
  const res = await fetch('/api/admin/reload-budget', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount })
  });
  if (res.ok) {
    showToast(`✅ Presupuesto recargado con $${amount.toLocaleString()}`);
    document.getElementById('reloadBudgetAmount').value = '';
    loadConfig();
    loadPendingPayments();
    loadHistory();
  } else {
    showToast('❌ Error');
  }
});

document.getElementById('deleteHistoryBtn')?.addEventListener('click', async () => {
  if (!confirm('⚠️ Borrar TODO el historial? No se puede deshacer.')) return;
  const btn = document.getElementById('deleteHistoryBtn');
  animateButton(btn);
  const res = await fetch('/api/admin/delete-history', { method: 'DELETE' });
  if (res.ok) {
    showToast('Historial eliminado');
    loadHistory();
    loadPendingPayments();
    await loadBudgetAndProfit();
  } else {
    showToast('Error');
  }
});

async function loadPendingPayments() {
  const res = await fetch('/api/admin/pending-payments');
  const pendings = await res.json();
  const tbody = document.querySelector('#pendingTable tbody');
  tbody.innerHTML = '';
  for (const p of pendings) {
    const row = tbody.insertRow();
    row.insertCell(0).textContent = p.ticketCode;
    row.insertCell(1).textContent = `$${p.toPay?.toLocaleString() || 0}`;
    const btnCell = row.insertCell(2);
    const btn = document.createElement('button');
    btn.textContent = 'Pagar';
    btn.className = 'btn-pay';
    btn.onclick = async () => {
      animateButton(btn);
      const resPay = await fetch('/api/admin/pay-ticket', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticketCode: p.ticketCode, amount: p.toPay }) });
      if (resPay.ok) {
        showToast(`Boleta ${p.ticketCode} pagada`);
        loadPendingPayments();
        loadHistory();
        await loadBudgetAndProfit();
      } else {
        const err = await resPay.json();
        showToast(`Error: ${err.error}`);
      }
    };
    btnCell.appendChild(btn);
  }
}

async function loadHistory() {
  const from = document.getElementById('fromDate').value;
  const to = document.getElementById('toDate').value;
  let url = '/api/admin/tickets?';
  if (from) url += `from=${from}&`;
  if (to) url += `to=${to}`;
  const res = await fetch(url);
  const tickets = await res.json();
  const tbody = document.querySelector('#historyTable tbody');
  tbody.innerHTML = '';
  for (const t of tickets) {
    const row = tbody.insertRow();
    row.insertCell(0).textContent = t.ticketCode;
    row.insertCell(1).textContent = t.roundNumber || '-';
    row.insertCell(2).textContent = new Date(t.createdAt).toLocaleString();
    row.insertCell(3).textContent = `$${t.totalAmount?.toLocaleString() || 0}`;
    row.insertCell(4).textContent = `$${t.totalWon?.toLocaleString() || 0}`;
    row.insertCell(5).textContent = t.status;
  }
}

document.getElementById('loadHistoryBtn').addEventListener('click', () => { animateButton(document.getElementById('loadHistoryBtn')); loadHistory(); });
document.getElementById('refreshHistoryBtn')?.addEventListener('click', () => { animateButton(document.getElementById('refreshHistoryBtn')); loadHistory(); });
document.getElementById('refreshPendingBtn')?.addEventListener('click', () => { animateButton(document.getElementById('refreshPendingBtn')); loadPendingPayments(); });

// Modal repetir boleta
const modal = document.getElementById('repeatModal');
const openModalBtn = document.getElementById('openRepeatModalBtn');
const closeSpan = document.querySelector('.close-modal');
openModalBtn.onclick = () => { loadRecentTickets(); modal.style.display = 'block'; };
closeSpan.onclick = () => modal.style.display = 'none';
window.onclick = (event) => { if (event.target == modal) modal.style.display = 'none'; };

async function loadRecentTickets() {
  const container = document.getElementById('recentTicketsList');
  container.innerHTML = '<div style="text-align:center;">Cargando...</div>';
  const res = await fetch('/api/tickets/recent');
  const tickets = await res.json();
  if (!tickets.length) {
    container.innerHTML = '<div style="text-align:center;">No hay boletas en las últimas 5 rondas.</div>';
    return;
  }
  container.innerHTML = '';
  for (const t of tickets) {
    const div = document.createElement('div');
    div.className = 'recent-ticket-item';
    div.style.border = '1px solid #2c7da0';
    div.style.margin = '10px 0';
    div.style.padding = '10px';
    div.style.borderRadius = '8px';
    div.style.background = '#1a2533';
    div.innerHTML = `
      <div><strong>Código:</strong> ${t.ticketCode} | <strong>Ronda:</strong> ${t.roundNumber} | <strong>Fecha:</strong> ${new Date(t.createdAt).toLocaleString()} | <strong>Total:</strong> $${t.totalAmount.toLocaleString()}</div>
      <div><strong>Combinaciones:</strong> ${t.combinations.map(c => `[${c.numbers.join(',')} - $${c.betValue}]`).join(' ; ')}</div>
      <button data-code="${t.ticketCode}" class="btn repeat-ticket-btn" style="margin-top:8px;">🔁 Repetir e imprimir</button>
    `;
    container.appendChild(div);
  }
  document.querySelectorAll('.repeat-ticket-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const code = btn.getAttribute('data-code');
      animateButton(btn);
      const res = await fetch('/api/tickets/repeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketCode: code })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(`Boleta repetida. Nuevo código: ${data.ticketCode}`);
        const fullRes = await fetch(`/api/ticket/full/${data.ticketCode}`);
        const fullData = await fullRes.json();
        const printContent = `<html><head><title>Boleta ${data.ticketCode}</title></head><body style="font-family: monospace; padding: 20px;"><h2>🎫 LA BALOTERA GANADORA</h2><p><strong>Código:</strong> ${data.ticketCode}</p><p><strong>Fecha:</strong> ${new Date().toLocaleString()}</p><hr><h3>Combinaciones:</h3>${fullData.combinations.map(c => `<p>${c.numbers.join(', ')} - $${c.betValue.toLocaleString()}</p>`).join('')}<hr><p><strong>Total pagado:</strong> $${fullData.ticket.totalAmount.toLocaleString()}</p><p>Presenta esta boleta para cobrar.</p></body></html>`;
        const iframe = document.createElement('iframe');
        iframe.style.position = 'absolute';
        iframe.style.width = '0';
        iframe.style.height = '0';
        iframe.style.border = 'none';
        document.body.appendChild(iframe);
        const iframeDoc = iframe.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write(printContent);
        iframeDoc.close();
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
        setTimeout(() => document.body.removeChild(iframe), 1000);
        loadRecentTickets();
        loadHistory();
        await loadBudgetAndProfit();
      } else {
        showToast(`Error: ${data.error}`);
      }
    });
  });
}