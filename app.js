/*
 * WebConsole / site / app.js
 * ===========================
 * Ce fichier est PUBLIC (dépôt GitHub Pages) : ne jamais y mettre autre
 * chose que la clé "anon" de Supabase, qui est conçue pour être publique.
 * Toute la protection réelle vient des règles RLS définies côté base
 * (voir backend/schema.sql) et de l'authentification par compte admin.
 */

const SUPABASE_URL = "https://jcwktlyuacxuimwyqrfu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_dJaS636nTjdFY9uX7r-kRA_2PgMwwR3";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
const playersBody = el("players-body");

let currentUser = null;

// ============================================================================
// Authentification
// ============================================================================

loginForm.addEventListener("submit", async (e) => {
	e.preventDefault();
	loginError.textContent = "";

	const { error } = await supabase.auth.signInWithPassword({
		email: el("login-email").value,
		password: el("login-password").value,
	});

	if (error) {
		loginError.textContent = "Connexion refusée : identifiants invalides";
	}
});

logoutBtn.addEventListener("click", async () => {
	await supabase.auth.signOut();
});

supabase.auth.onAuthStateChange((_event, session) => {
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

async function sendCommand(command, params, { timeoutMs = 15000 } = {}) {
	const { data, error } = await supabase
		.from("console_commands")
		.insert({ command, params, issued_by: currentUser.id })
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

		const channel = supabase
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
			supabase.removeChannel(channel);
			resolve(result);
		}
	});
}

// ============================================================================
// Actions
// ============================================================================

el("broadcast-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const message = el("broadcast-message").value.trim();
	if (!message) return;
	const result = await sendCommand("broadcast", { message });
	appendLocalStatus(result);
	if (result.ok) el("broadcast-message").value = "";
});

el("kickban-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	const command = e.submitter?.dataset.command;
	if (command !== "kick" && command !== "ban") return;

	const steam_id = el("kickban-steamid").value.trim();
	const reason = el("kickban-reason").value.trim();
	if (!steam_id) return;

	if (command === "ban" && !confirm("Confirmer le bannissement de " + steam_id + " ?")) return;

	const result = await sendCommand(command, { steam_id, reason });
	appendLocalStatus(result);
});

el("restart-form").addEventListener("submit", async (e) => {
	e.preventDefault();
	if (!el("restart-confirm").checked) return;
	if (!confirm("Le serveur va redémarrer et déconnecter tous les joueurs. Confirmer ?")) return;

	const result = await sendCommand("restart", { confirm: true });
	appendLocalStatus(result);
	el("restart-confirm").checked = false;
});

el("refresh-players-btn").addEventListener("click", async () => {
	playersBody.innerHTML = '<tr><td colspan="4" class="muted">Chargement…</td></tr>';
	const result = await sendCommand("list_players", {});

	if (!result.ok || !result.data) {
		playersBody.innerHTML = '<tr><td colspan="4" class="muted">' + escapeHtml(result.message || "Erreur") + "</td></tr>";
		return;
	}

	renderPlayers(result.data);
});

function renderPlayers(players) {
	if (!players.length) {
		playersBody.innerHTML = '<tr><td colspan="4" class="muted">Aucun joueur connecté</td></tr>';
		return;
	}

	playersBody.innerHTML = players
		.map(
			(p) => `
		<tr>
			<td class="name">${escapeHtml(p.name)}</td>
			<td>${escapeHtml(p.steam_id)}</td>
			<td>${escapeHtml(String(p.ping))} ms</td>
			<td><button data-steamid="${escapeHtml(p.steam_id)}" class="kick-inline">Exclure</button></td>
		</tr>`
		)
		.join("");

	playersBody.querySelectorAll(".kick-inline").forEach((btn) => {
		btn.addEventListener("click", async () => {
			const steam_id = btn.dataset.steamid;
			const result = await sendCommand("kick", { steam_id, reason: "Exclu depuis la liste des joueurs" });
			appendLocalStatus(result);
			if (result.ok) el("refresh-players-btn").click();
		});
	});
}

// ============================================================================
// Journal (logs en temps réel via Supabase Realtime)
// ============================================================================

async function loadRecentLogs() {
	const { data } = await supabase
		.from("console_logs")
		.select("*")
		.order("created_at", { ascending: false })
		.limit(30);

	if (data) {
		data.reverse().forEach(appendLogLine);
	}
}

function startRealtimeLogs() {
	supabase
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
