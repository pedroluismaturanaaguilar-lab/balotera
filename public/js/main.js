const socket = io();
const ballsGrid = document.getElementById('ballsGrid');
const numbersDrawnBar = document.getElementById('numbersDrawnBar');
const timerDisplay = document.getElementById('timerDisplay');
const miniFill = document.getElementById('miniFill');
const winnerMsg = document.getElementById('winnerMessage');
const roundNumberSpan = document.getElementById('roundNumber');
const visualCountdownDiv = document.getElementById('visualCountdown');
const countdownNumberSpan = document.querySelector('.countdown-number');

let currentRound = 1;
let roundsSinceHotCold = 0;
let hotNumbers = [];
let coldNumbers = [];

// Limpiar y crear 80 bolas
ballsGrid.innerHTML = '';
for (let i = 1; i <= 80; i++) {
  const ball = document.createElement('div');
  ball.className = 'ball';
  ball.innerHTML = `<span class="ball-number">${i}</span>`;
  ball.id = `ball_${i}`;
  ballsGrid.appendChild(ball);
}

function updateMiniAccumulatedBar(current, target) {
  const realPercent = (current / target) * 100;
  let visualPercent = 25 + (realPercent * 0.75);
  visualPercent = Math.min(visualPercent, 100);
  miniFill.style.width = `${visualPercent}%`;
  if (realPercent < 25) miniFill.className = 'fill cafe';
  else if (realPercent < 50) miniFill.className = 'fill rojo';
  else if (realPercent < 75) miniFill.className = 'fill amarillo';
  else miniFill.className = 'fill verde';
}

async function assignRandomHotCold() {
  const res = await fetch('/api/stats/random-hotcold');
  const data = await res.json();
  hotNumbers = data.hot;
  coldNumbers = data.cold;
  for (let i = 1; i <= 80; i++) {
    const ball = document.getElementById(`ball_${i}`);
    if (ball) ball.classList.remove('hot', 'cold');
  }
  hotNumbers.forEach(num => document.getElementById(`ball_${num}`)?.classList.add('hot'));
  coldNumbers.forEach(num => document.getElementById(`ball_${num}`)?.classList.add('cold'));
}

function markNumber(num) {
  const ball = document.getElementById(`ball_${num}`);
  if (ball) {
    ball.classList.add('marked', 'pop');
    setTimeout(() => ball.classList.remove('pop'), 300);
  }
}

function addDrawnNumber(num) {
  const span = document.createElement('span');
  span.textContent = num;
  numbersDrawnBar.appendChild(span);
  numbersDrawnBar.scrollLeft = numbersDrawnBar.scrollWidth;
}

function speak(text) {
  if (!text) return;
  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.rate = 0.9;
    speechSynthesis.speak(utterance);
  }, 50);
}

// Función para eliminar números uno por uno y desmarcar bolas
function removeNumbersSequentially(callback) {
  const numbers = Array.from(numbersDrawnBar.querySelectorAll('span'));
  if (numbers.length === 0) {
    if (callback) callback();
    return;
  }
  let index = 0;
  const interval = setInterval(() => {
    if (index >= numbers.length) {
      clearInterval(interval);
      if (callback) callback();
      return;
    }
    const numSpan = numbers[index];
    const num = parseInt(numSpan.textContent);
    // Animar y eliminar número de la barra
    numSpan.classList.add('number-fade-out');
    setTimeout(() => {
      if (numSpan.parentNode) numSpan.remove();
    }, 400);
    
    // Animar y desmarcar la bola correspondiente
    const ball = document.getElementById(`ball_${num}`);
    if (ball && ball.classList.contains('marked')) {
      ball.classList.add('ball-fade-out');
      setTimeout(() => {
        ball.classList.remove('marked', 'ball-fade-out');
      }, 400);
    }
    index++;
  }, 400);
}

socket.on('resetGame', ({ round }) => {
  // NO limpiamos marcas ni barra aquí (ya se hizo durante la cuenta regresiva)
  winnerMsg.innerHTML = '';
  if (round !== currentRound) {
    roundsSinceHotCold++;
    if (roundsSinceHotCold >= 3) assignRandomHotCold(), (roundsSinceHotCold = 0);
    currentRound = round;
    roundNumberSpan.textContent = currentRound;
  }
});

socket.on('roundUpdate', ({ round }) => {
  if (round !== currentRound) {
    roundsSinceHotCold++;
    if (roundsSinceHotCold >= 3) assignRandomHotCold(), (roundsSinceHotCold = 0);
    currentRound = round;
    roundNumberSpan.textContent = currentRound;
  }
});

socket.on('newNumber', ({ number }) => {
  markNumber(number);
  addDrawnNumber(number);
  speak(`Número ${number}`);
});

socket.on('countdown', ({ remaining, phase }) => {
  if (phase === 'betting') {
    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;
    timerDisplay.textContent = `Tiempo para apostar: ${minutes}:${seconds.toString().padStart(2, '0')}`;
    if (remaining === 180) speak('Faltan 3 minutos para apostar');
    else if (remaining === 120) speak('Faltan 2 minutos para apostar');
    else if (remaining === 60) speak('Último minuto para apostar');
    
    if (remaining === 8) {
      // Mostrar contador visual
      visualCountdownDiv.style.display = 'flex';
      let count = 8;
      countdownNumberSpan.textContent = count;
      const countdownInterval = setInterval(() => {
        count--;
        if (count >= 0) {
          countdownNumberSpan.textContent = count;
        }
        if (count < 0) {
          clearInterval(countdownInterval);
          visualCountdownDiv.style.display = 'none';
        }
      }, 1000);
      
      // Iniciar desaparición de números y desmarcado de bolas
      removeNumbersSequentially();
      speak('¡Últimos segundos para apostar!');
    }
  } else {
    timerDisplay.textContent = '🎲 ¡Sorteo en curso! 🎲';
  }
});

socket.on('speak', ({ message }) => speak(message));

socket.on('phaseChange', ({ isBettingPhase }) => {
  if (!isBettingPhase) {
    visualCountdownDiv.style.display = 'none';
  }
});

socket.on('updateMiniAccumulated', ({ current, target }) => {
  updateMiniAccumulatedBar(current, target);
});

socket.on('accumulatedWinner', ({ ticketCode, amount }) => {
  const msg = `🎉 ¡Boleta ${ticketCode} ha ganado el acumulado especial de $${amount.toLocaleString()}! 🎉`;
  winnerMsg.innerHTML = msg;
  speak(msg);
  for (let i = 0; i < 100; i++) {
    const conf = document.createElement('div');
    conf.className = 'confetti';
    conf.style.left = Math.random() * 100 + '%';
    conf.style.animationDuration = Math.random() * 2 + 1 + 's';
    conf.style.backgroundColor = `hsl(${Math.random() * 360}, 100%, 50%)`;
    document.body.appendChild(conf);
    setTimeout(() => conf.remove(), 3000);
  }
});

socket.on('gameEnd', () => {
  speak('Fin de partida');
});

socket.on('gameState', ({ miniAccumulated, miniTarget }) => {
  updateMiniAccumulatedBar(miniAccumulated, miniTarget);
});

assignRandomHotCold();
