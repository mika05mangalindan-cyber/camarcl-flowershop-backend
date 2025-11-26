import express from "express";
import mysql from "mysql2/promise";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import { createServer } from "http";
import { Server } from "socket.io";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { v2 as cloudinary } from "cloudinary";

dotenv.config();

// Cloudinary configuration
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Express setup
const app = express();
const PORT = process.env.PORT || 5500;

// Middleware
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://camarcl-flowershop-frontend.vercel.app",
    process.env.FRONTEND_URL
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// // Database connection
// const db = mysql.createPool({
//   host: process.env.DB_HOST,
//   user: process.env.DB_USER,
//   password: process.env.DB_PASSWORD,
//   database: process.env.DB_NAME,
//   port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0
// });

// // Test DB connection
// (async () => {
//   try {
//     const conn = await db.getConnection();
//     console.log("Connected to MySQL database!");
//     conn.release();
//   } catch (err) {
//     console.error("MySQL connection error:", err);
//     process.exit(1);
//   }
// })();

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Test the DB connection
const testConnection = async () => {
  try {
    const conn = await db.getConnection();
    console.log("Connected to MySQL database!");
    conn.release();
  } catch (err) {
    console.error("MySQL connection error:", err);
    setTimeout(testConnection, 5000);
  }
};

testConnection();


process.on("unhandledRejection", (err) => {
  console.error("Unhandled promise rejection:", err);
});


// Socket.IO setup
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:5173",
      "https://camarcl-flowershop-frontend.vercel.app",
      process.env.FRONTEND_URL
    ]
  }
});

io.on("connection", socket => {
  console.log("New client connected:", socket.id);
  socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
});

// Multer + Cloudinary Storage
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "products",
    allowed_formats: ["jpg","jpeg","png","webp","gif","svg","heic","avif","bmp"],
    transformation: [{ width: 500, height: 500, crop: "limit" }]
  }
});
const upload = multer({ storage });

// Helpers
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

const checkLowStock = async (id, stock, name) => {
  const numericStock = Number(stock);
  if (numericStock < 20) {
    await sendNotification(
      "low on supplies",
      id, 
      `Product '${name}' is low on supplies!`
    );
  }
};

const orderStatusNotification = async (order) => {
  if (!order.status) return;

  const status = order.status.toLowerCase();
  let message = "";

  if (status.includes("delivered")) message = `Order #${order.id} for ${order.user_name} has been delivered!`;
  else if (status.includes("cancelled") || status.includes("returned")) message = `Order #${order.id} for ${order.user_name} has been cancelled/returned!`;

  if (message) await sendNotification("status", order.id, message);
};


// ROUTES

// PRODUCTS ----------------

app.post("/products", upload.single("image"), async (req, res) => {
  try {
    let { name, price, stock, category, description } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Product image is required" });
    }

    stock = Number(stock);
    price = Number(price);

     const image_url = req.file.path || req.file.secure_url;


    const [result] = await db.query(
      `INSERT INTO products (name, price, stock, category, description, image_url, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [name, price, stock, category, description, image_url]
    );

   if (stock < 20) await checkLowStock(result.insertId, stock, name);


    res.json({
      message: "Product added successfully",
      supply_alert: supplyAlert,
      product: {
        id: result.insertId,
        name,
        price,
        stock,
        category,
        description,
        image_url
      }
    });
  } catch (err) {
    console.error("Add product error:", err);
    res.status(500).json({ error: "Failed to add product" });
  }
});

app.get("/products", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM products ORDER BY created_at DESC");

   
    const products = rows.map(p => ({
      ...p,
      supply_alert: p.stock < 20 ? "LOW ON SUPPLIES" : "OK"
    }));

    res.json(products);
  } catch (err) {
    console.error("Fetch products error:", err);
    res.status(500).json({ error: "Failed to load products" });
  }
});

app.get("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query("SELECT * FROM products WHERE id = ?", [id]);

    if (!rows.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    const product = rows[0];

    res.json({
      ...product,
      supply_alert: product.stock < 20 ? "LOW ON SUPPLIES" : "OK"
    });

  } catch (err) {
    console.error("Fetch product error:", err);
    res.status(500).json({ error: "Failed to load product" });
  }
});

app.put("/products/:id", upload.single("image"), async (req, res) => {
  try {
    const { id } = req.params;
    let { name, price, stock, category, description, existingImageUrl } = req.body;

    stock = Number(stock);
    price = Number(price);

     const [prevRows] = await db.query("SELECT stock, name FROM products WHERE id = ?", [id]);
    if (!prevRows.length) return res.status(404).json({ error: "Product not found" });

    const prevStock = Number(prevRows[0].stock);
    const prevName = prevRows[0].name;

    console.log("REQ FILE:", req.file);

    let image_url = existingImageUrl;

     if (req.file) {
      image_url = req.file.path || req.file.secure_url;
    }


    await db.query(
      `UPDATE products SET name=?, price=?, stock=?, category=?, description=?, image_url=? WHERE id=?`,
      [name, price, stock, category, description, image_url, id]
    );


     const productName = name || prevName;

    if (stock < 20 && prevStock >= 20) {
      await checkLowStock(id, stock, productName);
    }

    const supplyAlert = Number(stock) < 20 ? "LOW ON SUPPLIES" : "OK";

    res.json({
      message: "Product updated successfully",
      supply_alert: supplyAlert,
      product: { id, name, price, stock, category, description, image_url }
    });

  } catch (err) {
    console.error("Update product error:", err);
    res.status(500).json({ error: "Failed to update product" });
  }
});

app.delete("/products/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await db.query("SELECT image_url FROM products WHERE id = ?", [id]);

    if (!rows.length) {
      return res.status(404).json({ error: "Product not found" });
    }

    const imageUrl = rows[0].image_url;

    if (imageUrl) {
      const urlParts = imageUrl.split("/");  
      const fileWithExt = urlParts[urlParts.length - 1];  
      const fileName = fileWithExt.split(".")[0];          
      const publicId = `products/${fileName}`;        

      await cloudinary.uploader.destroy(publicId);
        }

    await db.query("DELETE FROM products WHERE id = ?", [id]);

    res.json({ message: "Product deleted successfully" });
  } catch (err) {
    console.error("Delete product error:", err);
    res.status(500).json({ error: "Failed to delete product" });
  }
});


// USERS ----------------
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
    const [result] = await db.query(
      "INSERT INTO users (name, email, contact_number, role, password) VALUES (?, ?, ?, ?, ?)",
      [name, email, contact_number || null, role, password]
    );
    res.json({ message: "User created!", user_id: result.insertId });
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

// ---------------- ORDERS ----------------
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
    res.status(500).json({ error: err.message });
  }
});

app.post("/orders", async (req, res) => {
  const { user_name, payment_mode, items } = req.body;
  if (!user_name || !payment_mode || !items?.length) return res.status(400).json({ error: "Missing required fields or items" });

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

    // Update stock
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

app.put("/orders/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: "Status is required" });

  try {
    let normalizedStatus = status.trim();
    if (/cancelled/i.test(normalizedStatus)) normalizedStatus = "Cancelled/Returned";
    if (/delivered/i.test(normalizedStatus)) normalizedStatus = "Delivered";
    if (/pending/i.test(normalizedStatus)) normalizedStatus = "Pending";

    await db.query("UPDATE orders SET status=? WHERE id=?", [normalizedStatus, id]);
    const [results] = await db.query("SELECT id, user_name, status FROM orders WHERE id=?", [id]);
    if (results.length > 0) await orderStatusNotification(results[0]);

    res.json({ message: "Status updated!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- SALES BY CATEGORY ----------------
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

// ---------------- NOTIFICATIONS ----------------
app.get("/notifications", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM notifications ORDER BY id DESC LIMIT 20");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/notifications/:id/read", async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("UPDATE notifications SET isRead=1 WHERE id=?", [id]);
    res.json({ message: "Notification marked as read!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/notifications/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await db.query("DELETE FROM notifications WHERE id=?", [id]);
    res.json({ message: "Notification deleted!" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Root
app.get("/", (req, res) => {
  res.send("Welcome to Camarcl Flowershop Backend!");
});

// Start server
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));
