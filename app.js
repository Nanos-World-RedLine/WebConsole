/*
 * WebConsole / site / app.js
 * ===========================
 * chose que la clé PUBLIQUE de Supabase ("anon" ou, sur le nouveau format
 * de clés, "publishable" - Settings > API Keys dans le dashboard), qui est
 * conçue pour être publique. Toute la protection réelle vient des règles
 * RLS définies côté base (voir backend/schema.sql) et de l'authentification
 * par compte admin.
 */

const SUPABASE_URL = "https://jcwktlyuacxuimwyqrfu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_dJaS636nTjdFY9uX7r-kRA_2PgMwwR3";

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const el = (id) => document.getElementById(id);

const loginScreen = el("login-screen");
const dashboard = el("dashboard");
const loginForm = el("login-form");
const loginError = el("login-error");
const logoutBtn = el("logout-btn");
const userEmailLabel = el("user-email");
const connDot = el("conn-dot");
const connLabel = el("conn-label");
const logPanel = el("log-panel");

let currentUser = null;

// ============================================================================
// Authentification
// ============================================================================

loginForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	loginError.textContent = "";

	const { error } = await supabaseClient.auth.signInWithPassword({
		email: el("login-email").value,
		password: el("login-password").value,
	});

	if (error) {
		loginError.textContent = "Connexion refusée : identifiants invalides";
	}
});

logoutBtn.addEventListener("click", async () => {
	await supabaseClient.auth.signOut();
});

supabaseClient.auth.onAuthStateChange((_event, session) => {
	currentUser = session ? session.user : null;
	renderAuthState();
	if (currentUser) {
		startRealtimeLogs();
		loadRecentLogs();
		startStatusPolling();
	} else {
		stopStatusPolling();
	}
});

function renderAuthState() {
	const authed = !!currentUser;
	const target = authed ? dashboard : loginScreen;
	const other = authed ? loginScreen : dashboard;

	if (authed) userEmailLabel.textContent = currentUser.email;

	// Ne joue la transition que si l'écran change réellement (évite un
	// flash inutile au premier chargement quand l'état est déjà correct).
	if (target.hidden) {
		switchScreen(other, target);
	}
}

function switchScreen(fromEl, toEl) {
	fromEl.classList.add("screen-exit");
	setTimeout(() => {
		fromEl.hidden = true;
		fromEl.classList.remove("screen-exit");

		toEl.hidden = false;
		toEl.classList.add("screen-enter");
		requestAnimationFrame(() => {
			requestAnimationFrame(() => toEl.classList.remove("screen-enter"));
		});
	}, 280);
}

// ---- Statut réel du serveur (publié par vps-agent dans server_status) ----

let statusPollTimer = null;

function startStatusPolling() {
	pollServerStatus();
	statusPollTimer = setInterval(pollServerStatus, 4000);
}

function stopStatusPolling() {
	if (statusPollTimer) clearInterval(statusPollTimer);
	statusPollTimer = null;
}

async function pollServerStatus() {
	const { data, error } = await supabaseClient
		.from("server_status")
		.select("status")
		.eq("id", 1)
		.single();

	applyServerStatus(!error && data ? data.status : "unknown");
}

function applyServerStatus(status) {
	connDot.className = "brand-dot status-" + status;
	connLabel.textContent =
		{
			running: "en ligne",
			stopped: "hors ligne",
			starting: "démarrage…",
			stopping: "arrêt…",
		}[status] || "statut inconnu";
}

// ============================================================================
// Envoi de commandes et attente du résultat
// ============================================================================
//
// Le serveur nanos world sonde console_commands toutes les quelques
// secondes (voir Server/Index.lua) : on s'abonne donc au changement de
// statut de LA commande qu'on vient de créer plutôt que de faire du
// polling depuis le navigateur.

async function sendCommand(command, params, { target = "game", timeoutMs = 15000 } = {}) {
	const { data, error } = await supabaseClient
		.from("console_commands")
		.insert({ command, params, target, issued_by: currentUser.id })
		.select()
		.single();

	if (error) {
		return { ok: false, message: "Echec d'envoi : " + error.message };
	}

	return waitForResult(data.id, timeoutMs);
}

function waitForResult(commandId, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		const pollEveryMs = 1000;
		const deadline = Date.now() + timeoutMs;

		async function check() {
			if (settled) return;

			const { data, error } = await supabaseClient
				.from("console_commands")
				.select("status,result")
				.eq("id", commandId)
				.single();

			if (!error && data && (data.status === "done" || data.status === "error")) {
				finish(data.result || { ok: data.status === "done", message: "(pas de détail)" });
				return;
			}

			if (Date.now() >= deadline) {
				finish({ ok: false, message: "Pas de réponse du serveur (timeout)" });
				return;
			}

			setTimeout(check, pollEveryMs);
		}

		function finish(result) {
			if (settled) return;
			settled = true;
			resolve(result);
		}

		check();
	});
}

// ============================================================================
// Actions
// ============================================================================

el("console-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const text = el("console-input").value.trim();
	if (!text) return;

	const input = el("console-input");
	const button = e.target.querySelector("button[type=submit]");
	input.disabled = true;
	button.disabled = true;

	const result = await sendCommand(text, {}, { target: "host" });
	appendLocalStatus(result);
	if (result.ok) input.value = "";

	input.disabled = false;
	button.disabled = false;
	input.focus();
});

// ---- Contrôle du processus sur le VPS (target: "host", traité par vps-agent) ----

el("server-start-btn").addEventListener("click", async (e) => {
	e.target.disabled = true;
	const result = await sendCommand("server_start", {}, { target: "host" });
	appendLocalStatus(result);
	e.target.disabled = false;
});

el("server-stop-btn").addEventListener("click", async (e) => {
	if (!confirm("Le processus du serveur va être arrêté. Confirmer ?")) return;
	e.target.disabled = true;
	const result = await sendCommand("server_stop", {}, { target: "host" });
	appendLocalStatus(result);
	e.target.disabled = false;
});

el("server-process-restart-btn").addEventListener("click", async (e) => {
	if (!confirm("Le processus du serveur va être relancé (redémarrage complet, pas juste un rechargement des packages). Confirmer ?")) return;
	e.target.disabled = true;
	const result = await sendCommand("server_process_restart", {}, { target: "host" });
	appendLocalStatus(result);
	e.target.disabled = false;
});

// ============================================================================
// Journal (logs en temps réel via Supabase Realtime)
// ============================================================================

async function loadRecentLogs() {
	const { data } = await supabaseClient
		.from("console_logs")
		.select("*")
		.order("created_at", { ascending: false })
		.limit(30);

	if (data) {
		data.reverse().forEach(appendLogLine);
	}
}

let logsSubscribed = false;

function startRealtimeLogs() {
	if (logsSubscribed) return;
	logsSubscribed = true;

	supabaseClient
		.channel("console-logs-live")
		.on(
			"postgres_changes",
			{ event: "INSERT", schema: "public", table: "console_logs" },
			(payload) => appendLogLine(payload.new)
		)
		.subscribe();
}

function appendLogLine(logRow) {
	const time = new Date(logRow.created_at).toLocaleTimeString("fr-FR");
	const line = document.createElement("div");
	line.className = "log-line level-" + (detectLineLevel(logRow.message) || logRow.level);
	line.innerHTML =
		'<span class="log-time">' + time + "</span>" +
		'<span class="log-msg">' + formatLogMessage(logRow.message) + "</span>";
	logPanel.appendChild(line);
	logPanel.scrollTop = logPanel.scrollHeight;
}

// ---- Coloration façon console nanos world (INFO / SCRIPT / WARNING / ... + tags [x]) ----

const LOG_LEVEL_CLASSES = {
	INFO: "lvl-info",
	SCRIPT: "lvl-script",
	WARNING: "lvl-warn",
	ERROR: "lvl-error",
	S_ERR: "lvl-error",
	S_WARN: "lvl-warn",
	SUCCESS: "lvl-success",
	DEBUG: "lvl-debug",
	CONSOLE: "lvl-console",
	CHAT: "lvl-chat",
};
const LOG_LEVEL_PATTERN = new RegExp("\\b(" + Object.keys(LOG_LEVEL_CLASSES).join("|") + ")\\b");

// Certains niveaux méritent de colorer la ligne entière, pas juste le mot-clé
// (plus facile à repérer d'un coup d'œil dans le flux qu'un mot isolé).
function detectLineLevel(message) {
	if (/\b(ERROR|S_ERR)\b/.test(message)) return "error";
	if (/\b(WARNING|S_WARN)\b/.test(message)) return "warn";
	if (/\bCHAT\b/.test(message)) return "chat";
	return null;
}

function formatLogMessage(message) {
	let html = escapeHtml(message);

	html = html.replace(LOG_LEVEL_PATTERN, (word) => {
		return '<span class="lvl ' + LOG_LEVEL_CLASSES[word] + '">' + word + "</span>";
	});

	html = html.replace(/\[([^[\]]+)\]/g, '<span class="log-tag">[$1]</span>');

	return html;
}

function appendLocalStatus(result) {
	appendLogLine({
		created_at: new Date().toISOString(),
		level: result.ok ? "info" : "error",
		message: result.message || (result.ok ? "OK" : "Echec"),
	});
}

function escapeHtml(str) {
	const div = document.createElement("div");
	div.textContent = str;
	return div.innerHTML;
}


* ---- Onglet Config.toml -------------------------------------------------
   Envoie des commandes target=host que l'agent v3 intercepte :
   config_read, config_write, config_backups, config_backup_get,
   config_restore. La réponse arrive dans console_commands.result.       */
 
const CFG_POLL_MS = 1000;      // fréquence de vérification du résultat
const CFG_TIMEOUT_MS = 45000;  // l'agent poll toutes les 3s + restart éventuel
 
async function configCommand(command, params = {}) {
  const { data: userData } = await supabaseClient.auth.getUser();
  const { data: row, error } = await supabaseClient
    .from("console_commands")
    .insert({
      command,
      params,
      target: "host",
      issued_by: userData && userData.user ? userData.user.email : null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
 
  const start = Date.now();
  while (Date.now() - start < CFG_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, CFG_POLL_MS));
    const { data } = await supabaseClient
      .from("console_commands")
      .select("status,result")
      .eq("id", row.id)
      .single();
    if (data && (data.status === "done" || data.status === "error")) {
      const result = data.result || {};
      if (data.status === "error" || result.ok === false) {
        const err = new Error(result.message || "Erreur agent");
        err.result = result;
        throw err;
      }
      return result;
    }
  }
  throw new Error("Timeout : l'agent n'a pas répondu (est-il lancé ?)");
}
 
/* ---- État de l'onglet ---- */
let cfgMtime = null;
let cfgDirty = false;
 
function cfgStatus(msg, cls = "") {
  const el = document.getElementById("cfg-status");
  el.textContent = msg;
  el.className = "cfg-status " + cls;
}
 
function cfgSetDirty(v) {
  cfgDirty = v;
  document.getElementById("cfg-modified").hidden = !v;
}
 
async function cfgLoad() {
  cfgStatus("Chargement du Config.toml…");
  try {
    const r = await configCommand("config_read");
    document.getElementById("cfg-editor").value = r.content;
    cfgMtime = r.mtime;
    cfgSetDirty(false);
    cfgStatus("Fichier chargé (" + (r.path || "") + ")", "ok");
    cfgLoadBackups();
  } catch (e) {
    cfgStatus("Erreur : " + e.message, "err");
  }
}
 
async function cfgSave(restart, force = false) {
  if (restart && !confirm("Sauvegarder puis redémarrer le serveur ?\nLes joueurs connectés seront déconnectés.")) return;
  cfgStatus(restart ? "Sauvegarde + redémarrage…" : "Sauvegarde…");
  try {
    const r = await configCommand("config_write", {
      content: document.getElementById("cfg-editor").value,
      mtime: cfgMtime,
      restart,
      force,
    });
    cfgMtime = r.mtime;
    cfgSetDirty(false);
    cfgLoadBackups();
    cfgStatus(
      r.restarted
        ? "Sauvegardé + serveur redémarré ✓"
        : "Sauvegardé ✓ (backup créé). Redémarre le serveur pour appliquer.",
      "ok"
    );
  } catch (e) {
    if (e.result && e.result.conflict) {
      if (confirm("⚠ Le fichier a été modifié sur le serveur (SSH ?) pendant ton édition.\n\nOK = écraser avec ta version\nAnnuler = ne rien faire"))
        return cfgSave(restart, true);
      return cfgStatus("Sauvegarde annulée (conflit).", "warn");
    }
    cfgStatus("Refusé : " + e.message, "err"); // ex: "TOML invalide : ..."
  }
}
 
async function cfgLoadBackups() {
  try {
    const r = await configCommand("config_backups");
    const sel = document.getElementById("cfg-backups");
    sel.innerHTML = '<option value="">— Backups (' + r.backups.length + ") —</option>";
    for (const name of r.backups) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name.replace("Config-", "").replace(".toml", "");
      sel.appendChild(opt);
    }
  } catch (e) { /* silencieux : les backups ne sont pas critiques */ }
}
 
async function cfgRestore() {
  const name = document.getElementById("cfg-backups").value;
  if (!name) return cfgStatus("Choisis un backup dans la liste d'abord.", "warn");
  if (!confirm("Restaurer " + name + " comme Config.toml actif ?\n(L'état actuel sera sauvegardé avant)")) return;
  cfgStatus("Restauration…");
  try {
    await configCommand("config_restore", { name });
    cfgStatus("Backup restauré ✓ — redémarre le serveur pour appliquer.", "ok");
    cfgLoad();
  } catch (e) {
    cfgStatus("Erreur : " + e.message, "err");
  }
}
 
/* ---- À appeler quand le dashboard s'affiche (après login) ---- */
function configTabInit() {
  const editor = document.getElementById("cfg-editor");
  editor.addEventListener("input", () => cfgSetDirty(true));
  // Tab insère une vraie tabulation au lieu de changer de champ
  editor.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = editor.selectionStart;
      editor.setRangeText("\t", s, editor.selectionEnd, "end");
      cfgSetDirty(true);
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); cfgSave(false); }
  });
  document.getElementById("cfg-reload").onclick = () => {
    if (!cfgDirty || confirm("Abandonner les modifications non sauvegardées ?")) cfgLoad();
  };
  document.getElementById("cfg-save").onclick = () => cfgSave(false);
  document.getElementById("cfg-save-restart").onclick = () => cfgSave(true);
  document.getElementById("cfg-restore").onclick = () => cfgRestore();
  window.addEventListener("beforeunload", (e) => { if (cfgDirty) e.preventDefault(); });
 
  document.getElementById("config-tab").hidden = false;
  cfgLoad();
}
