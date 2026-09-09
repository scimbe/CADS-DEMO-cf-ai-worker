const BASE = "/agents/salon-agent/default/admin";
let token = sessionStorage.getItem("admin_token") || "";

const loginCard = document.querySelector("#login-card");
const adminArea = document.querySelector("#admin-area");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const blockerForm = document.querySelector("#blocker-form");
const blockerList = document.querySelector("#blocker-list");
const appointmentList = document.querySelector("#appointment-list");
const llmProviderSelect = document.querySelector("#llm-provider-select");

function authHeaders() {
  return { Authorization: `Bearer ${token}` };
}

async function showAdmin() {
  loginCard.hidden = true;
  adminArea.hidden = false;
  await Promise.all([loadBlockers(), loadAppointments(), loadLlmProvider()]);
}

async function loadLlmProvider() {
  const res = await fetch(`${BASE}/settings`, { headers: authHeaders() });
  if (!res.ok) return;
  const { llmProvider } = await res.json();
  llmProviderSelect.value = llmProvider;
}

llmProviderSelect.addEventListener("change", async () => {
  await fetch(`${BASE}/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ llmProvider: llmProviderSelect.value })
  });
});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = document.querySelector("#password-input").value;
  const res = await fetch(`${BASE}/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  if (!res.ok) {
    loginError.hidden = false;
    return;
  }
  const data = await res.json();
  token = data.token;
  sessionStorage.setItem("admin_token", token);
  loginError.hidden = true;
  showAdmin();
});

async function loadBlockers() {
  const res = await fetch(`${BASE}/blockers`, { headers: authHeaders() });
  if (!res.ok) return;
  const blockers = await res.json();
  blockerList.innerHTML = "";
  for (const b of blockers) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = `${b.startDate} ${b.startTime} – ${b.endDate} ${b.endTime}: ${b.reason}`;
    const del = document.createElement("button");
    del.textContent = "Entfernen";
    del.addEventListener("click", async () => {
      await fetch(`${BASE}/blockers/${b.id}`, { method: "DELETE", headers: authHeaders() });
      loadBlockers();
    });
    li.append(span, del);
    blockerList.appendChild(li);
  }
}

async function loadAppointments() {
  const res = await fetch(`${BASE}/appointments`, { headers: authHeaders() });
  if (!res.ok) return;
  const appts = await res.json();
  appointmentList.innerHTML = "";
  for (const a of appts) {
    const li = document.createElement("li");
    if (a.status === "cancelled") li.className = "cancelled";
    const span = document.createElement("span");
    span.textContent = `${a.date} ${a.time} – ${a.name} (${a.phone}) – ${a.service}${
      a.status === "cancelled" ? " [storniert]" : ""
    }`;
    li.appendChild(span);
    if (a.status !== "cancelled") {
      const cancel = document.createElement("button");
      cancel.textContent = "Absagen";
      cancel.addEventListener("click", async () => {
        await fetch(`${BASE}/appointments/${a.id}`, { method: "DELETE", headers: authHeaders() });
        loadAppointments();
      });
      li.appendChild(cancel);
    }
    appointmentList.appendChild(li);
  }
}

blockerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = {
    startDate: document.querySelector("#blocker-start-date").value,
    startTime: document.querySelector("#blocker-start-time").value,
    endDate: document.querySelector("#blocker-end-date").value,
    endTime: document.querySelector("#blocker-end-time").value,
    reason: document.querySelector("#blocker-reason").value
  };
  await fetch(`${BASE}/blockers`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body)
  });
  blockerForm.reset();
  loadBlockers();
});

if (token) showAdmin();
