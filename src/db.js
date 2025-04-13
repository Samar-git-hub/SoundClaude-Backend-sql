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

let dbConnection;

async function connectToDatabase() {
  try {
    await client.connect();
    
    // Confirming connection
    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");
    
    dbConnection = client.db("soundclaude_db");
    
    return dbConnection;
  } catch (error) {
    console.error("Error connecting to database:", error);
    throw error;
  }
}

// Closing the connection 
async function closeConnection() {
    try {
      await client.close();
      console.log("Database connection closed");
    } catch (error) {
      console.error("Error closing database connection:", error);
    }
}

export { connectToDatabase, closeConnection };
