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
	line.className = "log-line level-" + logRow.level;
	line.innerHTML =
		'<span class="log-time">' + time + "</span>" +
		'<span class="log-msg">' + escapeHtml(logRow.message) + "</span>";
	logPanel.appendChild(line);
	logPanel.scrollTop = logPanel.scrollHeight;
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
