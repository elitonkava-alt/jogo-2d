// ============================================================
// MAGO DA FLORESTA — Plataforma 2D
// HTML + CSS + JavaScript puro (Canvas)
// Física de colisão AABB, partículas, inventário, dificuldades
// ============================================================

const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

// ------------------ Estado do jogo ------------------
let gameState = 'menu'; // menu | playing | ash | cutscene | ending | victory | defeat
let score = 0;
let lives = 3;
let cameraX = 0;
let skeletonKills = 0;
let hasArmsOfHadar = false;
let armsCooldown = 0;
let armsActive = 0;

// Narrativa / atmosfera
let glitchTimer = 0;
let glitchCooldown = 200;
let crowBlink = 0;
let rat = null;
let ashParticles = [];
let mutants = [];
let ashSpawnTimer = 0;
let ashIntensity = 1;
let cutscenePhase = 0;
let cutsceneTimer = 0;
let cutsceneText = '';
let endingDistort = 0;

// Inventário
const inventory = {
  potions: 0
};

// Drops no chão (poções que caem dos inimigos)
const groundDrops = [];

// Dificuldade
let difficulty = 'easy';
const DIFF = {
  easy: {
    label: 'Fácil',
    desc: 'Mais vidas, inimigos mais fracos, mais poções.',
    lives: 5,
    enemyHpMult: 0.7,
    enemySpeedMult: 0.85,
    potionDropChance: 0.45,
    skeletonCount: 16,
    dragonHp: 18
  },
  normal: {
    label: 'Normal',
    desc: 'Equilíbrio clássico. Bom para a maioria dos jogadores.',
    lives: 3,
    enemyHpMult: 1.0,
    enemySpeedMult: 1.0,
    potionDropChance: 0.28,
    skeletonCount: 20,
    dragonHp: 25
  },
  hard: {
    label: 'Difícil',
    desc: 'Poucas vidas, inimigos rápidos e resistentes, poucas poções.',
    lives: 2,
    enemyHpMult: 1.4,
    enemySpeedMult: 1.25,
    potionDropChance: 0.12,
    skeletonCount: 24,
    dragonHp: 35
  }
};

// Mensagens de tutorial
let messageTimer = 0;
let currentMessage = '';
let shownMessages = new Set();

// ------------------ Sistema de Save (localStorage + IndexedDB) ------------------
// localStorage  → dados pequenos e acesso síncrono (recordes, preferências)
// IndexedDB     → dados maiores (histórico de partidas, checkpoint de progresso)
const SAVE_KEY = 'magoDaFloresta_save_v1';
const IDB_NAME = 'MagoDaFlorestaDB';
const IDB_VERSION = 1;

let idb = null;           // conexão IndexedDB
let saveCache = null;     // cache em memória do meta-save
let idbReady = false;

function getDefaultSave() {
  return {
    highScores: { easy: 0, normal: 0, hard: 0 },
    preferredDifficulty: 'easy',
    gamesPlayed: 0,
    gamesWon: 0,
    totalSkeletonKills: 0,
    bestSkeletonKills: 0,
    unlockedArmsEver: false,
    lastPlayedAt: null
  };
}

// --- localStorage (rápido / síncrono) ---
function loadSave() {
  if (saveCache) return saveCache;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      saveCache = getDefaultSave();
      return saveCache;
    }
    const data = JSON.parse(raw);
    const base = getDefaultSave();
    saveCache = {
      ...base,
      ...data,
      highScores: { ...base.highScores, ...(data.highScores || {}) }
    };
    return saveCache;
  } catch (e) {
    console.warn('Erro ao carregar save (localStorage):', e);
    saveCache = getDefaultSave();
    return saveCache;
  }
}

function writeSave(data) {
  saveCache = data;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('Erro ao salvar (localStorage):', e);
  }
  // Espelha o meta no IndexedDB (assíncrono, não bloqueia)
  idbPut('meta', { id: 'main', ...data }).catch(() => {});
}

// --- IndexedDB (dados maiores) ---
function openIDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      console.warn('IndexedDB não disponível neste navegador.');
      resolve(null);
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Store de metadados / preferências (espelho do localStorage)
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'id' });
      }
      // Histórico de partidas (pode crescer bastante)
      if (!db.objectStoreNames.contains('runs')) {
        const runs = db.createObjectStore('runs', { keyPath: 'id', autoIncrement: true });
        runs.createIndex('byDate', 'date', { unique: false });
        runs.createIndex('byDifficulty', 'difficulty', { unique: false });
        runs.createIndex('byVictory', 'victory', { unique: false });
      }
      // Checkpoint de progresso no meio da fase
      if (!db.objectStoreNames.contains('progress')) {
        db.createObjectStore('progress', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn('Erro ao abrir IndexedDB:', req.error);
      resolve(null);
    };
  });
}

function idbPut(storeName, value) {
  return new Promise((resolve, reject) => {
    if (!idb) { resolve(false); return; }
    try {
      const tx = idb.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(value);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    } catch (e) {
      reject(e);
    }
  });
}

function idbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    if (!idb) { resolve(undefined); return; }
    try {
      const tx = idb.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

function idbGetAll(storeName, limit = 50) {
  return new Promise((resolve, reject) => {
    if (!idb) { resolve([]); return; }
    try {
      const tx = idb.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const results = [];
      // Percorre do mais recente (se tiver índice por data, usamos cursor invertido via key)
      const req = store.openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

function idbClearStore(storeName) {
  return new Promise((resolve, reject) => {
    if (!idb) { resolve(false); return; }
    try {
      const tx = idb.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    } catch (e) {
      reject(e);
    }
  });
}

function idbDeleteDB() {
  return new Promise((resolve) => {
    if (idb) {
      idb.close();
      idb = null;
    }
    if (!window.indexedDB) { resolve(); return; }
    const req = indexedDB.deleteDatabase(IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function initStorage() {
  // 1) Carrega meta do localStorage (síncrono)
  loadSave();
  // 2) Abre IndexedDB
  idb = await openIDB();
  idbReady = !!idb;

  if (idb) {
    // Migra meta do localStorage → IDB se ainda não existir
    const existing = await idbGet('meta', 'main');
    if (!existing) {
      await idbPut('meta', { id: 'main', ...loadSave() });
    } else {
      // Se IDB tiver dados mais novos (ex.: outro contexto), mescla recordes
      const local = loadSave();
      const merged = {
        ...local,
        ...existing,
        highScores: {
          easy: Math.max(local.highScores.easy || 0, existing.highScores?.easy || 0),
          normal: Math.max(local.highScores.normal || 0, existing.highScores?.normal || 0),
          hard: Math.max(local.highScores.hard || 0, existing.highScores?.hard || 0)
        },
        gamesPlayed: Math.max(local.gamesPlayed || 0, existing.gamesPlayed || 0),
        gamesWon: Math.max(local.gamesWon || 0, existing.gamesWon || 0),
        totalSkeletonKills: Math.max(local.totalSkeletonKills || 0, existing.totalSkeletonKills || 0),
        bestSkeletonKills: Math.max(local.bestSkeletonKills || 0, existing.bestSkeletonKills || 0),
        unlockedArmsEver: !!(local.unlockedArmsEver || existing.unlockedArmsEver)
      };
      delete merged.id;
      writeSave(merged);
    }
  }
  updateMenuSaveUI();
  applyPreferredDifficulty();
  return idbReady;
}

function updateMenuSaveUI() {
  const s = loadSave();
  const elEasy = document.getElementById('hsEasy');
  const elNormal = document.getElementById('hsNormal');
  const elHard = document.getElementById('hsHard');
  const elPlayed = document.getElementById('gamesPlayed');
  const elWon = document.getElementById('gamesWon');
  if (elEasy) elEasy.textContent = s.highScores.easy;
  if (elNormal) elNormal.textContent = s.highScores.normal;
  if (elHard) elHard.textContent = s.highScores.hard;
  if (elPlayed) elPlayed.textContent = s.gamesPlayed;
  if (elWon) elWon.textContent = s.gamesWon;
}

function applyPreferredDifficulty() {
  const s = loadSave();
  difficulty = s.preferredDifficulty || 'easy';
  if (!DIFF[difficulty]) difficulty = 'easy';

  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.diff === difficulty);
  });
  const desc = document.getElementById('diffDesc');
  if (desc) desc.textContent = DIFF[difficulty].desc;
}

function savePreferredDifficulty() {
  const s = loadSave();
  s.preferredDifficulty = difficulty;
  writeSave(s);
}

/**
 * Registra o resultado de uma partida.
 * - Atualiza recordes no localStorage
 * - Grava entrada completa no histórico IndexedDB (runs)
 */
function recordRunResult(victory) {
  const s = loadSave();
  s.gamesPlayed = (s.gamesPlayed || 0) + 1;
  if (victory) s.gamesWon = (s.gamesWon || 0) + 1;

  const prevBest = s.highScores[difficulty] || 0;
  let newRecord = false;
  if (score > prevBest) {
    s.highScores[difficulty] = score;
    newRecord = true;
  }

  s.totalSkeletonKills = (s.totalSkeletonKills || 0) + skeletonKills;
  if (skeletonKills > (s.bestSkeletonKills || 0)) {
    s.bestSkeletonKills = skeletonKills;
  }
  if (hasArmsOfHadar) s.unlockedArmsEver = true;
  s.preferredDifficulty = difficulty;
  s.lastPlayedAt = new Date().toISOString();
  writeSave(s);
  updateMenuSaveUI();

  // Histórico detalhado no IndexedDB (dado “grande”)
  const runEntry = {
    date: s.lastPlayedAt,
    difficulty,
    score,
    victory,
    livesLeft: lives,
    skeletonKills,
    potionsLeft: inventory.potions,
    hasArmsOfHadar,
    newRecord,
    durationHint: Math.round(cameraX) // proxy simples de progresso no mapa
  };
  idbPut('runs', runEntry).catch(err => console.warn('Falha ao gravar run no IDB:', err));

  // Limpa checkpoint ao terminar a partida
  clearProgressCheckpoint();

  return newRecord;
}

/** Snapshot do progresso atual (para continuar depois). */
function buildProgressSnapshot() {
  return {
    id: 'checkpoint',
    savedAt: new Date().toISOString(),
    difficulty,
    score,
    lives,
    cameraX,
    skeletonKills,
    hasArmsOfHadar,
    armsCooldown,
    inventory: { potions: inventory.potions },
    player: {
      x: player.x,
      y: player.y,
      facing: player.facing
    },
    noteCollected: note.collected,
    coinsCollected: coins.map(c => c.collected),
    skeletonsAlive: skeletons.map(sk => ({
      alive: sk.alive,
      x: sk.x,
      y: sk.y,
      hp: sk.hp
    })),
    hobgoblin: {
      alive: hobgoblin.alive,
      x: hobgoblin.x,
      y: hobgoblin.y,
      stunTimer: hobgoblin.stunTimer
    },
    boneDragon: {
      alive: boneDragon.alive,
      hp: boneDragon.hp,
      roarPlayed: boneDragon.roarPlayed
    }
  };
}

async function saveProgressCheckpoint() {
  if (gameState !== 'playing') return false;
  const snap = buildProgressSnapshot();
  const ok = await idbPut('progress', snap);
  if (ok) {
    showMessage('Progresso salvo! (IndexedDB)');
    playSound('unlock');
  } else {
    showMessage('Não foi possível salvar o progresso.');
  }
  return ok;
}

async function loadProgressCheckpoint() {
  const snap = await idbGet('progress', 'checkpoint');
  return snap || null;
}

function clearProgressCheckpoint() {
  if (!idb) return;
  try {
    const tx = idb.transaction('progress', 'readwrite');
    tx.objectStore('progress').delete('checkpoint');
  } catch (e) { /* ignore */ }
}

async function restoreFromCheckpoint(snap) {
  if (!snap) return false;

  difficulty = snap.difficulty || difficulty;
  score = snap.score || 0;
  lives = snap.lives || DIFF[difficulty].lives;
  cameraX = snap.cameraX || 0;
  skeletonKills = snap.skeletonKills || 0;
  hasArmsOfHadar = !!snap.hasArmsOfHadar;
  armsCooldown = snap.armsCooldown || 0;
  armsActive = 0;
  inventory.potions = snap.inventory?.potions || 0;
  groundDrops.length = 0;
  projectiles.length = 0;
  particles.length = 0;
  shownMessages.clear();

  player.x = snap.player?.x ?? 80;
  player.y = snap.player?.y ?? 400;
  player.vx = 0;
  player.vy = 0;
  player.facing = snap.player?.facing ?? 1;
  player.attacking = false;
  player.attackTimer = 0;
  player.attackCooldown = 0;
  player.magicCooldown = 0;
  player.invuln = 0;
  player.wasInAir = false;

  note.collected = !!snap.noteCollected;
  if (snap.coinsCollected && snap.coinsCollected.length === coins.length) {
    coins.forEach((c, i) => { c.collected = !!snap.coinsCollected[i]; });
  }

  // Recria esqueletos e restaura estado
  spawnSkeletons();
  if (snap.skeletonsAlive) {
    for (let i = 0; i < skeletons.length && i < snap.skeletonsAlive.length; i++) {
      const src = snap.skeletonsAlive[i];
      skeletons[i].alive = src.alive;
      skeletons[i].x = src.x;
      skeletons[i].y = src.y;
      skeletons[i].hp = src.hp;
    }
  }

  if (snap.hobgoblin) {
    hobgoblin.alive = snap.hobgoblin.alive !== false;
    hobgoblin.x = snap.hobgoblin.x ?? hobgoblin.x;
    hobgoblin.y = snap.hobgoblin.y ?? hobgoblin.y;
    hobgoblin.stunTimer = snap.hobgoblin.stunTimer || 0;
  }

  applyDifficultyToDragon();
  if (snap.boneDragon) {
    boneDragon.alive = snap.boneDragon.alive !== false;
    boneDragon.hp = snap.boneDragon.hp ?? boneDragon.maxHp;
    boneDragon.roarPlayed = !!snap.boneDragon.roarPlayed;
  }

  gameState = 'playing';
  document.getElementById('mainMenu').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');
  document.getElementById('overlay').classList.add('hidden');
  updateHUD();
  showMessage('Progresso carregado!');
  return true;
}

async function clearSaveData() {
  saveCache = null;
  localStorage.removeItem(SAVE_KEY);
  await idbClearStore('meta');
  await idbClearStore('runs');
  await idbClearStore('progress');
  saveCache = getDefaultSave();
  writeSave(saveCache);
  updateMenuSaveUI();
  difficulty = 'easy';
  applyPreferredDifficulty();
  showMessage('Save apagado (localStorage + IndexedDB).');
}

/** Retorna as últimas N partidas do histórico (IndexedDB). */
async function getRecentRuns(limit = 10) {
  return idbGetAll('runs', limit);
}

// ------------------ Áudio (Web Audio API - sons procedurais) ------------------
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function initAudio() {
  if (!audioCtx) audioCtx = new AudioCtx();
}

function playSound(type) {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);

  switch (type) {
    case 'jump':
      osc.type = 'square';
      osc.frequency.setValueAtTime(280, now);
      osc.frequency.exponentialRampToValueAtTime(180, now + 0.12);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      osc.start(now); osc.stop(now + 0.13);
      break;
    case 'coin':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(1400, now + 0.1);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      osc.start(now); osc.stop(now + 0.16);
      break;
    case 'hit':
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(120, now);
      osc.frequency.exponentialRampToValueAtTime(60, now + 0.1);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
      osc.start(now); osc.stop(now + 0.13);
      break;
    case 'magic':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.25);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.28);
      osc.start(now); osc.stop(now + 0.3);
      break;
    case 'stun':
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.setValueAtTime(800, now + 0.05);
      osc.frequency.setValueAtTime(300, now + 0.15);
      gain.gain.setValueAtTime(0.16, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.start(now); osc.stop(now + 0.32);
      break;
    case 'damage':
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(150, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.2);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.22);
      osc.start(now); osc.stop(now + 0.23);
      break;
    case 'heal':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.2);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.25);
      osc.start(now); osc.stop(now + 0.26);
      break;
    case 'skeletonDie':
      osc.type = 'square';
      osc.frequency.setValueAtTime(200, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.15);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
      osc.start(now); osc.stop(now + 0.2);
      break;
    case 'arms':
      // Braços de Hadar - som grave e psíquico
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(80, now);
      osc.frequency.exponentialRampToValueAtTime(40, now + 0.4);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);
      osc.start(now); osc.stop(now + 0.5);
      break;
    case 'unlock':
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(659, now + 0.1);
      osc.frequency.setValueAtTime(784, now + 0.2);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      osc.start(now); osc.stop(now + 0.42);
      break;
    case 'dragonRoar':
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(90, now);
      osc.frequency.exponentialRampToValueAtTime(30, now + 0.6);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.7);
      osc.start(now); osc.stop(now + 0.72);
      break;
  }
}

// Inicializa áudio no primeiro clique/tecla (política dos navegadores)
window.addEventListener('keydown', () => initAudio(), { once: true });
window.addEventListener('click', () => initAudio(), { once: true });

// ------------------ Input ------------------
const keys = {
  left: false, right: false, up: false, down: false,
  jump: false, attack: false, magic: false, arms: false, potion: false
};

window.addEventListener('keydown', e => {
  if (['ArrowLeft','a','A'].includes(e.key)) keys.left = true;
  if (['ArrowRight','d','D'].includes(e.key)) keys.right = true;
  if (['ArrowUp','w','W'].includes(e.key)) keys.up = true;
  if (['ArrowDown','s','S'].includes(e.key)) keys.down = true;
  if (e.key === ' ' || e.key === 'Spacebar') { keys.jump = true; e.preventDefault(); }
  if (e.key === 'j' || e.key === 'J' || e.key === 'f' || e.key === 'F') keys.attack = true;
  if (e.key === 'q' || e.key === 'Q') keys.magic = true;
  if (e.key === 'e' || e.key === 'E') keys.arms = true;
  if (e.key === '1' || e.key === 'h' || e.key === 'H') keys.potion = true;
  // Salvar progresso (P)
  if ((e.key === 'p' || e.key === 'P') && gameState === 'playing') {
    saveProgressCheckpoint();
  }
});

window.addEventListener('keyup', e => {
  if (['ArrowLeft','a','A'].includes(e.key)) keys.left = false;
  if (['ArrowRight','d','D'].includes(e.key)) keys.right = false;
  if (['ArrowUp','w','W'].includes(e.key)) keys.up = false;
  if (['ArrowDown','s','S'].includes(e.key)) keys.down = false;
  if (e.key === ' ' || e.key === 'Spacebar') keys.jump = false;
  if (e.key === 'j' || e.key === 'J' || e.key === 'f' || e.key === 'F') keys.attack = false;
  if (e.key === 'q' || e.key === 'Q') keys.magic = false;
  if (e.key === 'e' || e.key === 'E') keys.arms = false;
  if (e.key === '1' || e.key === 'h' || e.key === 'H') keys.potion = false;
});

// ------------------ Física precisa (AABB) ------------------
/**
 * Resolve colisão entre um retângulo dinâmico (player/enemy) e plataformas.
 * Separação em eixos X e Y para evitar "sticking" e tunneling.
 * Retorna o estado de colisão atualizado.
 */
function resolveCollisions(entity, platforms) {
  // Reset flags
  entity.onGround = false;
  entity.hitCeiling = false;
  entity.hitWallLeft = false;
  entity.hitWallRight = false;

  // 1) Movimento horizontal primeiro
  entity.x += entity.vx;

  for (const p of platforms) {
    if (aabbOverlap(entity, p)) {
      if (entity.vx > 0) {
        // colidiu pela esquerda da plataforma
        entity.x = p.x - entity.w;
        entity.vx = 0;
        entity.hitWallRight = true;
      } else if (entity.vx < 0) {
        // colidiu pela direita da plataforma
        entity.x = p.x + p.w;
        entity.vx = 0;
        entity.hitWallLeft = true;
      }
    }
  }

  // 2) Movimento vertical
  entity.y += entity.vy;

  for (const p of platforms) {
    if (aabbOverlap(entity, p)) {
      if (entity.vy > 0) {
        // caiu em cima da plataforma
        entity.y = p.y - entity.h;
        entity.vy = 0;
        entity.onGround = true;
      } else if (entity.vy < 0) {
        // bateu a cabeça
        entity.y = p.y + p.h;
        entity.vy = 0;
        entity.hitCeiling = true;
      }
    }
  }
}

function aabbOverlap(a, b) {
  return a.x < b.x + b.w &&
         a.x + a.w > b.x &&
         a.y < b.y + b.h &&
         a.y + a.h > b.y;
}

// Colisão de círculo (usado para moedas e projéteis)
function circleRectOverlap(cx, cy, r, rect) {
  const closestX = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const closestY = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - closestX;
  const dy = cy - closestY;
  return (dx * dx + dy * dy) < (r * r);
}

// ------------------ Mundo ------------------
const platforms = [
  // Chão principal do bosque
  { x: 0,   y: 480, w: 1400, h: 60 },
  // Plataformas do bosque
  { x: 220, y: 380, w: 140, h: 20 },
  { x: 420, y: 300, w: 120, h: 20 },
  { x: 600, y: 380, w: 160, h: 20 },
  { x: 820, y: 280, w: 130, h: 20 },
  { x: 1050,y: 360, w: 150, h: 20 },
  // Entrada da vila
  { x: 1300, y: 480, w: 900, h: 60 },
  { x: 1450, y: 360, w: 180, h: 20 },
  { x: 1700, y: 300, w: 140, h: 20 },
  { x: 1900, y: 400, w: 200, h: 20 },
  // Área do bilhete
  { x: 2100, y: 480, w: 500, h: 60 },
  // Caminho para a Ruína
  { x: 2600, y: 480, w: 400, h: 60 },
  { x: 2750, y: 380, w: 120, h: 20 },
  // Ruína (chão mais escuro / quebrado)
  { x: 3000, y: 480, w: 1600, h: 60 },
  { x: 3100, y: 360, w: 100, h: 20 },
  { x: 3300, y: 300, w: 130, h: 20 },
  { x: 3550, y: 380, w: 110, h: 20 },
  { x: 3750, y: 280, w: 140, h: 20 },
  { x: 4000, y: 360, w: 120, h: 20 },
  { x: 4200, y: 400, w: 150, h: 20 },
  // Plataforma final (antes do dragão)
  { x: 4450, y: 320, w: 180, h: 20 },
  { x: 4600, y: 480, w: 500, h: 60 },
];

// Moedas
const coins = [
  { x: 280, y: 340, r: 10, collected: false },
  { x: 460, y: 260, r: 10, collected: false },
  { x: 660, y: 340, r: 10, collected: false },
  { x: 870, y: 240, r: 10, collected: false },
  { x: 1100,y: 320, r: 10, collected: false },
  { x: 1520,y: 320, r: 10, collected: false },
  { x: 1760,y: 260, r: 10, collected: false },
  { x: 1980,y: 360, r: 10, collected: false },
  // Moedas na ruína
  { x: 3150, y: 320, r: 10, collected: false },
  { x: 3350, y: 260, r: 10, collected: false },
  { x: 3600, y: 340, r: 10, collected: false },
  { x: 3800, y: 240, r: 10, collected: false },
  { x: 4050, y: 320, r: 10, collected: false },
  { x: 4500, y: 280, r: 10, collected: false },
];

// Bilhete (objetivo inicial)
const note = {
  x: 2250, y: 430, w: 28, h: 20,
  collected: false
};

// ------------------ Esqueletos (inimigos fracos da ruína) ------------------
const skeletons = [];

function spawnSkeletons() {
  const positions = [
    3050, 3180, 3320, 3480, 3620, 3780, 3920, 4080, 4220, 4380,
    3120, 3400, 3650, 3900, 4150, 4300, 4500, 3200, 3550, 4000,
    3250, 3700, 4100, 4450
  ];
  const d = DIFF[difficulty];
  const count = Math.min(d.skeletonCount, positions.length);
  skeletons.length = 0;
  for (let i = 0; i < count; i++) {
    const baseHp = 2;
    skeletons.push({
      x: positions[i],
      y: 400,
      w: 26,
      h: 40,
      vx: 0,
      vy: 0,
      speed: (1.4 + Math.random() * 0.6) * d.enemySpeedMult,
      gravity: 0.48,
      maxFall: 12,
      onGround: false,
      facing: Math.random() > 0.5 ? 1 : -1,
      state: 'patrol',
      patrolLeft: positions[i] - 80,
      patrolRight: positions[i] + 80,
      hp: Math.max(1, Math.round(baseHp * d.enemyHpMult)),
      invuln: 0,
      attackTimer: 0,
      attackCooldown: 0,
      animFrame: 0,
      animTimer: 0,
      alive: true
    });
  }
}

// ------------------ Dragão de Osso (boss final) ------------------
const boneDragon = {
  x: 4750,
  y: 300,
  w: 90,
  h: 70,
  vx: 0,
  vy: 0,
  hp: 25,
  maxHp: 25,
  facing: -1,
  state: 'idle',
  attackTimer: 0,
  attackCooldown: 0,
  invuln: 0,
  animFrame: 0,
  animTimer: 0,
  alive: true,
  roarPlayed: false
};

function applyDifficultyToDragon() {
  const d = DIFF[difficulty];
  boneDragon.maxHp = d.dragonHp;
  boneDragon.hp = d.dragonHp;
}

// ------------------ Jogador (Mago) ------------------
const player = {
  x: 80,
  y: 400,
  w: 28,
  h: 42,
  vx: 0,
  vy: 0,
  speed: 3.2,
  jumpForce: -11.5,
  gravity: 0.48,
  maxFall: 12,
  onGround: false,
  facing: 1, // 1 direita, -1 esquerda
  // Ataque corpo a corpo (bastão)
  attacking: false,
  attackTimer: 0,
  attackCooldown: 0,
  // Magia Farpas Mentais
  magicCooldown: 0,
  // Invulnerabilidade após dano
  invuln: 0,
  // Animação
  animFrame: 0,
  animTimer: 0,
  wasInAir: false
};

// ------------------ Hobgoblin (inimigo) ------------------
const hobgoblin = {
  x: 1550,
  y: 400,
  w: 36,
  h: 48,
  vx: 0,
  vy: 0,
  speed: 2.4,
  gravity: 0.48,
  maxFall: 12,
  onGround: false,
  facing: -1,
  // IA
  state: 'patrol', // patrol | chase | attack | stunned
  patrolLeft: 1400,
  patrolRight: 1850,
  attackRange: 55,
  attackTimer: 0,
  attackCooldown: 0,
  stunTimer: 0,
  // Dano
  damageCooldown: 0,
  // Animação
  animFrame: 0,
  animTimer: 0,
  alive: true
};

// Projéteis de magia (Farpas Mentais)
const projectiles = [];

// ------------------ Sistema de Partículas ------------------
const particles = [];

/**
 * Cria partículas visuais.
 * type: 'spark' | 'dust' | 'magic' | 'hit' | 'coin' | 'stun' | 'damage' | 'leaf' | 'break' | 'heal' | 'glow'
 */
function spawnParticles(x, y, count, type = 'spark') {
  for (let i = 0; i < count; i++) {
    let color, size, life, vx, vy, gravity, rotation = 0, rotSpeed = 0;

    switch (type) {
      case 'coin':
        color = ['#ffd700', '#ffecb3', '#fff59d', '#ffb300'][Math.floor(Math.random() * 4)];
        size = 2 + Math.random() * 3;
        life = 25 + Math.random() * 20;
        vx = (Math.random() - 0.5) * 4;
        vy = -2 - Math.random() * 3;
        gravity = 0.15;
        break;
      case 'magic':
        color = ['#80d8ff', '#40c4ff', '#e1f5fe', '#00b0ff'][Math.floor(Math.random() * 4)];
        size = 2 + Math.random() * 4;
        life = 20 + Math.random() * 25;
        vx = (Math.random() - 0.5) * 5;
        vy = (Math.random() - 0.5) * 5;
        gravity = -0.02;
        break;
      case 'stun':
        color = ['#ffeb3b', '#fff176', '#ffee58', '#fdd835'][Math.floor(Math.random() * 4)];
        size = 3 + Math.random() * 4;
        life = 30 + Math.random() * 20;
        vx = (Math.random() - 0.5) * 6;
        vy = -1 - Math.random() * 4;
        gravity = 0.08;
        break;
      case 'hit':
        color = ['#ff8a65', '#ff5722', '#ffccbc', '#e64a19'][Math.floor(Math.random() * 4)];
        size = 2 + Math.random() * 3;
        life = 15 + Math.random() * 15;
        vx = (Math.random() - 0.5) * 7;
        vy = -2 - Math.random() * 3;
        gravity = 0.2;
        break;
      case 'damage':
        color = ['#ef5350', '#e53935', '#ffcdd2', '#c62828'][Math.floor(Math.random() * 4)];
        size = 2 + Math.random() * 4;
        life = 20 + Math.random() * 15;
        vx = (Math.random() - 0.5) * 5;
        vy = -3 - Math.random() * 2;
        gravity = 0.18;
        break;
      case 'dust':
        color = ['#a1887f', '#8d6e63', '#bcaaa4', '#6d4c41'][Math.floor(Math.random() * 4)];
        size = 2 + Math.random() * 3;
        life = 18 + Math.random() * 12;
        vx = (Math.random() - 0.5) * 3;
        vy = -0.5 - Math.random() * 1.5;
        gravity = 0.12;
        break;
      case 'leaf':
        // Folhas caindo no bosque
        color = ['#4caf50', '#66bb6a', '#81c784', '#a5d6a7', '#2e7d32', '#cddc39'][Math.floor(Math.random() * 6)];
        size = 3 + Math.random() * 4;
        life = 180 + Math.random() * 120; // vivem bastante
        vx = (Math.random() - 0.5) * 1.2;
        vy = 0.4 + Math.random() * 0.8;
        gravity = 0.01;
        rotation = Math.random() * Math.PI * 2;
        rotSpeed = (Math.random() - 0.5) * 0.08;
        break;
      case 'break':
        // Fragmentos de "quebra" ao atordoar o Hobgoblin
        color = ['#8d6e63', '#6d4c41', '#a1887f', '#5d4037', '#bcaaa4', '#ffeb3b'][Math.floor(Math.random() * 6)];
        size = 2 + Math.random() * 5;
        life = 25 + Math.random() * 25;
        vx = (Math.random() - 0.5) * 9;
        vy = -3 - Math.random() * 5;
        gravity = 0.25;
        rotation = Math.random() * Math.PI * 2;
        rotSpeed = (Math.random() - 0.5) * 0.2;
        break;
      case 'heal':
        // Partículas de cura / power-up (pronto para o futuro)
        color = ['#69f0ae', '#00e676', '#b9f6ca', '#00c853', '#a7ffeb'][Math.floor(Math.random() * 5)];
        size = 2 + Math.random() * 4;
        life = 30 + Math.random() * 25;
        vx = (Math.random() - 0.5) * 2.5;
        vy = -1.5 - Math.random() * 2.5;
        gravity = -0.04; // sobem suavemente
        break;
      case 'glow':
        // Usado no brilho do bilhete
        color = ['#fff9c4', '#ffecb3', '#ffe082', '#ffffff'][Math.floor(Math.random() * 4)];
        size = 1 + Math.random() * 3;
        life = 20 + Math.random() * 15;
        vx = (Math.random() - 0.5) * 1.5;
        vy = (Math.random() - 0.5) * 1.5;
        gravity = -0.01;
        break;
      default: // spark
        color = ['#ffffff', '#e0e0e0', '#bdbdbd'][Math.floor(Math.random() * 3)];
        size = 1 + Math.random() * 2;
        life = 12 + Math.random() * 10;
        vx = (Math.random() - 0.5) * 4;
        vy = (Math.random() - 0.5) * 4;
        gravity = 0.1;
    }

    particles.push({
      x, y, vx, vy,
      size,
      color,
      life,
      maxLife: life,
      gravity,
      type,
      rotation,
      rotSpeed
    });
  }
}

function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.vy += p.gravity;
    p.life--;

    // Rotação (folhas e fragmentos)
    if (p.rotSpeed) {
      p.rotation += p.rotSpeed;
    }

    // Folhas balançam de leve
    if (p.type === 'leaf') {
      p.vx += Math.sin(p.life * 0.05) * 0.03;
    }

    // Desacelera um pouco (exceto folhas)
    if (p.type !== 'leaf') {
      p.vx *= 0.98;
      p.vy *= 0.98;
    }

    // Remove folhas que caíram muito abaixo
    if (p.life <= 0 || (p.type === 'leaf' && p.y > H + 40)) {
      particles.splice(i, 1);
    }
  }
}

function drawParticles() {
  for (const p of particles) {
    const alpha = Math.max(0, p.life / p.maxLife);
    const sx = p.x - cameraX;

    // Não desenha fora da tela
    if (sx < -30 || sx > W + 30) continue;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;

    if (p.type === 'magic' || p.type === 'stun' || p.type === 'heal' || p.type === 'glow') {
      // Partículas brilhantes (círculos)
      ctx.beginPath();
      ctx.arc(sx, p.y, p.size * (0.6 + 0.4 * alpha), 0, Math.PI * 2);
      ctx.fill();
    } else if (p.type === 'leaf') {
      // Folha estilizada (losango / retângulo rotacionado)
      ctx.save();
      ctx.translate(sx, p.y);
      ctx.rotate(p.rotation || 0);
      ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.6);
      // Nervura simples
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(-1, -p.size / 4, 2, p.size * 0.5);
      ctx.restore();
    } else if (p.type === 'break') {
      // Fragmentos irregulares
      ctx.save();
      ctx.translate(sx, p.y);
      ctx.rotate(p.rotation || 0);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
      ctx.restore();
    } else {
      // Partículas normais (quadradas = estilo pixel)
      const s = p.size * (0.7 + 0.3 * alpha);
      ctx.fillRect(sx - s / 2, p.y - s / 2, s, s);
    }
  }
  ctx.globalAlpha = 1;
}

// ------------------ Funções de atualização ------------------
function updatePlayer() {
  if (gameState !== 'playing' && gameState !== 'ash') return;

  // Horizontal
  if (keys.left) {
    player.vx = -player.speed;
    player.facing = -1;
  } else if (keys.right) {
    player.vx = player.speed;
    player.facing = 1;
  } else {
    // Fricção no chão
    if (player.onGround) player.vx *= 0.7;
    else player.vx *= 0.92;
    if (Math.abs(player.vx) < 0.1) player.vx = 0;
  }

  // Pulo
  if (keys.jump && player.onGround) {
    player.vy = player.jumpForce;
    player.onGround = false;
    playSound('jump');
    spawnParticles(player.x + player.w / 2, player.y + player.h, 6, 'dust');
  }

  // Gravidade
  player.vy += player.gravity;
  if (player.vy > player.maxFall) player.vy = player.maxFall;

  // Colisões precisas
  resolveCollisions(player, getActivePlatforms());

  // Limites do mundo
  if (gameState === 'ash') {
    if (player.x < ASH_START_X) player.x = ASH_START_X;
  } else {
    if (player.x < 0) player.x = 0;
  }
  if (player.y > H + 100) {
    takeDamage(1);
    if (gameState === 'ash') {
      player.x = Math.max(ASH_START_X + 40, player.x - 80);
    } else {
      player.x = 80;
    }
    player.y = 400;
    player.vx = 0;
    player.vy = 0;
  }

  // Ataque com bastão
  if (player.attackCooldown > 0) player.attackCooldown--;
  if (keys.attack && player.attackCooldown <= 0 && !player.attacking) {
    player.attacking = true;
    player.attackTimer = 14;
    player.attackCooldown = 22;
  }
  if (player.attacking) {
    player.attackTimer--;
    if (player.attackTimer <= 0) player.attacking = false;

    // Hitbox do bastão
    if (hobgoblin.alive && hobgoblin.stunTimer <= 0) {
      const staffX = player.facing === 1 ? player.x + player.w : player.x - 30;
      const staffRect = { x: staffX, y: player.y + 8, w: 32, h: 20 };
      if (aabbOverlap(staffRect, hobgoblin)) {
        hobgoblin.vx = player.facing * 4;
        hobgoblin.vy = -3;
        score += 5;
        updateHUD();
        playSound('hit');
        spawnParticles(hobgoblin.x + hobgoblin.w / 2, hobgoblin.y + 20, 10, 'hit');
      }
      // Ataque em esqueletos
      for (const sk of skeletons) {
        if (!sk.alive || sk.invuln > 0) continue;
        if (aabbOverlap(staffRect, sk)) {
          sk.hp -= 1;
          sk.invuln = 15;
          sk.vx = player.facing * 3;
          sk.vy = -2;
          playSound('hit');
          spawnParticles(sk.x + sk.w / 2, sk.y + 15, 8, 'hit');
          if (sk.hp <= 0) killSkeleton(sk);
        }
      }
      // Ataque em mutantes (mundo de cinzas)
      for (const m of mutants) {
        if (!m.alive || m.invuln > 0) continue;
        if (aabbOverlap(staffRect, m)) {
          m.hp -= 1;
          m.invuln = 12;
          m.vx = player.facing * 4;
          m.vy = -3;
          playSound('hit');
          spawnParticles(m.x + m.w / 2, m.y + 15, 8, 'hit');
          if (m.hp <= 0) {
            m.alive = false;
            score += 15;
            spawnParticles(m.x + m.w / 2, m.y + 20, 12, 'break');
            updateHUD();
          }
        }
      }
      // Ataque no dragão
      if (boneDragon.alive && boneDragon.invuln <= 0 && aabbOverlap(staffRect, boneDragon)) {
        boneDragon.hp -= 1;
        boneDragon.invuln = 20;
        playSound('hit');
        spawnParticles(boneDragon.x + boneDragon.w / 2, boneDragon.y + 30, 12, 'hit');
        score += 5;
        if (boneDragon.hp <= 0) {
          boneDragon.alive = false;
          score += 200;
          playSound('unlock');
          for (let i = 0; i < 3; i++) {
            groundDrops.push({
              x: boneDragon.x + 20 + i * 25,
              y: boneDragon.y + 30,
              w: 16, h: 20, vy: -4 - i, vx: (i - 1) * 2,
              type: 'potion', life: 900, bounce: 0
            });
          }
          showMessage("O Dragão de Osso desaba...\nUma escotilha se abre sob os ossos.");
          setTimeout(() => {
            if (gameState === 'playing') enterAshWorld();
          }, 2200);
        }
        updateHUD();
      }
    }
  }

  // Magia Farpas Mentais (Q)
  if (player.magicCooldown > 0) player.magicCooldown--;
  if (keys.magic && player.magicCooldown <= 0) {
    player.magicCooldown = 90; // ~1.5s
    playSound('magic');
    projectiles.push({
      x: player.x + player.w / 2,
      y: player.y + 16,
      vx: player.facing * 7,
      vy: 0,
      r: 8,
      life: 45,
      type: 'mental'
    });
    spawnParticles(player.x + player.w / 2, player.y + 16, 12, 'magic');
  }

  // Braços de Hadar (E) - desbloqueado após 15 esqueletos
  if (armsCooldown > 0) armsCooldown--;
  if (armsActive > 0) armsActive--;
  if (keys.arms && hasArmsOfHadar && armsCooldown <= 0) {
    armsCooldown = 180; // 3s
    armsActive = 40;  // duração do efeito visual + hit
    playSound('arms');
    spawnParticles(player.x + player.w / 2, player.y + 20, 25, 'magic');
    // Empurra e causa dano em área
    const radius = 70;
    // Hobgoblin
    if (hobgoblin.alive) {
      const dx = hobgoblin.x + hobgoblin.w/2 - (player.x + player.w/2);
      const dy = hobgoblin.y + hobgoblin.h/2 - (player.y + player.h/2);
      if (dx*dx + dy*dy < radius*radius) {
        hobgoblin.vx = (dx > 0 ? 1 : -1) * 8;
        hobgoblin.vy = -5;
        hobgoblin.stunTimer = 30;
        score += 10;
      }
    }
    // Esqueletos
    for (const sk of skeletons) {
      if (!sk.alive) continue;
      const dx = sk.x + sk.w/2 - (player.x + player.w/2);
      const dy = sk.y + sk.h/2 - (player.y + player.h/2);
      if (dx*dx + dy*dy < radius*radius) {
        sk.vx = (dx > 0 ? 1 : -1) * 7;
        sk.vy = -4;
        sk.hp -= 2;
        sk.invuln = 20;
        if (sk.hp <= 0) killSkeleton(sk);
      }
    }
    // Dragão
    if (boneDragon.alive) {
      const dx = boneDragon.x + boneDragon.w/2 - (player.x + player.w/2);
      const dy = boneDragon.y + boneDragon.h/2 - (player.y + player.h/2);
      if (dx*dx + dy*dy < radius*radius) {
        boneDragon.hp -= 3;
        boneDragon.invuln = 30;
        score += 20;
        if (boneDragon.hp <= 0) {
          boneDragon.alive = false;
          score += 200;
          playSound('unlock');
          for (let i = 0; i < 3; i++) {
            groundDrops.push({
              x: boneDragon.x + 20 + i * 25,
              y: boneDragon.y + 30,
              w: 16, h: 20, vy: -4 - i, vx: (i - 1) * 2,
              type: 'potion', life: 900, bounce: 0
            });
          }
          showMessage("O Dragão de Osso desaba...\nUma escotilha se abre sob os ossos.");
          setTimeout(() => {
            if (gameState === 'playing') enterAshWorld();
          }, 2200);
        }
      }
    }
    updateHUD();
  }

  // Invulnerabilidade
  if (player.invuln > 0) player.invuln--;

  // Poeira ao aterrissar
  if (player.onGround && player.wasInAir) {
    spawnParticles(player.x + player.w / 2, player.y + player.h, 8, 'dust');
  }
  player.wasInAir = !player.onGround;

  // Animação simples
  player.animTimer++;
  if (player.animTimer > 8) {
    player.animTimer = 0;
    if (Math.abs(player.vx) > 0.5 && player.onGround) {
      player.animFrame = (player.animFrame + 1) % 4;
    } else {
      player.animFrame = 0;
    }
  }

  // Usar poção (1 ou H)
  if (keys.potion) {
    keys.potion = false; // evita spam
    usePotion();
  }

  // Tutorial de comandos (aparece conforme anda)
  checkTutorialMessages();
}

function updateSkeletons() {
  if (gameState !== 'playing') return;
  for (const sk of skeletons) {
    if (!sk.alive) continue;
    if (sk.invuln > 0) sk.invuln--;

    const dx = player.x - sk.x;
    const dist = Math.abs(dx);

    if (dist < 220) {
      sk.state = 'chase';
      sk.facing = dx > 0 ? 1 : -1;
      sk.vx = sk.facing * sk.speed;
    } else {
      sk.state = 'patrol';
      if (sk.x < sk.patrolLeft) sk.facing = 1;
      if (sk.x > sk.patrolRight) sk.facing = -1;
      sk.vx = sk.facing * sk.speed * 0.6;
    }

    // Ataque fraco
    if (sk.attackCooldown > 0) sk.attackCooldown--;
    if (dist < 40 && sk.attackCooldown <= 0) {
      sk.attackTimer = 10;
      sk.attackCooldown = 45;
    }
    if (sk.attackTimer > 0) {
      sk.attackTimer--;
      if (sk.attackTimer > 3 && sk.attackTimer < 8) {
        const atkX = sk.facing === 1 ? sk.x + sk.w - 2 : sk.x - 18;
        if (aabbOverlap({x: atkX, y: sk.y + 8, w: 20, h: 22}, player) && player.invuln <= 0) {
          takeDamage(1);
        }
      }
    }

    sk.vy += sk.gravity;
    if (sk.vy > sk.maxFall) sk.vy = sk.maxFall;
    resolveCollisions(sk, platforms);

    sk.animTimer++;
    if (sk.animTimer > 8) {
      sk.animTimer = 0;
      sk.animFrame = (sk.animFrame + 1) % 4;
    }
  }
}

function updateBoneDragon() {
  if (!boneDragon.alive || gameState !== 'playing') return;
  if (boneDragon.invuln > 0) boneDragon.invuln--;

  // Ativa quando o jogador se aproxima
  const dx = player.x - boneDragon.x;
  const dist = Math.abs(dx);

  if (dist < 500 && !boneDragon.roarPlayed) {
    boneDragon.roarPlayed = true;
    playSound('dragonRoar');
    showMessage("Um Dragão de Osso desperta no fim da Ruína!");
  }

  if (dist < 400) {
    boneDragon.facing = dx > 0 ? 1 : -1;
    // Ataque de baforada / investida simples
    if (boneDragon.attackCooldown > 0) boneDragon.attackCooldown--;
    if (dist < 120 && boneDragon.attackCooldown <= 0) {
      boneDragon.attackTimer = 30;
      boneDragon.attackCooldown = 90;
    }
  }

  if (boneDragon.attackTimer > 0) {
    boneDragon.attackTimer--;
    // Hitbox grande durante o ataque
    if (boneDragon.attackTimer > 8 && boneDragon.attackTimer < 22) {
      const atkRect = {
        x: boneDragon.facing === 1 ? boneDragon.x + boneDragon.w - 10 : boneDragon.x - 50,
        y: boneDragon.y + 10,
        w: 60,
        h: 50
      };
      if (aabbOverlap(atkRect, player) && player.invuln <= 0) {
        takeDamage(1);
      }
    }
  }

  boneDragon.animTimer++;
  if (boneDragon.animTimer > 10) {
    boneDragon.animTimer = 0;
    boneDragon.animFrame = (boneDragon.animFrame + 1) % 4;
  }
}

function updateHobgoblin() {
  if (!hobgoblin.alive || gameState !== 'playing') return;

  // Stun
  if (hobgoblin.stunTimer > 0) {
    hobgoblin.stunTimer--;
    hobgoblin.vx *= 0.8;
    hobgoblin.state = 'stunned';
  } else {
    // IA simples
    const dx = player.x - hobgoblin.x;
    const dist = Math.abs(dx);

    if (dist < 280) {
      hobgoblin.state = 'chase';
      hobgoblin.facing = dx > 0 ? 1 : -1;
      hobgoblin.vx = hobgoblin.facing * hobgoblin.speed * 1.15; // ataca rápido
    } else {
      hobgoblin.state = 'patrol';
      if (hobgoblin.x < hobgoblin.patrolLeft) hobgoblin.facing = 1;
      if (hobgoblin.x > hobgoblin.patrolRight) hobgoblin.facing = -1;
      hobgoblin.vx = hobgoblin.facing * hobgoblin.speed * 0.7;
    }

    // Ataque corpo a corpo rápido
    if (hobgoblin.attackCooldown > 0) hobgoblin.attackCooldown--;
    if (dist < hobgoblin.attackRange && hobgoblin.attackCooldown <= 0 && hobgoblin.stunTimer <= 0) {
      hobgoblin.attackTimer = 12;
      hobgoblin.attackCooldown = 28; // ataca bem rápido
    }
  }

  if (hobgoblin.attackTimer > 0) {
    hobgoblin.attackTimer--;
    // Hitbox de ataque
    if (hobgoblin.attackTimer > 4 && hobgoblin.attackTimer < 10) {
      const atkX = hobgoblin.facing === 1 ? hobgoblin.x + hobgoblin.w - 4 : hobgoblin.x - 24;
      const atkRect = { x: atkX, y: hobgoblin.y + 10, w: 28, h: 28 };
      if (aabbOverlap(atkRect, player) && player.invuln <= 0) {
        takeDamage(1);
      }
    }
  }

  // Física
  hobgoblin.vy += hobgoblin.gravity;
  if (hobgoblin.vy > hobgoblin.maxFall) hobgoblin.vy = hobgoblin.maxFall;
  resolveCollisions(hobgoblin, platforms);

  // Animação
  hobgoblin.animTimer++;
  if (hobgoblin.animTimer > 7) {
    hobgoblin.animTimer = 0;
    hobgoblin.animFrame = (hobgoblin.animFrame + 1) % 4;
  }
}

function updateProjectiles() {
  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life--;

    // Rastro de partículas mágicas enquanto voa
    if (p.life % 3 === 0) {
      spawnParticles(p.x, p.y, 2, 'magic');
    }

    // Colisão com hobgoblin
    if (hobgoblin.alive && circleRectOverlap(p.x, p.y, p.r, hobgoblin)) {
      if (p.type === 'mental') {
        hobgoblin.stunTimer = 60;
        hobgoblin.vx = 0;
        score += 15;
        updateHUD();
        playSound('stun');
        spawnParticles(hobgoblin.x + hobgoblin.w / 2, hobgoblin.y + 18, 22, 'break');
        spawnParticles(hobgoblin.x + hobgoblin.w / 2, hobgoblin.y + 18, 14, 'stun');
        spawnParticles(hobgoblin.x + hobgoblin.w / 2, hobgoblin.y + 18, 8, 'magic');
      }
      // Magia também afeta esqueletos
      for (const sk of skeletons) {
        if (!sk.alive) continue;
        if (circleRectOverlap(p.x, p.y, p.r, sk)) {
          sk.hp -= 1;
          sk.invuln = 20;
          sk.vx = p.vx > 0 ? 3 : -3;
          playSound('stun');
          spawnParticles(sk.x + sk.w / 2, sk.y + 15, 10, 'stun');
          if (sk.hp <= 0) killSkeleton(sk);
          projectiles.splice(i, 1);
          break;
        }
      }
      projectiles.splice(i, 1);
      continue;
    }

    // Fora da tela ou acabou a vida
    if (p.life <= 0 || p.x < cameraX - 50 || p.x > cameraX + W + 50) {
      projectiles.splice(i, 1);
    }
  }
}

function updateCoins() {
  for (const c of coins) {
    if (c.collected) continue;
    if (circleRectOverlap(c.x, c.y, c.r, player)) {
      c.collected = true;
      score += 10;
      updateHUD();
      playSound('coin');
      spawnParticles(c.x, c.y, 14, 'coin');
    }
  }
}

function updateNote() {
  if (note.collected) return;
  if (aabbOverlap(player, note)) {
    note.collected = true;
    score += 100;
    updateHUD();
    playSound('unlock');
    showMessage("Você encontrou um bilhete antigo!\n\"Há uma ruína escondida nas profundezas da floresta...\nO Hobgoblin era apenas o guardião da entrada da vila.\"\n\nSiga para a direita → a Ruína aguarda.");
  }
}

function takeDamage(amount) {
  if (player.invuln > 0) return;
  if (gameState === 'cutscene' || gameState === 'ending') return;
  lives -= amount;
  player.invuln = 90;
  player.vx = -player.facing * 5;
  player.vy = -6;
  updateHUD();
  playSound('damage');
  spawnParticles(player.x + player.w / 2, player.y + player.h / 2, 16, 'damage');
  if (lives <= 0) {
    if (gameState === 'ash') {
      // Morte no mundo de cinzas → revelação do Amon
      startAmonCutscene();
    } else {
      gameState = 'defeat';
      showEndScreen(false);
    }
  }
}

// ============================================================
// MUNDO DE CINZAS + FOLCLORE + AMON
// ============================================================
const ASH_START_X = 5200;
const ashPlatforms = [
  { x: 5200, y: 480, w: 2400, h: 60 },
  { x: 5400, y: 380, w: 120, h: 18 },
  { x: 5650, y: 320, w: 100, h: 18 },
  { x: 5900, y: 400, w: 140, h: 18 },
  { x: 6200, y: 340, w: 110, h: 18 },
  { x: 6500, y: 380, w: 160, h: 18 },
  { x: 6800, y: 300, w: 120, h: 18 },
  { x: 7100, y: 420, w: 200, h: 18 }
];

function enterAshWorld() {
  gameState = 'ash';
  ashIntensity = 1;
  ashSpawnTimer = 0;
  mutants.length = 0;
  ashParticles.length = 0;
  player.x = ASH_START_X + 40;
  player.y = 400;
  player.vx = 0;
  player.vy = 0;
  cameraX = ASH_START_X;
  // Garante vidas mínimas para a travessia narrativa
  if (lives < 1) lives = 1;
  updateHUD();
  showMessage("Você cai numa terra de fuligem...\nO céu é negro. Algo se move na cinza.");
  playSound('dragonRoar');
}

function spawnMutant(x) {
  // Tipos inspirados no folclore brasileiro (mutações incompletas)
  const types = ['saci', 'mula', 'cuca', 'curupira', 'boitata'];
  const type = types[Math.floor(Math.random() * types.length)];
  const baseSpeed = 1.2 + ashIntensity * 0.35;
  mutants.push({
    x: x,
    y: 400,
    w: 28,
    h: 42,
    vx: 0,
    vy: 0,
    speed: baseSpeed * (0.8 + Math.random() * 0.5),
    gravity: 0.48,
    maxFall: 12,
    onGround: false,
    facing: -1,
    type,
    hp: 1 + Math.floor(ashIntensity / 2),
    invuln: 0,
    attackCooldown: 0,
    animFrame: 0,
    animTimer: 0,
    alive: true
  });
}

function updateAshWorld() {
  if (gameState !== 'ash') return;

  // Fuligem caindo
  for (let i = 0; i < 3; i++) {
    ashParticles.push({
      x: cameraX + Math.random() * (W + 40) - 20,
      y: -10 - Math.random() * 30,
      vx: (Math.random() - 0.5) * 0.6,
      vy: 0.8 + Math.random() * 1.2,
      size: 1 + Math.random() * 2,
      life: 200 + Math.random() * 100
    });
  }
  for (let i = ashParticles.length - 1; i >= 0; i--) {
    const p = ashParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life--;
    if (p.life <= 0 || p.y > H + 20) ashParticles.splice(i, 1);
  }

  // Intensidade cresce conforme o jogador avança
  const progress = Math.max(0, player.x - ASH_START_X);
  ashIntensity = 1 + progress / 400;

  // Spawn crescente de mutantes à frente
  ashSpawnTimer++;
  const spawnRate = Math.max(25, 90 - ashIntensity * 8);
  if (ashSpawnTimer > spawnRate) {
    ashSpawnTimer = 0;
    const ahead = player.x + W * 0.6 + Math.random() * 200;
    spawnMutant(ahead);
    if (ashIntensity > 3 && Math.random() < 0.4) {
      spawnMutant(player.x - 80 - Math.random() * 100); // também atrás
    }
  }

  // Atualiza mutantes
  const allPlatforms = platforms.concat(ashPlatforms);
  for (const m of mutants) {
    if (!m.alive) continue;
    if (m.invuln > 0) m.invuln--;

    const dx = player.x - m.x;
    m.facing = dx > 0 ? 1 : -1;
    m.vx = m.facing * m.speed;

    if (m.attackCooldown > 0) m.attackCooldown--;
    if (Math.abs(dx) < 36 && Math.abs(player.y - m.y) < 40 && m.attackCooldown <= 0) {
      m.attackCooldown = 40;
      if (player.invuln <= 0) takeDamage(1);
    }

    m.vy += m.gravity;
    if (m.vy > m.maxFall) m.vy = m.maxFall;
    resolveCollisions(m, allPlatforms);

    m.animTimer++;
    if (m.animTimer > 7) {
      m.animTimer = 0;
      m.animFrame = (m.animFrame + 1) % 4;
    }
  }
  // Limpa mortos longe
  for (let i = mutants.length - 1; i >= 0; i--) {
    if (!mutants[i].alive || Math.abs(mutants[i].x - player.x) > 900) {
      mutants.splice(i, 1);
    }
  }

  // Física do player nas plataformas de cinza também
  // (resolveCollisions já usa platforms — precisa incluir ash)
}

function getActivePlatforms() {
  if (gameState === 'ash') return platforms.concat(ashPlatforms);
  return platforms;
}

function startAmonCutscene() {
  gameState = 'cutscene';
  cutscenePhase = 0;
  cutsceneTimer = 0;
  cutsceneText = '';
  endingDistort = 0;
  mutants.length = 0;
  document.getElementById('hud').classList.add('hidden');
  playSound('unlock');
}

function updateCutscene() {
  if (gameState !== 'cutscene' && gameState !== 'ending') return;
  cutsceneTimer++;

  // Fases do diálogo
  // 0: silêncio / figura se aproxima
  // 1: "Eu vou te ajudar..."
  // 2: "Meu nome é Amon."
  // 3: close-up do rosto
  // 4: "Amon... que pode significar... bug."
  // 5: distorção + mensagem final
  if (cutscenePhase === 0 && cutsceneTimer > 60) {
    cutscenePhase = 1;
    cutsceneTimer = 0;
    cutsceneText = 'Uma figura com chapéu de bruxo e monóculo se aproxima da cinza...';
  } else if (cutscenePhase === 1 && cutsceneTimer > 160) {
    cutscenePhase = 2;
    cutsceneTimer = 0;
    cutsceneText = '"Vou te ajudar, mago."\n— Ele ajusta o monóculo. —\n"Meu nome é Amon."';
  } else if (cutscenePhase === 2 && cutsceneTimer > 200) {
    cutscenePhase = 3;
    cutsceneTimer = 0;
    cutsceneText = 'A perspectiva se fecha no rosto dele...';
  } else if (cutscenePhase === 3 && cutsceneTimer > 120) {
    cutscenePhase = 4;
    cutsceneTimer = 0;
    cutsceneText = '"Amon... que pode significar... bug."';
    playSound('stun');
  } else if (cutscenePhase === 4 && cutsceneTimer > 100) {
    cutscenePhase = 5;
    cutsceneTimer = 0;
    gameState = 'ending';
    cutsceneText = 'Bravo mago, sua luta acaba aqui.\nQue sua alma descanse, pois seu corpo não irá.';
    playSound('dragonRoar');
  } else if (cutscenePhase === 5 && cutsceneTimer > 280) {
    // Após a mensagem final, registra como "vitória narrativa" nos stats
    gameState = 'victory';
    recordRunResult(true);
    const overlay = document.getElementById('overlay');
    const title = document.getElementById('endTitle');
    const msg = document.getElementById('endMessage');
    overlay.classList.remove('hidden');
    title.textContent = 'Fim';
    title.style.color = '#c4b5fd';
    msg.textContent = cutsceneText + '\n\nPontuação: ' + score + '\nDificuldade: ' + DIFF[difficulty].label;
  }

  if (gameState === 'ending') {
    endingDistort = Math.min(1, endingDistort + 0.008);
  }
}

function updateGlitches() {
  if (gameState !== 'playing' && gameState !== 'ash') return;
  if (glitchTimer > 0) {
    glitchTimer--;
    return;
  }
  glitchCooldown--;
  if (glitchCooldown <= 0) {
    // Glitch quase imperceptível (~0.4–0.6s)
    glitchTimer = 24 + Math.floor(Math.random() * 12);
    glitchCooldown = 150 + Math.floor(Math.random() * 250);
  }
}

function updateCrowAndRat() {
  crowBlink++;
  // Rato só perto do dragão, quando ele está vivo ou recém derrotado
  if (gameState === 'playing' && player.x > 4500) {
    if (!rat && Math.random() < 0.01) {
      rat = { x: 4700 + Math.random() * 200, y: 460, vx: 1.2 + Math.random(), life: 300 };
    }
  }
  if (rat) {
    rat.x += rat.vx;
    rat.life--;
    if (rat.life <= 0 || rat.x > cameraX + W + 40) rat = null;
  }
}

function killSkeleton(sk) {
  sk.alive = false;
  skeletonKills++;
  score += 20;
  playSound('skeletonDie');
  spawnParticles(sk.x + sk.w / 2, sk.y + sk.h / 2, 14, 'break');

  // Chance de dropar poção
  tryDropPotion(sk.x + sk.w / 2, sk.y + sk.h / 2);

  updateHUD();

  if (skeletonKills >= 15 && !hasArmsOfHadar) {
    hasArmsOfHadar = true;
    playSound('unlock');
    showMessage("✦ BRAÇOS DE HADAR DESBLOQUEADOS! ✦\nPressione E para invocar tentáculos psíquicos em área.\nEmpurra e danifica todos os inimigos próximos.");
  }
}

function tryDropPotion(x, y) {
  const chance = DIFF[difficulty].potionDropChance;
  if (Math.random() < chance) {
    groundDrops.push({
      x: x,
      y: y,
      w: 16,
      h: 20,
      vy: -3,
      vx: (Math.random() - 0.5) * 2,
      type: 'potion',
      life: 600, // some frames before despawn
      bounce: 0
    });
    spawnParticles(x, y, 6, 'heal');
  }
}

function updateGroundDrops() {
  for (let i = groundDrops.length - 1; i >= 0; i--) {
    const d = groundDrops[i];
    d.vy += 0.35;
    d.y += d.vy;
    d.x += d.vx;
    d.vx *= 0.95;
    d.life--;

    // Colisão simples com chão das plataformas
    for (const p of platforms) {
      if (d.x + 8 > p.x && d.x < p.x + p.w && d.y + d.h > p.y && d.y + d.h < p.y + 20 && d.vy > 0) {
        d.y = p.y - d.h;
        d.vy = 0;
        d.vx *= 0.7;
      }
    }

    // Coletar
    if (aabbOverlap(player, d)) {
      if (d.type === 'potion') {
        inventory.potions++;
        playSound('heal');
        spawnParticles(d.x, d.y, 10, 'heal');
        showMessage("Poção de Cura coletada! (Pressione 1 ou H para usar)");
        updateHUD();
      }
      groundDrops.splice(i, 1);
      continue;
    }

    if (d.life <= 0 || d.y > H + 50) {
      groundDrops.splice(i, 1);
    }
  }
}

function usePotion() {
  if (inventory.potions <= 0) return;
  if (lives >= DIFF[difficulty].lives + 2) {
    showMessage("Vidas já estão no máximo!");
    return;
  }
  inventory.potions--;
  lives++;
  playSound('heal');
  spawnParticles(player.x + player.w / 2, player.y + player.h / 2, 18, 'heal');
  showMessage("+1 Vida!");
  updateHUD();
}

/**
 * Função pronta para o futuro: cura o jogador e mostra partículas verdes.
 * Exemplo de uso: healPlayer(1);
 */
function healPlayer(amount = 1) {
  lives = Math.min(lives + amount, DIFF[difficulty].lives + 2);
  updateHUD();
  playSound('heal');
  spawnParticles(player.x + player.w / 2, player.y + player.h / 2, 20, 'heal');
  showMessage(amount === 1 ? '+1 Vida!' : `+${amount} Vidas!`);
}

function updateCamera() {
  const target = player.x - W * 0.35;
  cameraX += (target - cameraX) * 0.12;
  if (cameraX < 0) cameraX = 0;
  if (gameState === 'ash') {
    if (cameraX < ASH_START_X) cameraX = ASH_START_X;
    if (cameraX > 7200) cameraX = 7200;
  } else if (cameraX > 4400) {
    cameraX = 4400;
  }
}

function checkTutorialMessages() {
  if (player.x > 120 && !shownMessages.has('move')) {
    shownMessages.add('move');
    showMessage("← → ou A/D para andar  ·  Espaço para pular");
  }
  if (player.x > 500 && !shownMessages.has('attack')) {
    shownMessages.add('attack');
    showMessage("J ou F = Bastão  ·  Q = Farpas Mentais (atordoa 1s)  ·  1 = Poção");
  }
  if (player.x > 1200 && !shownMessages.has('village')) {
    shownMessages.add('village');
    showMessage("Você chegou à vila...\nUm Hobgoblin guarda o caminho. Cuidado: ele ataca rápido e sem dó!");
  }
  if (player.x > 2000 && !shownMessages.has('search')) {
    shownMessages.add('search');
    showMessage("Vasculhe a área... há algo importante por aqui.");
  }
  if (player.x > 2700 && !shownMessages.has('ruin')) {
    shownMessages.add('ruin');
    showMessage("Entrada da Ruína Antiga.\nEsqueletos fracos guardam o caminho.\nDerrote 15 deles para desbloquear uma nova magia!");
  }
  if (player.x > 4500 && !shownMessages.has('dragon')) {
    shownMessages.add('dragon');
    showMessage("O fim da Ruína... algo grande se move nas sombras.");
  }
}

function showMessage(text) {
  const box = document.getElementById('messageBox');
  box.innerText = text;
  box.classList.remove('hidden');
  messageTimer = 220; // ~3.5s
}

function updateHUD() {
  document.getElementById('scoreValue').textContent = score;
  document.getElementById('livesValue').textContent = lives;
  document.getElementById('potionCount').textContent = inventory.potions;
  const magicEl = document.getElementById('magic');
  if (hasArmsOfHadar) {
    magicEl.innerHTML = `Farpas (Q) · <span style="color:#c77dff">Braços de Hadar (E)</span> · Esqueletos: ${skeletonKills}/15`;
  } else {
    magicEl.innerHTML = `Farpas Mentais (Q) · Esqueletos: ${skeletonKills}/15`;
  }
}

function showEndScreen(victory) {
  const overlay = document.getElementById('overlay');
  const title = document.getElementById('endTitle');
  const msg = document.getElementById('endMessage');
  overlay.classList.remove('hidden');

  const newRecord = recordRunResult(victory);
  const recordLine = newRecord ? '\n★ Novo recorde nesta dificuldade!' : '';

  if (victory) {
    title.textContent = "Vitória!";
    title.style.color = '#7dffa0';
    msg.textContent = `O Dragão de Osso foi derrotado e a Ruína conquistada!\nPontuação final: ${score}\nDificuldade: ${DIFF[difficulty].label}${recordLine}`;
  } else {
    title.textContent = "Derrota";
    title.style.color = '#ff7070';
    msg.textContent = `Você foi derrotado...\nPontuação: ${score}\nDificuldade: ${DIFF[difficulty].label}${recordLine}\nTente novamente!`;
  }
}

document.getElementById('restartBtn').addEventListener('click', resetGame);

function resetGame() {
  const d = DIFF[difficulty];
  score = 0;
  lives = d.lives;
  gameState = 'playing';
  cameraX = 0;
  skeletonKills = 0;
  hasArmsOfHadar = false;
  armsCooldown = 0;
  armsActive = 0;
  inventory.potions = difficulty === 'easy' ? 2 : (difficulty === 'normal' ? 1 : 0);
  groundDrops.length = 0;
  shownMessages.clear();
  messageTimer = 0;
  document.getElementById('messageBox').classList.add('hidden');
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('mainMenu').classList.add('hidden');
  document.getElementById('hud').classList.remove('hidden');

  player.x = 80;
  player.y = 400;
  player.vx = 0;
  player.vy = 0;
  player.facing = 1;
  player.attacking = false;
  player.attackTimer = 0;
  player.attackCooldown = 0;
  player.magicCooldown = 0;
  player.invuln = 0;
  player.wasInAir = false;

  hobgoblin.x = 1550;
  hobgoblin.y = 400;
  hobgoblin.vx = 0;
  hobgoblin.vy = 0;
  hobgoblin.facing = -1;
  hobgoblin.state = 'patrol';
  hobgoblin.stunTimer = 0;
  hobgoblin.attackTimer = 0;
  hobgoblin.attackCooldown = 0;
  hobgoblin.alive = true;
  // Ajusta velocidade do hobgoblin pela dificuldade
  hobgoblin.speed = 2.4 * d.enemySpeedMult;

  applyDifficultyToDragon();
  boneDragon.x = 4750;
  boneDragon.y = 300;
  boneDragon.alive = true;
  boneDragon.invuln = 0;
  boneDragon.attackTimer = 0;
  boneDragon.attackCooldown = 0;
  boneDragon.roarPlayed = false;

  projectiles.length = 0;
  particles.length = 0;
  coins.forEach(c => c.collected = false);
  note.collected = false;
  spawnSkeletons();

  updateHUD();
  showMessage(`Dificuldade: ${d.label} · Vidas: ${lives} · Poções iniciais: ${inventory.potions}`);
}

async function refreshContinueButton() {
  const btn = document.getElementById('continueBtn');
  if (!btn) return;
  const snap = await loadProgressCheckpoint();
  if (snap && snap.player) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

async function refreshRecentRunsUI() {
  const box = document.getElementById('recentRuns');
  if (!box) return;
  const runs = await getRecentRuns(5);
  if (!runs.length) {
    box.innerHTML = '<span style="color:#64748b">Nenhuma partida registrada ainda.</span>';
    return;
  }
  box.innerHTML = runs.map(r => {
    const d = new Date(r.date);
    const when = isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const cls = r.victory ? 'run-win' : 'run-loss';
    const result = r.victory ? 'Vitória' : 'Derrota';
    const diffLabel = DIFF[r.difficulty]?.label || r.difficulty;
    return `<div class="run-line ${cls}">${when} · ${diffLabel} · ${r.score} pts · ${result}</div>`;
  }).join('');
}

function showMainMenu() {
  gameState = 'menu';
  document.getElementById('mainMenu').classList.remove('hidden');
  document.getElementById('hud').classList.add('hidden');
  document.getElementById('overlay').classList.add('hidden');
  document.getElementById('messageBox').classList.add('hidden');
  updateMenuSaveUI();
  applyPreferredDifficulty();
  refreshContinueButton();
  refreshRecentRunsUI();
}

// Menu de dificuldade
document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    difficulty = btn.dataset.diff;
    document.getElementById('diffDesc').textContent = DIFF[difficulty].desc;
    savePreferredDifficulty();
  });
});

document.getElementById('startBtn').addEventListener('click', () => {
  initAudio();
  savePreferredDifficulty();
  clearProgressCheckpoint(); // nova aventura = descarta checkpoint antigo
  resetGame();
});

document.getElementById('continueBtn').addEventListener('click', async () => {
  initAudio();
  const snap = await loadProgressCheckpoint();
  if (snap) {
    await restoreFromCheckpoint(snap);
  }
});

document.getElementById('menuBtn').addEventListener('click', () => {
  showMainMenu();
});

document.getElementById('clearSaveBtn').addEventListener('click', async () => {
  if (confirm('Apagar todos os recordes, histórico e progresso salvos neste navegador?')) {
    await clearSaveData();
    refreshContinueButton();
    refreshRecentRunsUI();
  }
});

// ------------------ Desenho (pixel art simples) ------------------
function drawBackground() {
  // Céu muda conforme a área
  if (cameraX < 2500) {
    // Bosque - céu azul limpo
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#5dade2');
    grad.addColorStop(0.6, '#87ceeb');
    grad.addColorStop(1, '#b8e0f0');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    drawCloud(180 - cameraX * 0.3, 60, 1.2);
    drawCloud(480 - cameraX * 0.25, 90, 0.9);
    drawCloud(780 - cameraX * 0.35, 50, 1.4);
    drawCloud(1100 - cameraX * 0.2, 80, 1.0);

    for (let i = 0; i < 14; i++) {
      const tx = i * 220 - cameraX * 0.5;
      drawTree(tx, 320, 0.7 + (i % 3) * 0.15);
    }
  } else {
    // Ruína - céu sombrio
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#1a1a2e');
    grad.addColorStop(0.5, '#16213e');
    grad.addColorStop(1, '#0f3460');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    // Lua
    ctx.fillStyle = '#f5f5f5';
    ctx.beginPath();
    ctx.arc(W - 120, 70, 35, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    ctx.beginPath();
    ctx.arc(W - 105, 60, 30, 0, Math.PI * 2);
    ctx.fill();

    // Pilares / ruínas de fundo
    ctx.fillStyle = '#2c3e50';
    for (let i = 0; i < 10; i++) {
      const px = 3000 + i * 200 - cameraX * 0.4;
      ctx.fillRect(px, 200, 30, 280);
      ctx.fillRect(px - 10, 190, 50, 15);
    }
  }
}

function drawCloud(x, y, scale) {
  ctx.beginPath();
  ctx.arc(x, y, 22 * scale, 0, Math.PI * 2);
  ctx.arc(x + 25 * scale, y - 8 * scale, 28 * scale, 0, Math.PI * 2);
  ctx.arc(x + 55 * scale, y, 20 * scale, 0, Math.PI * 2);
  ctx.arc(x + 30 * scale, y + 10 * scale, 18 * scale, 0, Math.PI * 2);
  ctx.fill();
}

function drawTree(x, y, scale) {
  // Tronco
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(x + 18 * scale, y, 14 * scale, 160 * scale);
  // Copa
  ctx.fillStyle = '#2e7d32';
  ctx.beginPath();
  ctx.arc(x + 25 * scale, y - 10 * scale, 40 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#388e3c';
  ctx.beginPath();
  ctx.arc(x + 10 * scale, y + 20 * scale, 32 * scale, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x + 42 * scale, y + 25 * scale, 30 * scale, 0, Math.PI * 2);
  ctx.fill();
}

function drawPlatforms() {
  for (const p of platforms) {
    const sx = p.x - cameraX;
    if (sx + p.w < 0 || sx > W) continue;

    // Terra
    ctx.fillStyle = '#6b4f2a';
    ctx.fillRect(sx, p.y, p.w, p.h);
    // Grama no topo
    ctx.fillStyle = '#4caf50';
    ctx.fillRect(sx, p.y, p.w, 8);
    // Detalhe de pixel
    ctx.fillStyle = '#388e3c';
    for (let i = 0; i < p.w; i += 12) {
      ctx.fillRect(sx + i, p.y, 6, 4);
    }
  }
}

function drawPlayer() {
  const sx = player.x - cameraX;
  const sy = player.y;

  if (player.invuln > 0 && Math.floor(player.invuln / 4) % 2 === 0) return;

  ctx.save();
  if (player.facing === -1) {
    ctx.translate(sx + player.w / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-(sx + player.w / 2), 0);
  }

  // Sombra
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(sx + 14, sy + 44, 12, 4, 0, 0, Math.PI * 2);
  ctx.fill();

  // Túnica (mais detalhada)
  ctx.fillStyle = '#303f9f';
  ctx.fillRect(sx + 3, sy + 14, 22, 26);
  // Detalhe da túnica
  ctx.fillStyle = '#1a237e';
  ctx.fillRect(sx + 5, sy + 16, 18, 4);
  ctx.fillRect(sx + 8, sy + 28, 12, 8);

  // Capa
  ctx.fillStyle = '#1a237e';
  ctx.fillRect(sx + 1, sy + 16, 5, 22);
  ctx.fillRect(sx + 22, sy + 16, 5, 18);

  // Cabeça
  ctx.fillStyle = '#ffcc80';
  ctx.fillRect(sx + 6, sy + 2, 16, 14);
  // Orelhas
  ctx.fillRect(sx + 4, sy + 6, 3, 5);
  ctx.fillRect(sx + 21, sy + 6, 3, 5);

  // Chapéu pontudo melhorado
  ctx.fillStyle = '#0d1b4a';
  ctx.beginPath();
  ctx.moveTo(sx + 2, sy + 8);
  ctx.lineTo(sx + 14, sy - 16);
  ctx.lineTo(sx + 26, sy + 8);
  ctx.closePath();
  ctx.fill();
  // Brilho do chapéu
  ctx.fillStyle = '#283593';
  ctx.beginPath();
  ctx.moveTo(sx + 8, sy + 2);
  ctx.lineTo(sx + 14, sy - 12);
  ctx.lineTo(sx + 16, sy + 2);
  ctx.closePath();
  ctx.fill();
  // Faixa dourada
  ctx.fillStyle = '#ffd700';
  ctx.fillRect(sx + 4, sy + 4, 20, 3);
  // Estrela no chapéu
  ctx.fillStyle = '#fff59d';
  ctx.fillRect(sx + 12, sy - 8, 4, 4);

  // Olhos expressivos
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(sx + 9, sy + 7, 3, 4);
  ctx.fillRect(sx + 16, sy + 7, 3, 4);
  // Brilho nos olhos
  ctx.fillStyle = '#fff';
  ctx.fillRect(sx + 10, sy + 7, 1, 1);
  ctx.fillRect(sx + 17, sy + 7, 1, 1);

  // Braço
  ctx.fillStyle = '#ffcc80';
  ctx.fillRect(sx + 23, sy + 16, 6, 12);

  // Bastão detalhado
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(sx + 27, sy + 4, 5, 34);
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(sx + 28, sy + 6, 3, 30);
  // Cristal mágico
  ctx.fillStyle = '#40c4ff';
  ctx.beginPath();
  ctx.moveTo(sx + 29.5, sy - 2);
  ctx.lineTo(sx + 25, sy + 6);
  ctx.lineTo(sx + 29.5, sy + 10);
  ctx.lineTo(sx + 34, sy + 6);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#e1f5fe';
  ctx.fillRect(sx + 28, sy + 2, 3, 3);

  // Pernas
  ctx.fillStyle = '#1a237e';
  if (player.animFrame % 2 === 0) {
    ctx.fillRect(sx + 5, sy + 38, 8, 6);
    ctx.fillRect(sx + 15, sy + 38, 8, 6);
  } else {
    ctx.fillRect(sx + 4, sy + 38, 8, 6);
    ctx.fillRect(sx + 16, sy + 38, 8, 6);
  }
  // Sapatos
  ctx.fillStyle = '#3e2723';
  ctx.fillRect(sx + 4, sy + 42, 9, 3);
  ctx.fillRect(sx + 15, sy + 42, 9, 3);

  // Efeito de ataque do bastão
  if (player.attacking) {
    ctx.fillStyle = 'rgba(255, 220, 80, 0.75)';
    ctx.beginPath();
    ctx.arc(sx + 40, sy + 18, 14, 0, Math.PI * 2);
    ctx.fill();
  }

  // Visual dos Braços de Hadar
  if (armsActive > 0) {
    const pulse = armsActive / 40;
    ctx.strokeStyle = `rgba(180, 100, 255, ${0.6 * pulse})`;
    ctx.lineWidth = 3;
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2 + (40 - armsActive) * 0.15;
      const len = 50 + Math.sin(armsActive * 0.3 + i) * 10;
      ctx.beginPath();
      ctx.moveTo(sx + 14, sy + 22);
      ctx.quadraticCurveTo(
        sx + 14 + Math.cos(angle) * len * 0.5,
        sy + 22 + Math.sin(angle) * len * 0.5 - 15,
        sx + 14 + Math.cos(angle) * len,
        sy + 22 + Math.sin(angle) * len
      );
      ctx.stroke();
      // Ponta do tentáculo
      ctx.fillStyle = `rgba(200, 120, 255, ${0.8 * pulse})`;
      ctx.beginPath();
      ctx.arc(sx + 14 + Math.cos(angle) * len, sy + 22 + Math.sin(angle) * len, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawHobgoblin() {
  if (!hobgoblin.alive) return;
  const sx = hobgoblin.x - cameraX;
  const sy = hobgoblin.y;
  if (sx < -50 || sx > W + 50) return;

  ctx.save();
  if (hobgoblin.facing === -1) {
    ctx.translate(sx + hobgoblin.w / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-(sx + hobgoblin.w / 2), 0);
  }

  // Sombra
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(sx + 18, sy + 50, 16, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  const bodyColor = hobgoblin.stunTimer > 0 ? '#90a4ae' : '#6d4c41';
  const headColor = hobgoblin.stunTimer > 0 ? '#b0bec5' : '#8d6e63';

  // Corpo
  ctx.fillStyle = bodyColor;
  ctx.fillRect(sx + 4, sy + 16, 28, 26);
  // Músculos
  ctx.fillStyle = hobgoblin.stunTimer > 0 ? '#78909c' : '#5d4037';
  ctx.fillRect(sx + 8, sy + 20, 8, 10);
  ctx.fillRect(sx + 20, sy + 20, 8, 10);

  // Cabeça
  ctx.fillStyle = headColor;
  ctx.fillRect(sx + 6, sy + 2, 24, 18);

  // Orelhas pontudas
  ctx.fillStyle = '#4e342e';
  ctx.beginPath();
  ctx.moveTo(sx + 4, sy + 8);
  ctx.lineTo(sx - 6, sy - 4);
  ctx.lineTo(sx + 10, sy + 5);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sx + 32, sy + 8);
  ctx.lineTo(sx + 42, sy - 4);
  ctx.lineTo(sx + 26, sy + 5);
  ctx.fill();

  // Olhos
  ctx.fillStyle = hobgoblin.stunTimer > 0 ? '#ffeb3b' : '#e53935';
  ctx.fillRect(sx + 10, sy + 7, 5, 5);
  ctx.fillRect(sx + 21, sy + 7, 5, 5);
  // Pupilas
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(sx + 12, sy + 9, 2, 2);
  ctx.fillRect(sx + 23, sy + 9, 2, 2);

  // Presas
  ctx.fillStyle = '#efebe9';
  ctx.fillRect(sx + 12, sy + 15, 3, 4);
  ctx.fillRect(sx + 21, sy + 15, 3, 4);

  // Braços
  ctx.fillStyle = bodyColor;
  ctx.fillRect(sx - 5, sy + 17, 11, 15);
  ctx.fillRect(sx + 30, sy + 17, 11, 15);
  // Mãos
  ctx.fillStyle = headColor;
  ctx.fillRect(sx - 6, sy + 30, 10, 6);
  ctx.fillRect(sx + 32, sy + 30, 10, 6);

  // Pernas
  ctx.fillStyle = '#4e342e';
  if (hobgoblin.animFrame % 2 === 0) {
    ctx.fillRect(sx + 6, sy + 40, 10, 10);
    ctx.fillRect(sx + 20, sy + 40, 10, 10);
  } else {
    ctx.fillRect(sx + 4, sy + 40, 10, 10);
    ctx.fillRect(sx + 22, sy + 40, 10, 10);
  }

  if (hobgoblin.stunTimer > 0) {
    ctx.fillStyle = '#ffeb3b';
    ctx.font = 'bold 13px monospace';
    ctx.fillText('STUN', sx + 4, sy - 8);
  }
  if (hobgoblin.attackTimer > 4 && hobgoblin.attackTimer < 10) {
    ctx.fillStyle = 'rgba(255, 60, 30, 0.75)';
    ctx.beginPath();
    ctx.arc(sx + 42, sy + 22, 16, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawSkeletons() {
  for (const sk of skeletons) {
    if (!sk.alive) continue;
    const sx = sk.x - cameraX;
    if (sx < -40 || sx > W + 40) continue;
    const sy = sk.y;

    ctx.save();
    if (sk.facing === -1) {
      ctx.translate(sx + sk.w / 2, 0);
      ctx.scale(-1, 1);
      ctx.translate(-(sx + sk.w / 2), 0);
    }

    // Sombra
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(sx + 13, sy + 42, 11, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // Corpo (ossos)
    ctx.fillStyle = sk.invuln > 0 ? '#ffe0b2' : '#e0e0e0';
    // Costela / torso
    ctx.fillRect(sx + 6, sy + 14, 14, 18);
    // Detalhes de ossos
    ctx.fillStyle = sk.invuln > 0 ? '#ffcc80' : '#bdbdbd';
    ctx.fillRect(sx + 8, sy + 16, 10, 2);
    ctx.fillRect(sx + 8, sy + 20, 10, 2);
    ctx.fillRect(sx + 8, sy + 24, 10, 2);

    // Cabeça (crânio)
    ctx.fillStyle = sk.invuln > 0 ? '#ffe0b2' : '#f5f5f5';
    ctx.fillRect(sx + 5, sy + 1, 16, 14);
    // Olhos escuros
    ctx.fillStyle = '#212121';
    ctx.fillRect(sx + 8, sy + 5, 4, 5);
    ctx.fillRect(sx + 15, sy + 5, 4, 5);
    // Nariz triangular
    ctx.fillStyle = '#424242';
    ctx.beginPath();
    ctx.moveTo(sx + 13, sy + 10);
    ctx.lineTo(sx + 11, sy + 13);
    ctx.lineTo(sx + 15, sy + 13);
    ctx.fill();

    // Braços ósseos
    ctx.fillStyle = '#e0e0e0';
    ctx.fillRect(sx + 1, sy + 15, 5, 14);
    ctx.fillRect(sx + 20, sy + 15, 5, 14);

    // Pernas
    ctx.fillStyle = '#bdbdbd';
    if (sk.animFrame % 2 === 0) {
      ctx.fillRect(sx + 6, sy + 32, 6, 10);
      ctx.fillRect(sx + 14, sy + 32, 6, 10);
    } else {
      ctx.fillRect(sx + 5, sy + 32, 6, 10);
      ctx.fillRect(sx + 15, sy + 32, 6, 10);
    }

    // Ataque
    if (sk.attackTimer > 3 && sk.attackTimer < 8) {
      ctx.fillStyle = 'rgba(200, 200, 200, 0.6)';
      ctx.fillRect(sx + 22, sy + 12, 16, 14);
    }

    ctx.restore();
  }
}

function drawBoneDragon() {
  if (!boneDragon.alive) return;
  const sx = boneDragon.x - cameraX;
  if (sx < -100 || sx > W + 100) return;
  const sy = boneDragon.y;

  ctx.save();
  if (boneDragon.facing === -1) {
    ctx.translate(sx + boneDragon.w / 2, 0);
    ctx.scale(-1, 1);
    ctx.translate(-(sx + boneDragon.w / 2), 0);
  }

  // Sombra grande
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(sx + 45, sy + 75, 40, 8, 0, 0, Math.PI * 2);
  ctx.fill();

  const boneCol = boneDragon.invuln > 0 ? '#fff8e1' : '#eceff1';
  const darkBone = boneDragon.invuln > 0 ? '#ffe0b2' : '#90a4ae';

  // Corpo principal
  ctx.fillStyle = boneCol;
  ctx.fillRect(sx + 15, sy + 25, 55, 35);
  // Costelas
  ctx.fillStyle = darkBone;
  for (let i = 0; i < 4; i++) {
    ctx.fillRect(sx + 20 + i * 12, sy + 28, 3, 25);
  }

  // Pescoço
  ctx.fillStyle = boneCol;
  ctx.fillRect(sx + 55, sy + 15, 20, 18);

  // Cabeça de dragão ósseo
  ctx.fillStyle = boneCol;
  ctx.fillRect(sx + 65, sy + 5, 28, 22);
  // Chifres
  ctx.fillStyle = darkBone;
  ctx.beginPath();
  ctx.moveTo(sx + 70, sy + 5);
  ctx.lineTo(sx + 68, sy - 12);
  ctx.lineTo(sx + 76, sy + 5);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(sx + 85, sy + 5);
  ctx.lineTo(sx + 90, sy - 14);
  ctx.lineTo(sx + 80, sy + 5);
  ctx.fill();
  // Olhos vermelhos brilhantes
  ctx.fillStyle = '#ff1744';
  ctx.fillRect(sx + 72, sy + 10, 6, 6);
  ctx.fillRect(sx + 82, sy + 10, 6, 6);
  ctx.fillStyle = '#ff8a80';
  ctx.fillRect(sx + 73, sy + 11, 2, 2);
  ctx.fillRect(sx + 83, sy + 11, 2, 2);
  // Mandíbula
  ctx.fillStyle = darkBone;
  ctx.fillRect(sx + 68, sy + 22, 24, 6);

  // Asas ósseas
  ctx.fillStyle = boneCol;
  ctx.beginPath();
  ctx.moveTo(sx + 25, sy + 28);
  ctx.lineTo(sx + 5, sy - 5);
  ctx.lineTo(sx + 15, sy + 20);
  ctx.lineTo(sx + 0, sy + 15);
  ctx.lineTo(sx + 20, sy + 35);
  ctx.fill();
  // Membrana da asa
  ctx.fillStyle = 'rgba(120, 144, 156, 0.4)';
  ctx.beginPath();
  ctx.moveTo(sx + 25, sy + 28);
  ctx.lineTo(sx + 5, sy - 5);
  ctx.lineTo(sx + 20, sy + 35);
  ctx.fill();

  // Pernas
  ctx.fillStyle = darkBone;
  ctx.fillRect(sx + 20, sy + 55, 12, 18);
  ctx.fillRect(sx + 45, sy + 55, 12, 18);
  // Garras
  ctx.fillStyle = '#546e7a';
  ctx.fillRect(sx + 18, sy + 70, 16, 4);
  ctx.fillRect(sx + 43, sy + 70, 16, 4);

  // Cauda
  ctx.fillStyle = boneCol;
  ctx.beginPath();
  ctx.moveTo(sx + 15, sy + 40);
  ctx.lineTo(sx - 20, sy + 50);
  ctx.lineTo(sx + 10, sy + 55);
  ctx.fill();

  // Barra de HP do boss
  const hpPct = boneDragon.hp / boneDragon.maxHp;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(sx + 10, sy - 18, 70, 10);
  ctx.fillStyle = hpPct > 0.3 ? '#ff1744' : '#ff5252';
  ctx.fillRect(sx + 12, sy - 16, 66 * hpPct, 6);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.strokeRect(sx + 10, sy - 18, 70, 10);

  // Ataque visual
  if (boneDragon.attackTimer > 8 && boneDragon.attackTimer < 22) {
    ctx.fillStyle = 'rgba(255, 50, 50, 0.5)';
    ctx.beginPath();
    ctx.arc(sx + 100, sy + 25, 30, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawCoins() {
  for (const c of coins) {
    if (c.collected) continue;
    const sx = c.x - cameraX;
    if (sx < -20 || sx > W + 20) continue;

    // Moeda pixel
    ctx.fillStyle = '#ffd700';
    ctx.beginPath();
    ctx.arc(sx, c.y, c.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffecb3';
    ctx.beginPath();
    ctx.arc(sx - 2, c.y - 2, c.r * 0.45, 0, Math.PI * 2);
    ctx.fill();
    // Brilho
    ctx.fillStyle = '#fff9c4';
    ctx.fillRect(sx - 3, c.y - 5, 3, 3);
  }
}

function drawNote() {
  if (note.collected) return;
  const sx = note.x - cameraX;
  if (sx < -40 || sx > W + 40) return;

  // Aura de brilho pulsante
  const pulse = 0.4 + 0.3 * Math.sin(Date.now() / 300);
  ctx.fillStyle = `rgba(255, 240, 150, ${pulse * 0.35})`;
  ctx.beginPath();
  ctx.arc(sx + note.w / 2, note.y + note.h / 2, 28 + pulse * 8, 0, Math.PI * 2);
  ctx.fill();

  // Papel
  ctx.fillStyle = '#f5e6c8';
  ctx.fillRect(sx, note.y, note.w, note.h);
  // Borda
  ctx.strokeStyle = '#d4c4a0';
  ctx.lineWidth = 2;
  ctx.strokeRect(sx, note.y, note.w, note.h);
  // Texto riscado
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(sx + 4, note.y + 5, 20, 2);
  ctx.fillRect(sx + 4, note.y + 10, 16, 2);
  ctx.fillRect(sx + 4, note.y + 15, 18, 2);
  // Brilho superior
  ctx.fillStyle = 'rgba(255,255,200,0.55)';
  ctx.fillRect(sx, note.y, note.w, 4);
}

function drawProjectiles() {
  for (const p of projectiles) {
    const sx = p.x - cameraX;
    // Farpas mentais (azul elétrico)
    ctx.fillStyle = '#80d8ff';
    ctx.beginPath();
    ctx.arc(sx, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e1f5fe';
    ctx.beginPath();
    ctx.arc(sx - 2, p.y - 2, p.r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    // Trail
    ctx.fillStyle = 'rgba(100, 200, 255, 0.4)';
    ctx.beginPath();
    ctx.arc(sx - p.vx * 0.6, p.y, p.r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawForeground() {
  // Grama decorativa na frente
  ctx.fillStyle = '#2e7d32';
  for (let i = 0; i < 40; i++) {
    const gx = (i * 70 - cameraX * 1.1) % (W + 100) - 50;
    ctx.fillRect(gx, 470, 4, 12);
    ctx.fillRect(gx + 6, 475, 3, 8);
  }
}

// ------------------ Loop principal ------------------
// Controle de folhas ambientais
let leafSpawnTimer = 0;

function updateAmbientLeaves() {
  // Só gera folhas na área do bosque (antes da vila)
  if (cameraX < 1300) {
    leafSpawnTimer++;
    if (leafSpawnTimer > 8) { // a cada ~8 frames
      leafSpawnTimer = 0;
      // Spawna uma folha em posição aleatória acima da tela, na área visível
      const lx = cameraX + Math.random() * (W + 100) - 50;
      const ly = -20 - Math.random() * 40;
      spawnParticles(lx, ly, 1, 'leaf');
    }
  }
}

function updateNoteGlow() {
  // Brilho constante no bilhete (enquanto não coletado)
  if (!note.collected && gameState === 'playing') {
    // A cada alguns frames cria uma partícula de glow
    if (Math.random() < 0.25) {
      const gx = note.x + note.w / 2 + (Math.random() - 0.5) * 20;
      const gy = note.y + note.h / 2 + (Math.random() - 0.5) * 14;
      spawnParticles(gx, gy, 1, 'glow');
    }
  }
}

function update() {
  if (gameState === 'playing') {
    updatePlayer();
    updateHobgoblin();
    updateSkeletons();
    updateBoneDragon();
    updateProjectiles();
    updateCoins();
    updateNote();
    updateCamera();
    updateAmbientLeaves();
    updateNoteGlow();
    updateGroundDrops();
    updateCrowAndRat();
    updateGlitches();
  } else if (gameState === 'ash') {
    updatePlayer();
    updateProjectiles();
    updateCamera();
    updateGroundDrops();
    updateAshWorld();
    updateGlitches();
  } else if (gameState === 'cutscene' || gameState === 'ending') {
    updateCutscene();
  }

  if (messageTimer > 0) {
    messageTimer--;
    if (messageTimer <= 0) {
      document.getElementById('messageBox').classList.add('hidden');
    }
  }
  updateParticles();
}

function drawGroundDrops() {
  for (const d of groundDrops) {
    const sx = d.x - cameraX;
    if (sx < -20 || sx > W + 20) continue;

    if (d.type === 'potion') {
      ctx.fillStyle = '#4ade80';
      ctx.fillRect(sx + 4, d.y + 6, 8, 12);
      ctx.fillStyle = '#86efac';
      ctx.fillRect(sx + 6, d.y + 2, 4, 5);
      ctx.fillStyle = '#a3e635';
      ctx.fillRect(sx + 5, d.y, 6, 3);
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillRect(sx + 5, d.y + 8, 3, 4);
      ctx.fillStyle = 'rgba(0,0,0,0.2)';
      ctx.fillRect(sx + 3, d.y + 18, 10, 3);
    }
  }
}

function drawCrow() {
  // Corvo com monóculo numa árvore perto do Hobgoblin (~x 1480)
  const treeX = 1480;
  const sx = treeX - cameraX;
  if (sx < -40 || sx > W + 40) return;
  if (cameraX > 2500) return; // só no bosque/vila

  const cy = 250;
  // Corpo
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(sx + 8, cy, 16, 12);
  // Cabeça
  ctx.fillRect(sx + 18, cy - 6, 10, 10);
  // Bico
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(sx + 28, cy - 2, 6, 3);
  // Asa
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(sx + 6, cy + 2, 10, 8);
  // Pés
  ctx.fillStyle = '#f59e0b';
  ctx.fillRect(sx + 10, cy + 12, 3, 5);
  ctx.fillRect(sx + 18, cy + 12, 3, 5);
  // Monóculo (dourado)
  ctx.strokeStyle = '#fbbf24';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(sx + 24, cy - 2, 3.5, 0, Math.PI * 2);
  ctx.stroke();
  // Brilho do monóculo / piscar
  if (Math.floor(crowBlink / 40) % 7 !== 0) {
    ctx.fillStyle = '#60a5fa';
    ctx.fillRect(sx + 23, cy - 3, 2, 2);
  }
  // Corrente do monóculo
  ctx.strokeStyle = '#a8a29e';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(sx + 27, cy + 1);
  ctx.lineTo(sx + 30, cy + 8);
  ctx.stroke();
}

function drawRat() {
  if (!rat) return;
  const sx = rat.x - cameraX;
  if (sx < -20 || sx > W + 20) return;
  ctx.fillStyle = '#57534e';
  ctx.fillRect(sx, rat.y, 14, 8);
  ctx.fillRect(sx + 12, rat.y - 2, 6, 6); // cabeça
  ctx.fillStyle = '#a8a29e';
  ctx.fillRect(sx - 6, rat.y + 2, 8, 2); // cauda
  ctx.fillStyle = '#fbbf24';
  ctx.fillRect(sx + 16, rat.y, 3, 2); // focinho
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(sx + 14, rat.y - 1, 2, 2); // olho
}

function drawMutants() {
  for (const m of mutants) {
    if (!m.alive) continue;
    const sx = m.x - cameraX;
    if (sx < -40 || sx > W + 40) continue;
    const sy = m.y;

    ctx.save();
    if (m.facing === -1) {
      ctx.translate(sx + m.w / 2, 0);
      ctx.scale(-1, 1);
      ctx.translate(-(sx + m.w / 2), 0);
    }

    // Cores por tipo folclórico mutante
    let body = '#6b7280', accent = '#9ca3af', eye = '#ef4444';
    if (m.type === 'saci') { body = '#78350f'; accent = '#dc2626'; eye = '#fbbf24'; }
    else if (m.type === 'mula') { body = '#1c1917'; accent = '#7f1d1d'; eye = '#f97316'; }
    else if (m.type === 'cuca') { body = '#365314'; accent = '#a3e635'; eye = '#eab308'; }
    else if (m.type === 'curupira') { body = '#14532d'; accent = '#f97316'; eye = '#22c55e'; }
    else if (m.type === 'boitata') { body = '#1e3a5f'; accent = '#fbbf24'; eye = '#fde047'; }

    if (m.invuln > 0) body = '#d1d5db';

    // Silhueta humanoide distorcida
    ctx.fillStyle = body;
    ctx.fillRect(sx + 6, sy + 12, 16, 22);
    ctx.fillRect(sx + 8, sy + 2, 12, 12); // cabeça
    // Braços tortos
    ctx.fillStyle = accent;
    ctx.fillRect(sx + 1, sy + 14, 6, 14);
    ctx.fillRect(sx + 21, sy + 14, 6, 14);
    // Pernas
    ctx.fillStyle = body;
    if (m.animFrame % 2 === 0) {
      ctx.fillRect(sx + 7, sy + 32, 6, 10);
      ctx.fillRect(sx + 15, sy + 32, 6, 10);
    } else {
      ctx.fillRect(sx + 5, sy + 32, 6, 10);
      ctx.fillRect(sx + 17, sy + 32, 6, 10);
    }
    // Olhos
    ctx.fillStyle = eye;
    ctx.fillRect(sx + 10, sy + 5, 3, 3);
    ctx.fillRect(sx + 16, sy + 5, 3, 3);
    // Detalhe de mutação (chifre / fumaça)
    ctx.fillStyle = accent;
    if (m.type === 'saci' || m.type === 'curupira') {
      ctx.fillRect(sx + 12, sy - 4, 4, 6);
    }
    if (m.type === 'boitata') {
      ctx.fillStyle = 'rgba(250, 204, 21, 0.5)';
      ctx.fillRect(sx + 4, sy + 10, 20, 6);
    }

    ctx.restore();
  }
}

function drawAshWorldExtras() {
  if (gameState !== 'ash' && gameState !== 'cutscene' && gameState !== 'ending') return;

  // Plataformas de cinza
  if (gameState === 'ash') {
    for (const p of ashPlatforms) {
      const sx = p.x - cameraX;
      if (sx + p.w < 0 || sx > W) continue;
      ctx.fillStyle = '#3f3f46';
      ctx.fillRect(sx, p.y, p.w, p.h);
      ctx.fillStyle = '#52525b';
      ctx.fillRect(sx, p.y, p.w, 4);
    }
  }

  // Fuligem
  ctx.fillStyle = 'rgba(120,120,120,0.55)';
  for (const p of ashParticles) {
    const sx = p.x - cameraX;
    ctx.fillRect(sx, p.y, p.size, p.size);
  }

  drawMutants();
}

function drawGlitchOverlay() {
  if (glitchTimer <= 0) return;
  // Glitch sutil: fatias horizontais deslocadas + scanlines rápidas
  const slices = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < slices; i++) {
    const y = Math.random() * H;
    const h = 2 + Math.random() * 8;
    const offset = (Math.random() - 0.5) * 12;
    try {
      const img = ctx.getImageData(0, y, W, h);
      ctx.putImageData(img, offset, y);
    } catch (e) { /* ignore */ }
  }
  // Ruído cromático leve
  ctx.fillStyle = `rgba(255,0,80,${0.03 + Math.random() * 0.04})`;
  ctx.fillRect(0, 0, W, H * 0.15);
  ctx.fillStyle = `rgba(0,200,255,${0.02 + Math.random() * 0.03})`;
  ctx.fillRect(0, H * 0.7, W, H * 0.3);
}

function drawAmonCutscene() {
  if (gameState !== 'cutscene' && gameState !== 'ending') return;

  // Fundo de cinza
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);
  // Fuligem decorativa
  ctx.fillStyle = 'rgba(80,80,80,0.4)';
  for (let i = 0; i < 40; i++) {
    const ax = (i * 97 + cutsceneTimer * 0.5) % W;
    const ay = (i * 53 + cutsceneTimer * 1.2) % H;
    ctx.fillRect(ax, ay, 2, 2);
  }

  if (cutscenePhase < 3) {
    // Silhueta de Amon (terceira pessoa)
    const ax = W / 2 - 30;
    const ay = H / 2 - 20;
    // Manto
    ctx.fillStyle = '#1e1b4b';
    ctx.fillRect(ax + 8, ay + 40, 44, 60);
    // Detalhes azuis no manto
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(ax + 12, ay + 48, 8, 30);
    ctx.fillRect(ax + 40, ay + 48, 8, 30);
    ctx.fillRect(ax + 20, ay + 70, 20, 4);
    // Cabeça
    ctx.fillStyle = '#f5d0b0';
    ctx.fillRect(ax + 16, ay + 18, 28, 28);
    // Chapéu de bruxo
    ctx.fillStyle = '#0f0f0f';
    ctx.beginPath();
    ctx.moveTo(ax + 8, ay + 28);
    ctx.lineTo(ax + 30, ay - 30);
    ctx.lineTo(ax + 52, ay + 28);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(ax + 6, ay + 26, 48, 6);
    // Monóculo
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(ax + 38, ay + 30, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#111';
    ctx.fillRect(ax + 22, ay + 28, 5, 5); // olho esquerdo
    ctx.fillStyle = '#020617';
    ctx.beginPath();
    ctx.arc(ax + 38, ay + 30, 3, 0, Math.PI * 2);
    ctx.fill(); // olho no monóculo (preto)
  } else {
    // Close-up em primeira pessoa do rosto de Amon
    const cx = W / 2;
    const cy = H / 2 - 20;
    // Pele
    ctx.fillStyle = '#f5d0b0';
    ctx.fillRect(cx - 80, cy - 70, 160, 160);
    // Chapéu cobrindo o topo
    ctx.fillStyle = '#0a0a0a';
    ctx.beginPath();
    ctx.moveTo(cx - 100, cy - 40);
    ctx.lineTo(cx, cy - 160);
    ctx.lineTo(cx + 100, cy - 40);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(cx - 110, cy - 48, 220, 16);
    // Olhos pretos
    ctx.fillStyle = '#020617';
    ctx.fillRect(cx - 50, cy - 10, 28, 22);
    ctx.fillRect(cx + 22, cy - 10, 28, 22);
    // Monóculo no olho direito
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx + 36, cy, 22, 0, Math.PI * 2);
    ctx.stroke();
    // Reflexo frio no monóculo
    ctx.fillStyle = 'rgba(96, 165, 250, 0.35)';
    ctx.beginPath();
    ctx.arc(cx + 30, cy - 6, 6, 0, Math.PI * 2);
    ctx.fill();
    // Sorriso fino
    ctx.strokeStyle = '#7c2d12';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 20, cy + 40);
    ctx.quadraticCurveTo(cx, cy + 52, cx + 20, cy + 40);
    ctx.stroke();
  }

  // Texto da cutscene
  if (cutsceneText) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(40, H - 130, W - 80, 100);
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 2;
    ctx.strokeRect(40, H - 130, W - 80, 100);
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '18px Georgia, serif';
    ctx.textAlign = 'center';
    const lines = cutsceneText.split('\n');
    lines.forEach((line, i) => {
      ctx.fillText(line, W / 2, H - 95 + i * 26);
    });
    ctx.textAlign = 'left';
  }

  // Distorção final
  if (endingDistort > 0) {
    const strength = endingDistort * 20;
    for (let i = 0; i < 8; i++) {
      const y = Math.random() * H;
      const h = 4 + Math.random() * 20;
      try {
        const img = ctx.getImageData(0, y, W, h);
        ctx.putImageData(img, (Math.random() - 0.5) * strength, y);
      } catch (e) {}
    }
    ctx.fillStyle = `rgba(99, 102, 241, ${endingDistort * 0.25})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function draw() {
  ctx.clearRect(0, 0, W, H);

  if (gameState === 'cutscene' || gameState === 'ending') {
    drawAmonCutscene();
    return;
  }

  if (gameState === 'ash') {
    // Céu preto + terra cinza
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 300, 0, H);
    g.addColorStop(0, '#1a1a1a');
    g.addColorStop(1, '#3f3f46');
    ctx.fillStyle = g;
    ctx.fillRect(0, 400, W, H - 400);
    drawAshWorldExtras();
    drawGroundDrops();
    drawPlayer();
    drawProjectiles();
    drawParticles();
    drawGlitchOverlay();
    return;
  }

  // Mundo normal
  drawBackground();
  drawPlatforms();
  drawCoins();
  drawNote();
  drawGroundDrops();
  drawSkeletons();
  drawHobgoblin();
  drawCrow();
  drawBoneDragon();
  drawRat();
  drawPlayer();
  drawProjectiles();
  drawParticles();
  drawForeground();
  drawGlitchOverlay();
}

function gameLoop() {
  update();
  draw();
  requestAnimationFrame(gameLoop);
}

// Iniciar: abre IndexedDB + localStorage, depois mostra o menu
initStorage().then(() => {
  showMainMenu();
}).catch(err => {
  console.warn('Falha no initStorage:', err);
  showMainMenu();
});
gameLoop();
