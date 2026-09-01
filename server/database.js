import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

export const database = new Pool({
  //create a pool of connection
  connectionString: process.env.DATABASE_URL,
});

export function query(text, values) {
  return database.query(text, values);
}
