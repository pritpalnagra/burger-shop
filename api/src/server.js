const express = require("express");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const cors = require("cors");
const { z } = require("zod");
const { pool, healthcheck } = require("./db");

const MySQLStore = require("express-mysql-session")(session);

const PORT = Number(process.env.PORT || "3000");
const NODE_ENV = process.env.NODE_ENV || "production";
const SESSION_SECRET = process.env.SESSION_SECRET || "dev_secret_change_me";
const HST_RATE = Number(process.env.HST_RATE || "0.13"); // Ontario default

const PRODUCTS = [
  { sku: "burger", name: "Burger", price_cents: 1000 },
  { sku: "fries",  name: "Fries",  price_cents: 800  },
  { sku: "coke",   name: "Coke",   price_cents: 300  }
];

function money(cents) {
  return (cents / 100).toFixed(2);
}

function computeTotals(items) {
  const subtotal = items.reduce((sum, it) => sum + it.unit_price_cents * it.qty, 0);
  const hst = Math.round(subtotal * HST_RATE);
  const total = subtotal + hst;
  return { subtotal, hst, total };
}

async function ensureSchema() {
  const sql = require("fs").readFileSync(require("path").join(__dirname, "schema.sql"), "utf8");
  const conn = await pool.getConnection();
  try {
    const statements = sql.split(/;\s*$/m).map(s => s.trim()).filter(Boolean);
    for (const st of statements) await conn.query(st);
  } finally {
    conn.release();
  }
}

const app = express();

// Security-ish defaults (local friendly)
app.use(helmet({
  contentSecurityPolicy: false // UI served by nginx; keep simple locally
}));
app.use(morgan("combined"));
app.use(express.json({ limit: "100kb" }));
app.use(cors({ origin: true, credentials: true }));

app.use(rateLimit({
  windowMs: 60_000,
  max: 200
}));

const sessionStore = new MySQLStore(
  {
    clearExpired: true,
    checkExpirationInterval: 900000,
    expiration: 24 * 60 * 60 * 1000
  },
  {
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || "3306"),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE
  }
);

app.set("trust proxy", 1);

app.use(session({
  name: "burger.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // local over http
    maxAge: 24 * 60 * 60 * 1000
  }
}));

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

app.get("/api/health", async (_req, res) => {
  try {
    const ok = await healthcheck();
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db_unhealthy" });
  }
});

app.get("/api/products", (_req, res) => {
  res.json({ products: PRODUCTS.map(p => ({ ...p, price: money(p.price_cents) })) });
});

app.get("/api/cart", (req, res) => {
  const cart = getCart(req);
  const totals = computeTotals(cart);
  res.json({
    cart: cart.map(it => ({ ...it, unit_price: money(it.unit_price_cents) })),
    totals: {
      subtotal: money(totals.subtotal),
      hst: money(totals.hst),
      total: money(totals.total),
      hst_rate: HST_RATE
    }
  });
});

const addSchema = z.object({
  sku: z.enum(["burger", "fries", "coke"]),
  qty: z.number().int().min(1).max(10).default(1)
});

app.post("/api/cart/add", (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input" });

  const { sku, qty } = parsed.data;
  const p = PRODUCTS.find(x => x.sku === sku);
  const cart = getCart(req);

  const existing = cart.find(x => x.sku === sku);
  if (existing) existing.qty += qty;
  else cart.push({ sku: p.sku, name: p.name, unit_price_cents: p.price_cents, qty });

  res.json({ ok: true });
});

app.post("/api/cart/clear", (req, res) => {
  req.session.cart = [];
  res.json({ ok: true });
});

app.post("/api/checkout", async (req, res) => {
  const cart = getCart(req);
  if (!cart.length) return res.status(400).json({ error: "cart_empty" });

  const totals = computeTotals(cart);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orderResult] = await conn.query(
      "INSERT INTO orders (subtotal_cents, hst_rate, hst_cents, total_cents) VALUES (?,?,?,?)",
      [totals.subtotal, HST_RATE, totals.hst, totals.total]
    );
    const orderId = orderResult.insertId;

    for (const it of cart) {
      const lineTotal = it.unit_price_cents * it.qty;
      await conn.query(
        "INSERT INTO order_items (order_id, sku, name, unit_price_cents, qty, line_total_cents) VALUES (?,?,?,?,?,?)",
        [orderId, it.sku, it.name, it.unit_price_cents, it.qty, lineTotal]
      );
    }

    await conn.commit();

    // clear cart after successful order
    req.session.cart = [];

    res.json({
      receipt: {
        order_id: orderId,
        items: cart.map(it => ({
          sku: it.sku,
          name: it.name,
          qty: it.qty,
          unit_price: money(it.unit_price_cents),
          line_total: money(it.unit_price_cents * it.qty)
        })),
        subtotal: money(totals.subtotal),
        hst_rate: HST_RATE,
        hst: money(totals.hst),
        total: money(totals.total)
      }
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ error: "checkout_failed" });
  } finally {
    conn.release();
  }
});

(async function boot() {
  try {
    await ensureSchema();
  } catch (e) {
    // If schema creation fails, still start so health shows errors; but log it.
    console.error("Schema init failed:", e.message);
  }
  app.listen(PORT, () => console.log(`API listening on :${PORT} env=${NODE_ENV}`));
})();
