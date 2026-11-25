const fs = require("fs");
const express = require("express");
const fetch = require("node-fetch");
const app = express();
// Behind a hosting proxy (Render etc.) so req.protocol reports https
app.set("trust proxy", true);

app.use(express.static("public"));
app.use(express.json());

// Secrets come from environment variables (a local .env file, or the hosting dashboard).
// Never commit the secret key.
const SECRET_KEY = process.env.CKO_SECRET_KEY;
const PROCESSING_CHANNEL_ID = process.env.CKO_PROCESSING_CHANNEL_ID;
if (!SECRET_KEY || !PROCESSING_CHANNEL_ID) {
  console.error("Missing CKO_SECRET_KEY or CKO_PROCESSING_CHANNEL_ID – see .env.example");
  process.exit(1);
}
const PORT = process.env.PORT || 3000;

const CKO_API = "https://api.sandbox.checkout.com";
// Public URL of this site, used for Checkout.com redirects (3DS etc.).
// Set BASE_URL in production; otherwise it is worked out from each request.
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get("host")}`;
const CURRENCY = "NZD";
const MIN_TOPUP = 100; // NZ$1.00 (minor units)
const MAX_TOPUP = 1000000; // NZ$10,000.00

// ---------------------------------------------------------------------------
// Demo member + account storage.
// In a real app the member comes from your login session and KYC records,
// and the account/balance lives in your ledger / database.
// ---------------------------------------------------------------------------
const MEMBER = {
  id: "GW100245",
  first_name: "Jia",
  last_name: "Tsang",
  email: "jia.tsang@example.com",
  date_of_birth: "1990-01-01",
  address: {
    address_line1: "12 Queen Street",
    city: "Auckland",
    zip: "1010",
    country: "NZ",
  },
  phone: { country_code: "+64", number: "211234567" },
};

const ACCOUNTS_FILE = __dirname + "/accounts.json";
const newAccount = () => ({
  id: MEMBER.id,
  name: "Generate Wallet",
  currency: CURRENCY,
  balance: 0,
  opened_at: new Date().toISOString(),
  // Checkout.com customer (cus_...) that holds the member's saved cards
  customer_id: null,
  transactions: [],
});
const loadAccount = () => {
  if (!fs.existsSync(ACCOUNTS_FILE)) saveAccount(newAccount());
  return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
};
const saveAccount = (account) =>
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(account, null, 2));

const publicAccount = (a) => ({
  id: a.id,
  name: a.name,
  currency: a.currency,
  balance: a.balance,
  opened_at: a.opened_at,
  transactions: a.transactions.slice().reverse().slice(0, 20),
});

const parseAmount = (value) => {
  const amount = Math.round(Number(value));
  if (!Number.isFinite(amount) || amount < MIN_TOPUP || amount > MAX_TOPUP) {
    return null;
  }
  return amount;
};

// Which Flow payment method each top-up option maps to
const FLOW_METHODS = {
  card: "card",
  stored_card: "stored_card",
  applepay: "applepay",
  googlepay: "googlepay",
};

const ckoHeaders = {
  Authorization: `Bearer ${SECRET_KEY}`,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------
app.get("/api/account", (_req, res) => {
  res.send({ member: { first_name: MEMBER.first_name }, account: publicAccount(loadAccount()) });
});

// Demo only: reset the wallet to a brand-new, zero-balance account.
// Also deletes the Checkout.com customer, which removes all of its saved cards.
app.post("/api/account/reset", async (_req, res) => {
  const customerId = loadAccount().customer_id;
  let savedCardsCleared = true;
  if (customerId) {
    const del = await fetch(`${CKO_API}/customers/${encodeURIComponent(customerId)}`, {
      method: "DELETE",
      headers: ckoHeaders,
    });
    // 404 = already gone, which is fine
    savedCardsCleared = del.ok || del.status === 404;
    if (!savedCardsCleared) console.error("Failed to delete customer", customerId, del.status);
  }
  const account = newAccount();
  saveAccount(account);
  res.send({ account: publicAccount(account), saved_cards_cleared: savedCardsCleared });
});

// ---------------------------------------------------------------------------
// Saved cards (stored against the member's Checkout.com customer)
// ---------------------------------------------------------------------------
app.get("/api/saved-cards", async (_req, res) => {
  const customerId = loadAccount().customer_id;
  if (!customerId) return res.send({ cards: [] });

  const request = await fetch(`${CKO_API}/customers/${encodeURIComponent(customerId)}`, {
    headers: ckoHeaders,
  });
  if (request.status === 404) return res.send({ cards: [] });
  const customer = await request.json().catch(() => ({}));
  if (!request.ok) return res.status(request.status).send({ error: "Could not load saved cards" });

  const cards = (customer.instruments || [])
    .filter((i) => i.type === "card")
    .map((i) => ({
      id: i.id,
      scheme: i.scheme,
      last4: i.last4,
      expiry_month: i.expiry_month,
      expiry_year: i.expiry_year,
      is_default: i.id === customer.default,
    }));
  res.send({ cards });
});

// ---------------------------------------------------------------------------
// Card / Apple Pay / Google Pay top-up via Flow (AFT)
// ---------------------------------------------------------------------------
app.post("/create-payment-sessions", async (req, res) => {
  const amount = parseAmount(req.body?.amount);
  const method = FLOW_METHODS[req.body?.method];
  if (!amount) {
    return res.status(422).send({ error: "Top-up amount must be between NZ$1 and NZ$10,000" });
  }
  if (!method) {
    return res.status(422).send({ error: "Unsupported payment method" });
  }

  const account = loadAccount();
  const reference = `TOPUP-${account.id}-${Date.now()}`;

  const request = await fetch(`${CKO_API}/payment-sessions`, {
    method: "POST",
    headers: ckoHeaders,
    body: JSON.stringify({
      processing_channel_id: PROCESSING_CHANNEL_ID,
      amount,
      currency: CURRENCY,
      reference,
      description: "Generate Wallet top-up",
      billing_descriptor: {
        name: "Generate Wealth",
        city: "Auckland",
      },
      // Saved cards are stored against this customer (matched by email,
      // or by ID once we know it from a previous payment)
      customer: {
        ...(account.customer_id && { id: account.customer_id }),
        email: MEMBER.email,
        name: `${MEMBER.first_name} ${MEMBER.last_name}`,
      },
      billing: {
        address: MEMBER.address,
        phone: MEMBER.phone,
      },
      risk: {
        enabled: true,
      },
      // ---- Account Funding Transaction (AFT) ----
      // Funds move from the member's card into their own Generate account.
      // AFT must be enabled on your Checkout.com account.
      processing: {
        aft: true,
      },
      // Sender = the cardholder funding the account (from your KYC records)
      sender: {
        type: "individual",
        first_name: MEMBER.first_name,
        last_name: MEMBER.last_name,
        date_of_birth: MEMBER.date_of_birth,
        address: MEMBER.address,
      },
      // Recipient = the Generate account being funded (the member's own account)
      recipient: {
        first_name: MEMBER.first_name,
        last_name: MEMBER.last_name,
        account_number: account.id,
        address: MEMBER.address,
      },
      // The page mounts only the component the member picked (card / applepay / googlepay).
      // Note: don't send enabled_payment_methods with "card" – Checkout.com then adds
      // Remember Me even if it's listed here. disabled_payment_methods alone works.
      disabled_payment_methods: ["remember_me"],
      payment_method_configuration: {
        // Show a "save card for future payments" checkbox on the card form
        card: { store_payment_details: "collect_consent" },
        // Let the member pay with the cards they saved before
        ...(account.customer_id && { stored_card: { customer_id: account.customer_id } }),
      },
      success_url: `${baseUrl(req)}/?status=succeeded`,
      failure_url: `${baseUrl(req)}/?status=failed`,
      metadata: { account_id: account.id, topup_method: req.body.method },
      items: [{ name: "Generate Wallet top-up", quantity: 1, unit_price: amount }],
    }),
  });

  const parsedPayload = await request.json().catch(() => ({}));
  res.status(request.status).send(parsedPayload);
});

// After Flow reports a completed payment, verify it with Checkout.com and
// credit the account. The amount comes from Checkout.com, never the browser.
app.post("/api/topups/:paymentId/confirm", async (req, res) => {
  const paymentId = req.params.paymentId;
  const request = await fetch(`${CKO_API}/payments/${encodeURIComponent(paymentId)}`, {
    headers: ckoHeaders,
  });
  const payment = await request.json().catch(() => ({}));

  if (!request.ok) {
    return res.status(request.status).send({ error: "Payment not found", details: payment });
  }

  const account = loadAccount();
  const existing = account.transactions.find((t) => t.payment_id === payment.id);
  if (existing) {
    return res.send({ credited: false, transaction: existing, account: publicAccount(account) });
  }

  const succeeded =
    payment.approved === true &&
    ["Authorized", "Captured", "Paid"].includes(payment.status) &&
    payment.currency === CURRENCY &&
    payment.metadata?.account_id === account.id;

  if (!succeeded) {
    return res.status(402).send({
      error: "Payment was not approved",
      status: payment.status,
      response_summary: payment.response_summary,
    });
  }

  const transaction = {
    id: `txn_${Date.now()}`,
    type: "topup",
    method: payment.metadata?.topup_method || payment.source?.type || "card",
    amount: payment.amount,
    status: "completed",
    payment_id: payment.id,
    description: describeSource(payment),
    created_at: new Date().toISOString(),
  };
  account.balance += payment.amount;
  account.transactions.push(transaction);
  // Remember the Checkout.com customer so saved cards show next time
  if (payment.customer?.id) account.customer_id = payment.customer.id;
  saveAccount(account);

  res.send({ credited: true, transaction, account: publicAccount(account) });
});

function describeSource(payment) {
  const s = payment.source || {};
  const label = { applepay: "Apple Pay", googlepay: "Google Pay", stored_card: "Saved card" }[
    payment.metadata?.topup_method
  ];
  const card = s.scheme && s.last4 ? `${s.scheme} •••• ${s.last4}` : "Card";
  return label ? `${label} · ${card}` : card;
}

// ---------------------------------------------------------------------------
// Bank transfer top-up (outside Flow)
// The member pays into your client funds account using a unique reference;
// your bank feed / reconciliation then credits the account.
// ---------------------------------------------------------------------------
const BANK_DETAILS = {
  account_name: "Generate Wealth Ltd - Client Funds",
  bank: "Demo Bank NZ",
  account_number: "12-3456-0789012-00",
};

// Each member always uses the same reference (their account number), so they can
// save Generate as a payee in their banking app and top up any time.
app.get("/api/bank-details", (_req, res) => {
  res.send({ ...BANK_DETAILS, reference: loadAccount().id });
});

// Member says they've sent a transfer: record it as pending until the bank feed matches it
app.post("/api/topups/bank-transfer", (req, res) => {
  const amount = parseAmount(req.body?.amount);
  if (!amount) {
    return res.status(422).send({ error: "Top-up amount must be between NZ$1 and NZ$10,000" });
  }
  const account = loadAccount();
  const reference = account.id;
  const transaction = {
    id: `txn_${Date.now()}`,
    type: "topup",
    method: "bank_transfer",
    amount,
    status: "pending",
    reference,
    description: "Bank transfer",
    created_at: new Date().toISOString(),
  };
  account.transactions.push(transaction);
  saveAccount(account);
  res.send({ bank_details: { ...BANK_DETAILS, reference }, transaction, account: publicAccount(account) });
});

// Demo only: pretend the bank feed has matched the transfer
app.post("/api/topups/bank-transfer/:txnId/simulate-received", (req, res) => {
  const account = loadAccount();
  const transaction = account.transactions.find((t) => t.id === req.params.txnId);
  if (!transaction || transaction.method !== "bank_transfer") {
    return res.status(404).send({ error: "Transfer not found" });
  }
  if (transaction.status !== "completed") {
    transaction.status = "completed";
    transaction.completed_at = new Date().toISOString();
    account.balance += transaction.amount;
    saveAccount(account);
  }
  res.send({ credited: true, transaction, account: publicAccount(account) });
});

app.listen(PORT, () =>
  console.log(`Node server listening on port ${PORT}: http://localhost:${PORT}/`)
);
