import dotenv from 'dotenv';
import { MongoClient, ServerApiVersion } from 'mongodb';

dotenv.config();

const uri = `mongodb+srv://SoundClaude_Admin:${process.env.MONGO_PASSWORD}@soundclaude.lffsfo8.mongodb.net/?retryWrites=true&w=majority&appName=SoundClaude`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

let db;

async function connectToDatabase() {
  if (db) return db;
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");
    db = client.db("soundclaude_db");
    return db;
  } catch (error) {
    console.error("Error connecting to database:", error);
    throw error;
  }
}

export { connectToDatabase };