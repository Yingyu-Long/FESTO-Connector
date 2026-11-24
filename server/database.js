import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

const database = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Prevent idle PostgreSQL disconnects / container restarts from crashing Node.js.
database.on("error", (error) => {
  console.error("PostgreSQL pool idle client error:", error?.message || error);
});

export function query(text, values) {
  return database.query(text, values);
}
