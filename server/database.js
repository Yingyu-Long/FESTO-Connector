import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

//create a pool of connection
export const database = new Pool({
  connectionString: process.env.DATABASE_URL,
});

//send the SQL query to the database
export function query(text, values) {
  return database.query(text, values);
}
