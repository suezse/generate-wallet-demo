/* global CheckoutWebComponents */

// Insert your public key here
const PUBLIC_KEY = "pk_sbox_fdxl7kyvcvghszuj4gom7737ny3";

const FLOW_METHODS = ["stored_card", "card", "applepay", "googlepay"];

// Flow styled to match Generate (blue actions, Open Sans)
const FLOW_APPEARANCE = {
  colorAction: "#225f9d",
  colorPrimary: "#26272b",
  colorSecondary: "#7a7b80",
  colorBorder: "#e3e9f0",
  colorFormBorder: "#d4dde8",
  colorBackground: "#ffffff",
  colorFormBackground: "#ffffff",
  colorOutline: "#d9e8f5",
  colorError: "#a90000",
  colorSuccess: "#1aaa8e",
  borderRadius: ["12px", "12px"],
};

const UNAVAILABLE = {
  applepay:
    "Apple Pay isn't available on this device or browser. Open this page in Safari on an Apple device with a card in Wallet, or choose another method.",
  googlepay:
    "Google Pay isn't available in this browser. Try Chrome with a card saved to Google Pay, or choose another method.",
  card: "Card payments aren't available right now. Please choose another method.",
  stored_card: "Your saved cards aren't available right now. Pay with a new card instead.",
};

const state = {
  account: null,
  view: "home",
  openMethod: null,
  pendingTransfer: null,
};

const $ = (id) => document.getElementById(id);
const fmt = (minor) =>
  "NZ$" +
  (minor / 100).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Phone frame: scale the 414×868 device down on short desktop screens
// ---------------------------------------------------------------------------
function fitDevice() {
  const framed = window.matchMedia("(min-width: 600px)").matches;
  const scale = framed ? Math.min(1, (window.innerHeight - 48) / 868, (window.innerWidth - 48) / 414) : 1;
  document.documentElement.style.setProperty("--device-scale", scale.toFixed(3));
}
window.addEventListener("resize", fitDevice);
fitDevice();

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------
const BACK = { topup: "home" };

function show(view) {
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== `view-${view}`));
  $("backBtn").hidden = !BACK[view];
  state.view = view;
  $("app").scrollTop = 0;
  if (view !== "topup") closeMethods();
}

$("backBtn").addEventListener("click", () => show(BACK[state.view] || "home"));

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("show"), 3000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
function renderAccount(account) {
  state.account = account;
  $("balance").textContent = fmt(account.balance);
  $("accountId").textContent = account.id;
  document.querySelectorAll(".acct-inline").forEach((el) => (el.textContent = account.id));
  $("newChip").hidden = account.transactions.length > 0;

  const list = $("activity");
  list.innerHTML = "";
  $("emptyActivity").hidden = account.transactions.length > 0;

  account.transactions.forEach((t) => {
    const li = document.createElement("li");
    const pending = t.status === "pending";
    const date = new Date(t.created_at).toLocaleString("en-NZ", {
      day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
    });
    li.innerHTML = `
      <span class="tx-icon">${t.method === "bank_transfer" ? "🏦" : "↓"}</span>
      <span class="tx-main"><strong></strong><small></small></span>
      <span class="tx-amount ${pending ? "pending" : ""}">+${fmt(t.amount)}</span>`;
    li.querySelector("strong").textContent = "Top up";
    li.querySelector("small").textContent = `${t.description} · ${date}`;
    if (pending) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = "Pending";
      li.querySelector("strong").appendChild(badge);
    }
    list.appendChild(li);
  });
}

async function loadAccount() {
  const { member, account } = await api("/api/account");
  $("memberName").textContent = member.first_name;
  renderAccount(account);
}

$("topUpBtn").addEventListener("click", () => {
  $("amountError").hidden = true;
  loadSavedCards();
  show("topup");
  setTimeout(() => $("amount").focus(), 50);
});

$("resetBtn").addEventListener("click", async () => {
  const { account, saved_cards_cleared } = await api("/api/account/reset", { body: {} });
  renderAccount(account);
  await loadSavedCards();
  toast(
    saved_cards_cleared
      ? "Demo reset: new account with NZ$0.00 and no saved cards"
      : "Balance reset, but saved cards could not be removed"
  );
});

// ---------------------------------------------------------------------------
// Saved cards
// ---------------------------------------------------------------------------
async function loadSavedCards() {
  let cards = [];
  try {
    ({ cards } = await api("/api/saved-cards"));
  } catch (err) {
    console.warn("Could not load saved cards", err);
  }
  state.savedCards = cards;
  const row = methodEl("stored_card");
  row.hidden = cards.length === 0;
  if (!cards.length && state.openMethod === "stored_card") closeMethods();
  const first = cards.find((c) => c.is_default) || cards[0];
  const scheme = (s) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : "Card");
  $("savedCardsSummary").textContent = first
    ? `${scheme(first.scheme)} •••• ${first.last4}` + (cards.length > 1 ? ` · +${cards.length - 1} more` : "")
    : "";
}

// ---------------------------------------------------------------------------
// Amount
// ---------------------------------------------------------------------------
const amountInput = $("amount");

function currentAmount() {
  const value = Number(amountInput.value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

function validAmount(showError) {
  const amount = currentAmount();
  const ok = amount >= 100 && amount <= 1000000;
  if (!ok && showError) {
    const err = $("amountError");
    err.textContent = amount ? "Enter an amount between NZ$1.00 and NZ$10,000.00" : "Enter an amount first";
    err.hidden = false;
    amountInput.focus();
  }
  return ok ? amount : 0;
}

let amountTimer;
amountInput.addEventListener("input", () => {
  let v = amountInput.value.replace(/[^0-9.]/g, "");
  const [whole, ...rest] = v.split(".");
  v = rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
  amountInput.value = v;
  $("amountError").hidden = true;
  document
    .querySelectorAll("#quickAmounts button")
    .forEach((b) => b.classList.toggle("active", Number(b.dataset.amount) * 100 === currentAmount()));

  // If a card/wallet form is already open, rebuild it for the new amount
  clearTimeout(amountTimer);
  if (FLOW_METHODS.includes(state.openMethod)) {
    amountTimer = setTimeout(() => {
      if (validAmount(false)) mountFlow(state.openMethod);
      else closeMethods();
    }, 600);
  }
});

$("quickAmounts").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-amount]");
  if (!btn) return;
  amountInput.value = btn.dataset.amount;
  amountInput.dispatchEvent(new Event("input"));
});

// ---------------------------------------------------------------------------
// Expandable payment methods
// ---------------------------------------------------------------------------
const methodEl = (m) => document.querySelector(`.method[data-method="${m}"]`);

document.querySelectorAll(".method-head").forEach((head) => {
  head.addEventListener("click", () => {
    const m = head.closest(".method").dataset.method;
    if (state.openMethod === m) return closeMethods();
    if (!validAmount(true)) return;
    openMethod(m);
  });
});

function openMethod(m) {
  closeMethods();
  state.openMethod = m;
  const el = methodEl(m);
  el.classList.add("open");
  el.querySelector(".method-head").setAttribute("aria-expanded", "true");
  setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }), 320);

  if (m === "bank_transfer") showBankDetails();
  else mountFlow(m);
}

function closeMethods() {
  // Closing the saved-card form may follow a card removal, so refresh the list
  if (state.openMethod === "stored_card") setTimeout(loadSavedCards, 0);
  clearTimeout(amountTimer);
  unmountFlow();
  state.openMethod = null;
  document.querySelectorAll(".method").forEach((el) => {
    el.classList.remove("open");
    el.querySelector(".method-head").setAttribute("aria-expanded", "false");
    el.querySelectorAll(".field-error").forEach((e) => (e.hidden = true));
  });
}

function methodError(m, message) {
  const e = methodEl(m).querySelector(".field-error");
  e.textContent = message;
  e.hidden = !message;
}

// ---------------------------------------------------------------------------
// Card / Apple Pay / Google Pay via Flow (AFT payment session)
// ---------------------------------------------------------------------------
let flow = { component: null, slot: null, token: 0 };

function unmountFlow() {
  flow.token++; // cancels any session still loading
  if (flow.component) {
    try { flow.component.unmount(); } catch (_) {}
  }
  if (flow.slot) flow.slot.innerHTML = "";
  flow = { component: null, slot: null, token: flow.token };
}

async function mountFlow(m) {
  unmountFlow();
  const token = flow.token;
  const el = methodEl(m);
  const slot = el.querySelector(".flow-slot");
  const loading = el.querySelector(".loading");
  const amount = currentAmount();
  flow.slot = slot;
  methodError(m, "");
  loading.hidden = false;

  try {
    const paymentSession = await api("/create-payment-sessions", { body: { amount, method: m } });
    if (token !== flow.token) return;

    const checkout = await CheckoutWebComponents({
      publicKey: PUBLIC_KEY,
      environment: "sandbox",
      locale: "en-GB",
      paymentSession,
      appearance: FLOW_APPEARANCE,
      componentOptions: {
        // Let members delete saved cards they no longer want
        stored_card: { allowRemoveInstrument: true },
      },
      onPaymentCompleted: (_component, paymentResponse) => confirmTopUp(paymentResponse.id, amount),
      onError: (component, error) => {
        console.log("onError", error, "Component", component?.type);
        methodError(m, error?.message || "The payment could not be completed. Please try again.");
      },
    });
    if (token !== flow.token) return;

    const component = checkout.create(m);
    if (!(await component.isAvailable())) {
      if (token !== flow.token) return;
      loading.hidden = true;
      methodError(m, UNAVAILABLE[m]);
      return;
    }
    if (token !== flow.token) return;
    component.mount(slot);
    flow.component = component;
    loading.hidden = true;
  } catch (err) {
    console.error("Error starting payment", err, err.data);
    if (token !== flow.token) return;
    loading.hidden = true;
    methodError(m, err.message || "Something went wrong starting your payment.");
  }
}

async function confirmTopUp(paymentId, fallbackAmount) {
  try {
    const { transaction, account } = await api(`/api/topups/${encodeURIComponent(paymentId)}/confirm`, {
      body: {},
    });
    renderAccount(account);
    showResult("success", transaction.amount, account.balance, transaction.description);
    loadSavedCards();
  } catch (err) {
    console.error("Top-up confirmation failed", err, err.data);
    showResult("failed", fallbackAmount || 0, state.account?.balance ?? 0, err.message);
  }
}

// ---------------------------------------------------------------------------
// Bank transfer (outside Flow)
// ---------------------------------------------------------------------------
let bankDetails = null;

async function showBankDetails() {
  try {
    bankDetails = bankDetails || (await api("/api/bank-details"));
  } catch (err) {
    return methodError("bank_transfer", err.message);
  }
  const rows = [
    ["Account name", bankDetails.account_name],
    ["Bank", bankDetails.bank],
    ["Account no.", bankDetails.account_number, true],
    ["Reference", bankDetails.reference, true],
    ["Amount", fmt(currentAmount())],
  ];
  const dl = $("bankDetails");
  dl.innerHTML = "";
  rows.forEach(([label, value, copyable]) => {
    const row = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    if (copyable) {
      const btn = document.createElement("button");
      btn.className = "copy";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(value); toast(`${label} copied`); } catch (_) {}
      });
      dd.appendChild(btn);
    }
    row.append(dt, dd);
    dl.appendChild(row);
  });
}

// Keep the bank amount row in sync with the amount field
amountInput.addEventListener("input", () => {
  if (state.openMethod === "bank_transfer") {
    if (validAmount(false)) showBankDetails();
    else closeMethods();
  }
});

$("bankDoneBtn").addEventListener("click", async () => {
  const amount = validAmount(true);
  if (!amount) return;
  try {
    const { transaction, account } = await api("/api/topups/bank-transfer", { body: { amount } });
    state.pendingTransfer = transaction;
    renderAccount(account);
    showResult("pending", transaction.amount, account.balance, `Reference ${transaction.reference}`);
  } catch (err) {
    methodError("bank_transfer", err.message);
  }
});

$("simulateBtn").addEventListener("click", async () => {
  const t = state.pendingTransfer;
  const { transaction, account } = await api(`/api/topups/bank-transfer/${t.id}/simulate-received`, {
    body: {},
  });
  state.pendingTransfer = null;
  renderAccount(account);
  showResult("success", transaction.amount, account.balance, "Bank transfer received");
});

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
const ICONS = {
  success:
    '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  pending:
    '<svg viewBox="0 0 24 24" width="38" height="38"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 8v4.5l3 2" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  failed:
    '<svg viewBox="0 0 24 24" width="36" height="36"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>',
};

function showResult(kind, amount, balance, detail) {
  const icon = $("resultIcon");
  icon.className = `result-icon ${kind === "success" ? "" : kind}`;
  icon.innerHTML = ICONS[kind];
  $("resultTitle").textContent =
    kind === "success" ? `${fmt(amount)} added` : kind === "pending" ? "Transfer on its way" : "Top-up failed";
  $("resultText").textContent =
    kind === "success"
      ? `Your Generate Wallet has been topped up. ${detail || ""}`
      : kind === "pending"
        ? `We'll add ${fmt(amount)} to your wallet once it arrives, usually within 1 business day. ${detail || ""}`
        : detail || "Your payment was not completed. You have not been charged.";
  $("resultBalance").textContent = fmt(balance);
  $("simulateBtn").hidden = kind !== "pending";
  amountInput.value = "";
  amountInput.dispatchEvent(new Event("input"));
  show("result");
}

$("doneBtn").addEventListener("click", () => show("home"));

// ---------------------------------------------------------------------------
// Boot – also handles the return from a 3DS / wallet redirect
// ---------------------------------------------------------------------------
(async () => {
  await loadAccount();
  loadSavedCards();

  const params = new URLSearchParams(window.location.search);
  const paymentId = params.get("cko-payment-id");
  const status = params.get("status");
  if (paymentId || status) history.replaceState({}, "", "/");

  if (paymentId && status === "succeeded") {
    await confirmTopUp(paymentId);
  } else if (status === "failed") {
    showResult("failed", 0, state.account.balance);
  } else {
    show("home");
  }
})();
