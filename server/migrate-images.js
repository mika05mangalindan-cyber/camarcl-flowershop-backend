import fs from "fs";
import path from "path";
import mysql from "mysql2/promise";
import { v2 as cloudinary } from "cloudinary";
import dotenv from "dotenv";
import { fileURLToPath } from "url";

dotenv.config();

// ES module __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Database config
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 3306,
  waitForConnections: true,
  connectionLimit: 10,
});

// Folder where images are
const uploadsFolder = path.join(__dirname, "server/uploads"); // since migrate-images.js is inside server/

async function main() {
  try {
    const files = fs.readdirSync(uploadsFolder);
    console.log(`Found ${files.length} files in uploads folder.`);

    for (const file of files) {
      const localPath = path.join(uploadsFolder, file);

      // Upload to Cloudinary
      const result = await cloudinary.uploader.upload(localPath, {
        folder: "products",
        resource_type: "image",
      });

      console.log(`Uploaded: ${file} → ${result.secure_url}`);

      // Update DB for matching file
      const [updateResult] = await db.query(
        "UPDATE products SET image_url=? WHERE image_url LIKE ?",
        [result.secure_url, `%${file}%`]
      );

      if (updateResult.affectedRows > 0) {
        console.log(`DB updated for: ${file}`);
      } else {
        console.log(`No DB entry found for: ${file}`);
      }
    }

    console.log("All images processed!");
    process.exit(0);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();

