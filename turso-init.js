// ════════════════════════════════════════════════════════════════
//  TURSO-INIT — substitui firebase-init.js.
//
//  Antes: window.dbCentral / window.dbTenant eram instâncias do
//  Firestore, e o "login" trocava qual firebaseConfig o app 'tenant'
//  usava.
//
//  Agora: NÃO existe conexão direta a banco no browser — toda leitura
//  e escrita passa pela API própria na Vercel (fetch). O que o
//  frontend precisa guardar é só o ID do tenant logado, pra mandar
//  em toda chamada. window.dbTenant continua existindo como sinalizador
//  ("tem alguém logado?") pra não precisar mexer em código que fazia
//  `if (window.dbTenant)` em outros arquivos.
//
//  Precisa carregar ANTES do polyfill.js (mesma ordem de antes).
// ════════════════════════════════════════════════════════════════

window.dbCentral = null; // não é mais usado como conexão; mantido só por compatibilidade de referências antigas
window.dbTenant = null;  // vira um "flag" — string com o tenantId quando logado, null quando não

window.__API_BASE__ = ''; // mesma origem (Vercel) — ajuste aqui se a API ficar em outro domínio

// ── Chamado pelo fluxo de login (equivalente a _initTenantFirebase) ──
// Antes recebia o firebaseConfig inteiro; agora recebe só o tenantId,
// porque tursoUrl/tursoToken nunca saem do servidor.
async function _initTenantFirebase(tenantId) {
  // Cancela listeners do histórico (agora polling) antes de trocar de cliente —
  // mesmo cuidado que existia antes pra não deixar listener "órfão".
  if (typeof window.__cancelarListenersHistorico === 'function') window.__cancelarListenersHistorico();
  window.dbTenant = tenantId;
  window.CURRENT_TENANT_ID = tenantId;
  console.log('[Turso] Banco do cliente conectado — tenant:', tenantId);
  return window.dbTenant;
}

console.log('[Turso] turso-init.js carregado — aguardando login.');
