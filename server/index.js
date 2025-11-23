import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import multer from "multer";
import fs from "fs";
import { createServer } from "http";
import { Server } from "socket.io";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5500;

// -------------------- MIDDLEWARE --------------------
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded images
const uploadsDir = path.join(path.resolve(), "server/uploads");
app.use("/uploads", express.static(uploadsDir));

// -------------------- DATABASE --------------------
const db = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "root12345",
  database: process.env.DB_NAME || "camarcl_flowershop",
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test DB connection
(async () => {
  try {
    const conn = await db.getConnection();
    console.log("Connected to MySQL database!");
    conn.release();
  } catch (err) {
    console.error("MySQL connection error:", err);
    process.exit(1);
  }
})();

// -------------------- SOCKET.IO --------------------
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET","POST","PUT","DELETE"]
  }
});

io.on("connection", socket => {
  console.log("New client connected:", socket.id);
  socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
});

/// -------------------- HELPERS --------------------
const sendNotification = async (type, reference_id, message) => {
  try {
    const [result] = await db.query(
      "INSERT INTO notifications (type, reference_id, message, isRead, created_at) VALUES (?, ?, ?, 0, NOW())",
      [type, reference_id, message]
    );
    io.emit("new_notification", {
      id: result.insertId,
      type,
      reference_id,
      message,
      isRead: 0,
      created_at: new Date()
    });
  } catch (err) {
    console.error("Notification error:", err);
  }
};

const checkLowStock = async (productId, stock, productName) => {
  if (Number(stock) < 20) {
    await sendNotification("low on supplies", productId, `Product '${productName}' is low on supplies!`);
  }
};

const orderStatusNotification = async (order) => {
  if (!order.status) return;

  const status = order.status.toLowerCase();

  let message = "";

  if (status.includes("delivered")) {
    message = `Order #${order.id} for ${order.user_name} has been delivered!`;
  } else if (status.includes("cancelled") || status.includes("returned")) {
    message = `Order #${order.id} for ${order.user_name} has been cancelled/returned!`;
  }

  if (message) {
    console.log("Sending notification:", message);
    await sendNotification("status", order.id, message);
  } else {
    console.log("No notification for status:", order.status);
  }
};


// -------------------- MULTER --------------------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed!"), false);
  }
});

// -------------------- ROUTES --------------------

// Products
app.get("/products", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM products");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/products", upload.single("image"), async (req, res) => {
  try {
    const { name, price, stock, category, description } = req.body;
    const image_url = req.file ? `/uploads/${req.file.filename}` : null;
    const [result] = await db.query(
      "INSERT INTO products (name, price, stock, category, description, image_url) VALUES (?, ?, ?, ?, ?, ?)",
      [name, price, stock, category, description, image_url]
    );
    await checkLowStock(result.insertId, stock, name);
    res.json({ message: "Product added!", id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

  app.put("/products/:id", upload.single("image"), async (req, res) => {
    try {
      const { id } = req.params;
      const { name, price, stock, category, description } = req.body;

      // Only use the new uploaded file if it exists
      const image_url = req.file
        ? `/uploads/${req.file.filename}`  // new image selected
        : undefined;                      // keep existing DB image if no new file

      // Build query dynamically to avoid overwriting image
      const query = image_url
        ? "UPDATE products SET name=?, price=?, stock=?, category=?, description=?, image_url=? WHERE id=?"
        : "UPDATE products SET name=?, price=?, stock=?, category=?, description=? WHERE id=?";
      
      const params = image_url
        ? [name, price, stock, category, description, image_url, id]
        : [name, price, stock, category, description, id];

      await db.query(query, params);
      await checkLowStock(id, stock, name);

      res.json({ message: "Product updated!" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


app.delete("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const [results] = await db.query("SELECT image_url FROM products WHERE id=?", [id]);
    const imagePath = results[0]?.image_url ? path.join(uploadsDir, path.basename(results[0].image_url)) : null;
    if (imagePath && fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
    await db.query("DELETE FROM products WHERE id=?", [id]);
    res.json({ message: "Product deleted!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Users
app.get("/users", async (req, res) => {
  try {
    const [results] = await db.query("SELECT id, name, email, contact_number, role FROM users");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/users", async (req, res) => {
  try {
    const { name, email, contact_number, role, password } = req.body;
    if (!name || !email || !role) return res.status(400).json({ error: "Name, email, and role are required" });
    const [result] = await db.query(
      "INSERT INTO users (name, email, contact_number, role, password) VALUES (?, ?, ?, ?, ?)",
      [name, email, contact_number || null, role, password || null]
    );
    res.json({ message: "User added!", id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, contact_number, role, password } = req.body;
    const query = password
      ? "UPDATE users SET name=?, email=?, contact_number=?, role=?, password=? WHERE id=?"
      : "UPDATE users SET name=?, email=?, contact_number=?, role=? WHERE id=?";
    const params = password
      ? [name, email, contact_number || null, role, password, id]
      : [name, email, contact_number || null, role, id];
    await db.query(query, params);
    res.json({ message: "User updated!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/users/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("DELETE FROM users WHERE id=?", [id]);
    res.json({ message: "User deleted!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orders
app.get("/orders", async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        o.id AS order_id,
        o.user_name,
        o.total AS order_total,
        o.payment_mode,
        o.status,
        o.created_at,
        oi.id AS order_item_id,
        oi.product_id,
        oi.product_name,
        oi.quantity,
        oi.price AS item_price,
        oi.total AS item_total,
        p.image_url,
        IFNULL(p.category, p.name) AS category
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      LEFT JOIN products p ON oi.product_id = p.id
      ORDER BY o.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Error fetching orders:", err);
    res.status(500).json({ message: "Server error" });
  }
});



app.post("/orders", async (req, res) => {
  const { user_name, payment_mode, items } = req.body;
  if (!user_name || !payment_mode || !items || !Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "Missing required fields or items" });

  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    const productIds = items.map(i => i.product_id);
    const [products] = await conn.query("SELECT id, name, price, stock FROM products WHERE id IN (?)", [productIds]);

    let orderTotal = 0;
    const orderItemsData = items.map(item => {
      const product = products.find(p => p.id === item.product_id);
      if (!product) throw new Error(`Product ${item.product_id} not found`);
      if (item.quantity > product.stock) throw new Error(`Not enough stock for ${product.name}`);
      const total = Number(product.price) * Number(item.quantity);
      orderTotal += total;
      return { product_id: product.id, product_name: product.name, quantity: item.quantity, price: product.price, total };
    });

    const [orderResult] = await conn.query(
      "INSERT INTO orders (user_name, total, payment_mode, status, created_at) VALUES (?, ?, ?, 'pending', NOW())",
      [user_name, orderTotal, payment_mode]
    );

    const orderId = orderResult.insertId;
    const orderItemsValues = orderItemsData.map(i => [orderId, i.product_id, i.product_name, i.quantity, i.price, i.total]);
    await conn.query(
      "INSERT INTO order_items (order_id, product_id, product_name, quantity, price, total) VALUES ?",
      [orderItemsValues]
    );

    // update stock
    for (const item of orderItemsData) {
      const product = products.find(p => p.id === item.product_id);
      await conn.query("UPDATE products SET stock=? WHERE id=?", [product.stock - item.quantity, product.id]);
    }

    await conn.commit();
    res.json({ message: "Order placed!", order_id: orderId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// Update order status
app.put("/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ error: "Status is required" });

  try {
    // Normalize status string before saving
    let normalizedStatus = status.trim();
    // Optional: enforce proper case
    if (/cancelled/i.test(normalizedStatus)) normalizedStatus = "Cancelled/Returned";
    if (/delivered/i.test(normalizedStatus)) normalizedStatus = "Delivered";
    if (/pending/i.test(normalizedStatus)) normalizedStatus = "Pending";

    // Update order
    await db.query("UPDATE orders SET status=? WHERE id=?", [normalizedStatus, id]);

    // Fetch updated order
    const [results] = await db.query("SELECT id, user_name, status FROM orders WHERE id=?", [id]);
    if (results.length > 0) await orderStatusNotification(results[0]);

    res.json({ message: "Status updated!" });
  } catch (err) {
    console.error("Error updating order status:", err);
    res.status(500).json({ error: err.message });
  }
});

// Sales by category
app.get("/sales-by-category", async (req, res) => {
  try {
    const [results] = await db.query(`
      SELECT p.category, SUM(oi.total) AS total_sales
      FROM order_items oi
      JOIN products p ON oi.product_id = p.id
      GROUP BY p.category
      ORDER BY total_sales DESC
    `);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Notifications
app.get("/notifications", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM notifications ORDER BY id DESC LIMIT 20");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/notifications/:id/read", async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("UPDATE notifications SET isRead=1 WHERE id=?", [id]);
    res.json({ message: "Notification marked as read!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/notifications/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM notifications WHERE id=?", [id]);
    res.json({ message: "Notification deleted!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// Root route
app.get("/", (req, res) => {
  res.send("Welcome to Camarcl Flowershop!");
});


// -------------------- START SERVER --------------------
httpServer.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
