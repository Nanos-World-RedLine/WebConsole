/*
 * WebConsole / site / app.js
 * ===========================
 * Ce fichier est PUBLIC (dépôt GitHub Pages) : ne jamais y mettre autre
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
	}
});

function renderAuthState() {
	const authed = !!currentUser;
	loginScreen.hidden = authed;
	dashboard.hidden = !authed;
	if (authed) {
		userEmailLabel.textContent = currentUser.email;
		setConnectionState(true);
	}
}

function setConnectionState(online) {
	connDot.classList.toggle("online", online);
	connDot.classList.toggle("offline", !online);
	connLabel.textContent = online ? "connecté" : "hors ligne";
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

		const channel = supabaseClient
			.channel("cmd-" + commandId)
			.on(
				"postgres_changes",
				{
					event: "UPDATE",
					schema: "public",
					table: "console_commands",
					filter: "id=eq." + commandId,
				},
				(payload) => {
					const row = payload.new;
					if (row.status === "done" || row.status === "error") {
						finish(row.result || { ok: row.status === "done", message: "(pas de détail)" });
					}
				}
			)
			.subscribe();

		const timer = setTimeout(() => {
			finish({ ok: false, message: "Pas de réponse du serveur (timeout)" });
		}, timeoutMs);

		function finish(result) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			supabaseClient.removeChannel(channel);
			resolve(result);
		}
	});
}

// ============================================================================
// Actions
// ============================================================================

el("console-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const text = el("console-input").value.trim();
	if (!text) return;
	const result = await sendCommand(text, {}, { target: "host" });
	appendLocalStatus(result);
	if (result.ok) el("console-input").value = "";
});

// ---- Contrôle du processus sur le VPS (target: "host", traité par vps-agent) ----

el("server-start-btn").addEventListener("click", async () => {
	const result = await sendCommand("server_start", {}, { target: "host" });
	appendLocalStatus(result);
});

el("server-stop-btn").addEventListener("click", async () => {
	if (!confirm("Le processus du serveur va être arrêté. Confirmer ?")) return;
	const result = await sendCommand("server_stop", {}, { target: "host" });
	appendLocalStatus(result);
});

el("server-process-restart-btn").addEventListener("click", async () => {
	if (!confirm("Le processus du serveur va être relancé (redémarrage complet, pas juste un rechargement des packages). Confirmer ?")) return;
	const result = await sendCommand("server_process_restart", {}, { target: "host" });
	appendLocalStatus(result);
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
